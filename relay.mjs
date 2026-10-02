#!/usr/bin/env node
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dispatch } from './mcp.mjs';
import * as local from './controller.mjs';
import { EventStore, readPrivateJson } from './event-store.mjs';
import { Events, eventDefinitions } from './events.mjs';
import { EventError, createWebhookTransport, equal, plain } from './webhook.mjs';
import { oauthSubject, validateOAuth } from './oauth.mjs';

export const VERSION = '2026-07-28';
export function validateConfig(config) {
  if (!plain(config) || !Array.isArray(config.principals) || !config.principals.length || config.principals.length > 32 || !Array.isArray(config.callbackOrigins) || !config.callbackOrigins.length || config.callbackOrigins.length > 16) throw new Error('Invalid relay configuration');
  for (const origin of [config.publicOrigin, ...config.callbackOrigins]) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Configure exact HTTPS origins');
  }
  const ids = new Set(), tokens = new Set();
  if (config.oauth) validateOAuth(config.oauth, config.publicOrigin);
  for (const p of config.principals) {
    const identity = config.oauth ? p.subject : p.token;
    if (!plain(p) || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.id) || (config.oauth ? typeof identity !== 'string' || !identity || identity.length > 256 || p.token !== undefined : typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(identity)) || !Array.isArray(p.sessionIds) || p.sessionIds.length > 256 || p.sessionIds.some(s => typeof s !== 'string' || !s || s.length > 256) || ids.has(p.id) || tokens.has(identity)) throw new Error('Invalid principal configuration');
    ids.add(p.id); tokens.add(identity);
  }
  return config;
}
const hash = v => createHash('sha256').update(v).digest('hex');
const failure = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
function decodedHeader(value) {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('=?base64?') && value.endsWith('?=')) {
    const encoded = value.slice(9, -2), bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return undefined;
    return bytes.toString('utf8');
  }
  return value;
}
export function createRelay({ config: configSource, stateDir, transport, controller = local, now = Date.now, report = () => {} }) {
  const config = () => validateConfig(configSource());
  const initial = config();
  const authorize = (owner, session) => {
    // Invalid/transient config fails closed WITHOUT discarding stored subscriptions or pending work.
    return config().principals.some(p => p.id === owner && p.sessionIds.includes(session));
  };
  const store = new EventStore(stateDir);
  const events = new Events({ store, origins: initial.callbackOrigins, authorize, now, report,
    transport: transport || createWebhookTransport(initial.callbackOrigins) });
  let stopping = false, worker;
  const scoped = owner => {
    const check = ids => { if (!ids.every(id => authorize(owner, id))) throw new EventError(-32012, 'Session access denied'); };
    const action = fn => async args => { check([args.session_id]); const result = await fn(args); check([args.session_id]); return result; };
    return {
      omp_list_sessions: async () => ({ sessions: (await controller.listSessions()).sessions.filter(s => authorize(owner, s.id)) }),
      omp_read_session: action(a => controller.readSession(a.session_id)),
      omp_send_prompt: action(controller.sendPrompt), omp_interrupt: action(controller.interruptSession), omp_rename_session: action(controller.renameSession),
      omp_wait: async args => { check(args.session_ids); const result = await controller.waitSessions(args); check(args.session_ids); return result; },
    };
  };
  const server = createServer(async (req, res) => {
    const send = (status, body) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    let message;
    try {
      const settings = config();
      if (req.headers.host !== new URL(settings.publicOrigin).host || (req.headers.origin !== undefined && req.headers.origin !== settings.publicOrigin)) { send(403); return; }
      if (settings.oauth && req.url === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        send(200, { resource: settings.publicOrigin + '/mcp', authorization_servers: [settings.oauth.issuer], scopes_supported: settings.oauth.scopes, bearer_methods_supported: ['header'] }); return;
      }
      if (req.url !== '/mcp') { send(404); return; }
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && /^Bearer [a-zA-Z0-9_.-]{1,8192}$/.test(auth) ? auth.slice(7) : '';
      const subject = settings.oauth ? oauthSubject(token, settings.oauth, now()) : null;
      const principal = settings.principals.find(p => settings.oauth ? subject !== null && p.subject === subject : equal(hash(p.token), hash(token)));
      if (!principal) { res.setHeader('WWW-Authenticate', settings.oauth ? `Bearer resource_metadata="${settings.publicOrigin}/.well-known/oauth-protected-resource", scope="${settings.oauth.scopes.join(' ')}"` : 'Bearer'); send(401); return; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(415); return; }
      if (!['application/json', 'text/event-stream'].every(type => (req.headers.accept || '').includes(type))) { send(406); return; }
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024) { send(413); req.resume(); return; } chunks.push(chunk); }
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, failure(null, -32700, 'Parse error')); return; }
      if (!plain(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !Object.hasOwn(message, 'id') || (typeof message.id !== 'string' && typeof message.id !== 'number') || (typeof message.id === 'number' && !Number.isFinite(message.id)) || !plain(message.params)) { send(400, failure(null, -32600, 'Invalid request')); return; }
      const meta = message.params._meta;
      const version = meta?.['io.modelcontextprotocol/protocolVersion'];
      if (typeof version !== 'string' || req.headers['mcp-protocol-version'] !== version || req.headers['mcp-method'] !== message.method || (message.method === 'tools/call' && decodedHeader(req.headers['mcp-name']) !== message.params.name)) { send(400, failure(message.id, -32020, 'Missing or mismatched MCP headers')); return; }
      if (version !== VERSION) { send(400, failure(message.id, -32022, 'Unsupported protocol version', { supported: [VERSION], requested: version })); return; }
      if (!plain(meta['io.modelcontextprotocol/clientCapabilities']) || !plain(meta['io.modelcontextprotocol/clientInfo']) || typeof meta['io.modelcontextprotocol/clientInfo'].name !== 'string' || typeof meta['io.modelcontextprotocol/clientInfo'].version !== 'string') { send(400, failure(message.id, -32602, 'Missing client metadata')); return; }
      const { _meta, ...params } = message.params;
      let result;
      if (message.method === 'server/discover') result = { supportedVersions: [VERSION], capabilities: { tools: {}, events: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'omp-wand-events', version: '1.0.0' } }, ttlMs: 0, cacheScope: 'private' };
      else if (message.method === 'events/list') result = { events: principal.sessionIds.length ? eventDefinitions : [] };
      else if (message.method === 'events/subscribe') result = await events.subscribe(principal.id, params);
      else if (message.method === 'events/unsubscribe') result = await events.unsubscribe(principal.id, params);
      else if (['tools/list', 'tools/call', 'ping'].includes(message.method)) {
        const reply = await dispatch({ ...message, params }, scoped(principal.id));
        if (reply.error) { send(reply.error.code === -32601 ? 404 : 200, reply); return; }
        result = reply.result;
        if (message.method === 'tools/list') {
          Object.assign(result, { ttlMs: 0, cacheScope: 'private' });
          if (settings.oauth) result.tools = result.tools.map(tool => ({ ...tool, securitySchemes: [{ type: 'oauth2', scopes: settings.oauth.scopes }] }));
        }
      } else { send(404, failure(message.id, -32601, 'Method not found')); return; }
      send(200, { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', ...result } });
    } catch (error) {
      send(error instanceof EventError ? 200 : 500, failure(message?.id, error instanceof EventError ? error.code : -32603,
        error instanceof EventError ? error.message : 'Internal relay error', error instanceof EventError ? error.data : undefined));
      if (!(error instanceof EventError)) report({ type: 'relay_error' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 64;
  const tick = async () => {
    if (stopping) return;
    try { for (const event of await controller.collectEvents()) { if (stopping) break; await events.ingest(event); } if (!stopping) await events.drain(); }
    catch { report({ type: 'collector_error' }); }
  };
  let timer;
  return { server, events, store, tick,
    startWorker() {
      if (timer) return;
      timer = setInterval(() => { if (!worker && !stopping) { worker = tick().finally(() => { worker = undefined; }); } }, 1000);
    },
    async close() {
      stopping = true; clearInterval(timer);
      if (worker) await worker;
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await events.chain; store.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = process.env.OMP_WAND_RELAY_CONFIG, stateDir = process.env.OMP_WAND_RELAY_STATE;
    if (!path || !stateDir) throw new Error('Set OMP_WAND_RELAY_CONFIG and OMP_WAND_RELAY_STATE; see docs/events.md');
    const port = Number(process.env.OMP_WAND_RELAY_PORT || 8787);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535');
    const relay = createRelay({ config: () => readPrivateJson(path), stateDir, report: entry => console.error(JSON.stringify(entry)) });
    relay.server.once('error', async () => { await relay.close(); console.error('Relay listener failed'); process.exitCode = 1; });
    relay.server.listen(port, '127.0.0.1', () => { relay.startWorker(); console.error(`Wand relay listening on loopback port ${port}; HTTPS proxy required for ChatGPT.`); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => relay.close().then(() => { process.exitCode = 0; }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
