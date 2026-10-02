import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, VERSION } from '../relay.mjs';
import { attachRemote } from '../session.mjs';
import { request } from '../shared.mjs';
import { collectEvents } from '../controller.mjs';
import { dispatch } from '../mcp.mjs';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';

const alice = 'a'.repeat(32), bob = 'b'.repeat(32), secret = 'whsec_' + Buffer.alloc(32, 42).toString('base64');
const metadata = { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientInfo': { name: 'offline-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const parameters = { name: 'omp.job.completed', arguments: { session_id: 'one' }, delivery: { mode: 'webhook', url: 'https://callback.example/watch', secret } };
async function fixture(t, controller, settingsOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-relay-')); const deliveries = []; let challengeValid = true;
  const settings = { publicOrigin: 'https://wand.example', callbackOrigins: ['https://callback.example'], principals: [{ id: 'alice', token: alice, sessionIds: ['one'] }, { id: 'bob', token: bob, sessionIds: ['two'] }], ...settingsOverrides };
  const relay = createRelay({ config: () => settings, stateDir: dir, controller,
    transport: async (_url, body, headers) => {
      const sig = createHmac('sha256', Buffer.alloc(32, 42)).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
      assert.equal(headers['webhook-signature'], 'v1,' + sig);
      const event = JSON.parse(body); deliveries.push(event);
      return { status: 200, text: JSON.stringify({ challenge: challengeValid ? event.challenge : 'wrong' }) };
    } });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await relay.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (method, params = {}, options = {}) => {
    const message = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: metadata }, ...options.message };
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${relay.server.address().port}${options.path || '/mcp'}`, { method: options.verb || 'POST',
      headers: { Host: 'wand.example', Authorization: 'Bearer ' + (options.token || alice), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': VERSION, 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), ...options.headers },
      }, res => { let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })); });
      req.on('error', reject); req.end(options.verb === 'GET' ? undefined : options.body ?? JSON.stringify(message));
    });
    return result;
  };
  return { relay, call, settings, deliveries, badChallenge() { challengeValid = false; } };
}
const mockController = {
  listSessions: async () => ({ sessions: [{ id: 'one' }, { id: 'two' }] }),
  readSession: async id => ({ id, private: 'only for owner' }),
  sendPrompt: async () => ({ accepted: true }), interruptSession: async () => ({}), renameSession: async () => ({}),
  waitSessions: async args => ({ sessions: args.session_ids.map(id => ({ id })) }), collectEvents: async () => [],
};
test('HTTP relay authenticates every method, checks host/origin/metadata, and speaks stateless MCP 2.0', async t => {
  const f = await fixture(t, mockController);
  assert.equal((await f.call('server/discover', {}, { token: 'wrong' })).status, 401);
  assert.equal((await f.call('events/list', {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('events/list', {}, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('events/list', {}, { verb: 'GET' })).status, 405);
  assert.equal((await f.call('events/list', {}, { headers: { 'Mcp-Method': 'tools/call' } })).body.error.code, -32020);
  assert.equal((await f.call('events/list', {}, { headers: { 'MCP-Protocol-Version': '1900' }, message: { params: { _meta: { ...metadata, 'io.modelcontextprotocol/protocolVersion': '1900' } } } })).body.error.code, -32022);
  assert.equal((await f.call('events/list', {}, { body: '{' })).body.error.code, -32700);
  assert.equal((await f.call('events/list', {}, { body: '{"jsonrpc":"2.0","id":1e999,"method":"events/list","params":{}}' })).body.error.code, -32600);
  assert.equal((await f.call('events/list', {}, { body: 'x'.repeat(65537) })).status, 413);
  assert.equal((await f.call('unknown')).status, 404);
  const discovery = (await f.call('server/discover')).body.result; assert.equal(discovery.resultType, 'complete'); assert.deepEqual(discovery.capabilities, { tools: {}, events: {} });
  assert.equal((await f.call('events/list')).body.result.events.length, 3);
  assert.equal((await f.call('tools/list')).body.result.tools.length, 6);
  assert.equal((await f.call('tools/list')).body.result.resultType, 'complete');
  assert.equal((await f.call('tools/call', { name: 'omp_list_sessions', arguments: {} }, { headers: { 'Mcp-Name': '=?base64?' + Buffer.from('omp_list_sessions').toString('base64') + '?=' } })).status, 200);
  // The existing stdio dispatcher keeps its old protocol and advertises tools alone.
  const old = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(old.result.protocolVersion, '2025-06-18'); assert.deepEqual(old.result.capabilities, { tools: {} });
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 1, method: 'events/list' })).error.code, -32601);
});
test('OAuth resource metadata and RS256 access tokens enforce issuer, audience, scope, time and subject mapping', async t => {
  // Ephemeral offline provider fixture; no keys or credentials are stored or configured outside this test.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oauth = { issuer: 'https://identity.example', audience: 'https://wand.example/mcp', scopes: ['wand'], keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }] };
  const f = await fixture(t, mockController, { oauth, principals: [{ id: 'alice', subject: 'provider-alice', sessionIds: ['one'] }] });
  const seconds = Math.floor(Date.now() / 1000);
  const token = (extra = {}, head = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test', typ: 'at+jwt', ...head })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: oauth.issuer, aud: oauth.audience, sub: 'provider-alice', scope: 'wand', iat: seconds, exp: seconds + 600, ...extra })).toString('base64url');
    return header + '.' + claims + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + claims), privateKey).toString('base64url');
  };
  const meta = await f.call('ignored', {}, { verb: 'GET', path: '/.well-known/oauth-protected-resource', token: 'invalid' });
  assert.equal(meta.status, 200); assert.equal(meta.body.resource, oauth.audience); assert.deepEqual(meta.body.authorization_servers, [oauth.issuer]);
  for (const candidate of [alice, token({ iss: 'https://evil.example' }), token({ aud: 'https://other.example' }), token({ scope: 'other' }), token({ sub: 'unmapped' }), token({ exp: seconds - 1 }), token({ nbf: seconds + 600 }), token({ iat: seconds - 4000 }), token({}, { alg: 'none' }), token({}, { typ: 'JWT' }), token({}, { kid: 'untrusted' }), token().slice(0, -20)]) assert.equal((await f.call('events/list', {}, { token: candidate })).status, 401);
  const tools = await f.call('tools/list', {}, { token: token() }); assert.equal(tools.status, 200); assert.deepEqual(tools.body.result.tools[0].securitySchemes, [{ type: 'oauth2', scopes: ['wand'] }]);
  assert.ok((await f.call('events/subscribe', parameters, { token: token() })).body.result.id);
  // Malformed transient config denies work but preserves pending subscription state.
  f.settings.oauth.audience = 'invalid'; await f.relay.tick(); assert.equal(f.relay.store.state.subscriptions.length, 1);
  f.settings.oauth.audience = oauth.audience = 'https://wand.example/mcp';
  f.settings.principals[0].sessionIds = []; await f.relay.tick(); assert.equal(f.relay.store.state.subscriptions.length, 0);
});
test('account allowlists isolate tools, subscriptions and cleanup; policy changes revoke delivery', async t => {
  const f = await fixture(t, mockController);
  const own = await f.call('tools/call', { name: 'omp_list_sessions', arguments: {} }); assert.deepEqual(JSON.parse(own.body.result.content[0].text).sessions, [{ id: 'one' }]);
  for (const name of ['omp_read_session', 'omp_send_prompt', 'omp_interrupt', 'omp_rename_session']) {
    const args = { session_id: 'two', ...(name === 'omp_read_session' ? {} : { instance_id: 'instance', request_id: 'request_123' }), ...(name === 'omp_send_prompt' ? { text: 'hi' } : {}), ...(name === 'omp_rename_session' ? { name: 'new name' } : {}) };
    assert.equal((await f.call('tools/call', { name, arguments: args })).body.result.isError, true);
  }
  assert.equal((await f.call('tools/call', { name: 'omp_wait', arguments: { session_ids: ['one', 'two'] } })).body.result.isError, true);
  assert.equal((await f.call('events/subscribe', parameters, { token: bob })).body.error.code, -32012);
  assert.ok((await f.call('events/subscribe', parameters)).body.result.id);
  const stop = { ...parameters, delivery: { mode: 'webhook', url: parameters.delivery.url } };
  assert.equal((await f.call('events/unsubscribe', stop, { token: bob })).body.error.code, -32012); assert.equal(f.relay.store.state.subscriptions.length, 1);
  f.settings.principals[0].sessionIds = []; await f.relay.tick(); assert.equal(f.relay.store.state.subscriptions.length, 0);
  assert.equal((await f.call('events/list')).body.result.events.length, 0);
  f.settings.principals = []; assert.equal((await f.call('events/list')).status, 500); // Invalid config fails closed.
});
test('real TUI hook → private socket collector → relay outbox → signed mock callback, with clean shutdown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-event-hooks-')); process.env.OMP_REMOTE_DIR = dir;
  const handlers = new Map();
  let nativeSession = 'one';
  const ctx = { hasUI: true, mode: 'tui', cwd: '/private/project', isIdle: () => true, hasPendingMessages: () => false,
    ui: { setStatus() {}, getEditorText: () => '' }, sessionManager: { getSessionId: () => nativeSession, getSessionFile: () => null, getBranch: () => [] } };
  attachRemote({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} }, { eventsEnabled: true });
  const emit = (name, data = {}) => handlers.get(name)(data, ctx);
  await emit('session_start'); t.after(async () => { await emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); delete process.env.OMP_REMOTE_DIR; });
  const f = await fixture(t, { ...mockController, collectEvents });
  for (const name of ['omp.job.completed', 'omp.job.failed', 'omp.approval.needed']) assert.ok((await f.call('events/subscribe', { ...parameters, name })).body.result.id);
  await emit('agent_start'); await emit('message_update', { message: { role: 'assistant', content: 'SECRET streaming' } });
  await emit('agent_end', { messages: [], willContinue: true }); await f.relay.tick(); assert.equal(f.deliveries.filter(e => e.eventId).length, 0);
  await emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: 'SECRET transcript' }] });
  await emit('agent_end', { messages: [] }); // duplicate terminal notification
  await emit('agent_start'); await emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
  await emit('agent_start'); await emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'SECRET' }] });
  await emit('tool_approval_requested', { toolCallId: 'approval', reason: 'SECRET command', toolName: 'bash' });
  await emit('tool_approval_requested', { toolCallId: 'approval', reason: 'duplicate', toolName: 'bash' });
  for (let i = 0; i < 4; i++) await f.relay.tick();
  const delivered = f.deliveries.filter(e => e.eventId); assert.deepEqual(delivered.map(e => e.name), ['omp.job.completed', 'omp.job.failed', 'omp.approval.needed']);
  assert.ok(!JSON.stringify(delivered).includes('SECRET')); assert.ok(!JSON.stringify(delivered).includes('/private'));
  const socket = join(dir, (await readdir(dir))[0]);
  assert.equal((await request(socket, { op: 'events', session_id: 'one' })).events.length, 3);
  await emit('agent_start'); await emit('agent_end', { messages: [] });
  nativeSession = 'two'; await emit('session_switch'); // Switch before the next relay tick.
  await f.relay.tick();
  assert.equal(f.deliveries.filter(e => e.eventId).length, 4);
  assert.equal(f.deliveries.at(-1).data.session_id, 'one');
  // The source ring is bounded even while the relay is stopped.
  for (let i = 0; i < 140; i++) { await emit('agent_start'); await emit('agent_end', { messages: [] }); }
  assert.equal((await request(socket, { op: 'events', session_id: 'two' })).events.length, 128);
});
test('TUI events remain off by default', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-no-events-')); process.env.OMP_REMOTE_DIR = dir; delete process.env.OMP_WAND_EVENTS;
  const handlers = new Map(); const ctx = { hasUI: true, mode: 'tui', ui: { setStatus() {} }, sessionManager: { getSessionId: () => 'one' } };
  attachRemote({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
  await handlers.get('session_start')({}, ctx);
  t.after(async () => { await handlers.get('session_shutdown')(); await rm(dir, { recursive: true, force: true }); delete process.env.OMP_REMOTE_DIR; });
  await handlers.get('agent_start')({}, ctx); await handlers.get('agent_end')({ messages: [] }, ctx);
  assert.deepEqual(await collectEvents(), []);
});
