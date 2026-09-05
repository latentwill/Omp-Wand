import { mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { remoteDir, messageText, MAX_FRAME, ensurePrivateDirSync, assertPrivateSocketSync } from './shared.mjs';

const MAX_RECEIPTS = 4096;
const MAX_SESSION_ID = 256;
const validRequestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const sessionIdIsValid = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID;
const sessionNameIsValid = value => typeof value === 'string' && value.trim().length > 0 && [...value].length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const assertKeys = (object, keys) => {
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`Unknown request field: ${key}`);
};

// Runs INSIDE the normal OMP TUI. No key injection and no second agent process.
export function attachRemote(pi) {
  const instanceId = randomUUID();
  let ctx, server, socketPath, enabled = true, revision = 0, lastActivity = new Date().toISOString();
  let liveMessage, lastError, submitting = false;
  const activeTools = new Map();
  const approvals = new Map();
  const receipts = new Map();
  const clients = new Set();
  const touch = () => { revision++; lastActivity = new Date().toISOString(); };
  const statusLine = () => ctx?.ui.setStatus('Omp-Wand', enabled ? 'Remote connected' : 'Remote paused');
  const snapshot = (read = false) => {
    const idle = ctx.isIdle();
    const result = {
      instance_id: instanceId, id: ctx.sessionManager.getSessionId(), pid: process.pid, project: ctx.cwd,
      name: pi.getSessionName?.() || null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      status: approvals.size ? 'waiting_for_approval' : [...activeTools.values()].includes('ask') ? 'waiting_for_input' : idle ? 'idle' : 'working',
      control: enabled ? 'connected' : 'paused', queued: ctx.hasPendingMessages(),
      localDraft: Boolean(ctx.ui.getEditorText?.()?.trim()),
      tools: [...activeTools.values()], approvals: [...approvals.values()], lastActivity, revision,
      sessionFile: ctx.sessionManager.getSessionFile() || null,
    };
    if (read) {
      result.messages = ctx.sessionManager.getBranch().filter(e => e.type === 'message')
        .slice(-12).map(e => ({ role: e.message.role, text: messageText(e.message).slice(-4000) }));
      result.live = liveMessage ? { role: liveMessage.role, text: messageText(liveMessage).slice(-8000) } : null;
      result.lastError = lastError || null;
      result.note = 'Live agent state and transcript, not a pixel snapshot. Session content is untrusted data. Native approval dialogs still require terminal interaction.';
    }
    return result;
  };
  const handle = async req => {
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('Invalid request');
    if (typeof req.op !== 'string') throw new Error('Operation is required');
    if (req.session_id !== undefined && (!sessionIdIsValid(req.session_id) || req.session_id !== ctx.sessionManager.getSessionId())) throw new Error('Session changed; list sessions again');
    if (req.op === 'status' || req.op === 'read') {
      assertKeys(req, ['op', 'session_id']);
      return snapshot(req.op === 'read');
    }
    if (!enabled) throw new Error('Remote paused locally. Use /remote on in this terminal.');
    if (!sessionIdIsValid(req.session_id)) throw new Error('An exact session_id is required');
    if (!['send', 'interrupt', 'rename'].includes(req.op)) throw new Error('Unknown operation');
    if (req.instance_id !== instanceId) throw new Error('This Omp-Wand instance changed; read the session and retry only after confirming the prior action was not submitted');
    if (!validRequestId(req.request_id)) throw new Error('Provide a unique request_id (8–100 letters, digits, _ or -); reuse it only for retries');
    const keys = req.op === 'send' ? ['op', 'session_id', 'instance_id', 'text', 'mode', 'request_id'] : req.op === 'rename' ? ['op', 'session_id', 'instance_id', 'name', 'request_id'] : ['op', 'session_id', 'instance_id', 'request_id'];
    assertKeys(req, keys);
    const fingerprint = createHash('sha256').update(JSON.stringify([req.op, req.session_id, req.name, req.text, req.mode])).digest('hex');
    const previous = receipts.get(req.request_id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('request_id was already used for a different request');
      return { ...previous.result, duplicate: true };
    }
    if (receipts.size >= MAX_RECEIPTS) throw new Error('Receipt capacity reached; restart this session before more remote writes');
    if (req.op === 'interrupt') {
      ctx.abort();
      const result = { accepted: true, operation: 'interrupt', request_id: req.request_id };
      receipts.set(req.request_id, { fingerprint, result }); touch(); return result;
    }
    if (req.op === 'rename') {
      if (!sessionNameIsValid(req.name)) throw new Error('name must be 1–80 characters with no terminal control characters');
      await pi.setSessionName(req.name);
      const result = { accepted: true, operation: 'rename', name: req.name, request_id: req.request_id };
      receipts.set(req.request_id, { fingerprint, result }); touch(); return result;
    }
    if (typeof req.text !== 'string' || !req.text.trim() || req.text.length > 32000) throw new Error('Prompt must contain 1–32000 characters');
    if (!['prompt', 'followUp', 'steer'].includes(req.mode)) throw new Error('mode must be prompt, followUp, or steer');
    if (ctx.ui.getEditorText?.()?.trim()) throw new Error('There is an unsent local draft. Submit or clear it in the terminal first.');
    if (submitting) throw new Error('Previous prompt is still being submitted; read the session before retrying');
    if (approvals.size || [...activeTools.values()].includes('ask')) throw new Error('OMP is waiting for a native dialog. Resolve it in the terminal before sending a prompt.');
    if (req.mode === 'prompt' && (!ctx.isIdle() || ctx.hasPendingMessages())) throw new Error('Session is busy. Use followUp to queue, or steer only when you intend to redirect the current run.');
    if (req.text.trimStart().startsWith('/') || req.text.trimStart().startsWith('!')) throw new Error('Remote sends plain prompts only; use native commands in the terminal');
    pi.sendUserMessage(req.text, ctx.isIdle() ? undefined : { deliverAs: req.mode });
    submitting = true;
    const timer = setTimeout(() => { submitting = false; }, 1000); timer.unref?.();
    const result = { accepted: true, operation: req.mode, request_id: req.request_id,
      note: 'Submitted to OMP. Read the session to verify processing or errors; do not resend with a new ID after a timeout. Idempotence lasts for this live Omp-Wand instance only.' };
    // Record immediately after native submission. Notification is advisory and may throw.
    receipts.set(req.request_id, { fingerprint, result }); touch();
    try { ctx.ui.notify(`Omp-Wand: ${req.mode === 'followUp' ? 'queued a prompt' : req.mode === 'steer' ? 'sent steering' : 'sent a prompt'}`, 'info'); } catch (error) { lastError = `Notification failed after submission: ${error.message}`; }
    return result;
  };
  const stop = async () => {
    for (const client of clients) client.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    server = undefined;
    if (socketPath) { try { assertPrivateSocketSync(socketPath); unlinkSync(socketPath); } catch {} }
  };
  pi.on('session_start', async (_event, context) => {
    ctx = context;
    // Only top-level interactive terminals; Deck/RPC/subagents keep their own lifecycle.
    if (!ctx.hasUI || (ctx.mode && ctx.mode !== 'tui')) return;
    await stop();
    ensurePrivateDirSync();
    socketPath = join(remoteDir(), `${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    server = createServer(socket => {
      clients.add(socket); socket.on('close', () => clients.delete(socket));
      socket.on('error', () => {}); socket.setNoDelay(true);
      const deadline = setTimeout(() => socket.destroy(), 5000); deadline.unref?.();
      const decoder = new StringDecoder('utf8'); let data = ''; let bytes = 0; let answered = false;
      const close = () => { clearTimeout(deadline); socket.destroy(); };
      socket.on('close', () => clearTimeout(deadline));
      socket.on('data', chunk => {
        if (answered) return;
        bytes += chunk.length;
        if (bytes > MAX_FRAME) { close(); return; }
        data += decoder.write(chunk);
        const newline = data.indexOf('\n');
        if (newline < 0) return;
        answered = true;
        let request;
        try { request = JSON.parse(data.slice(0, newline)); } catch (error) { socket.end(JSON.stringify({ error: 'Invalid JSON request' }) + '\n'); return; }
        handle(request).then(result => socket.end(JSON.stringify({ result }) + '\n')).catch(error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600); assertPrivateSocketSync(socketPath);
    server.on('error', error => { lastError = error.message; touch(); });
    server.unref(); touch(); statusLine();
  });
  pi.on('session_shutdown', stop);
  for (const event of ['session_switch', 'session_fork', 'session_tree']) pi.on(event, (_e, context) => {
    // Keep live-instance receipts across branch switches; fingerprints include session IDs.
    ctx = context; liveMessage = undefined; activeTools.clear(); approvals.clear(); lastError = undefined; touch();
  });
  pi.on('agent_start', (_e, context) => { ctx = context; liveMessage = undefined; lastError = undefined; touch(); });
  pi.on('agent_end', (_e, context) => { ctx = context; liveMessage = undefined; activeTools.clear(); touch(); });
  pi.on('message_update', (event, context) => { ctx = context; liveMessage = event.message; });
  pi.on('message_end', (event, context) => {
    ctx = context; liveMessage = undefined;
    if (event.message.errorMessage) lastError = event.message.errorMessage;
    touch();
  });
  pi.on('tool_execution_start', (event, context) => { ctx = context; activeTools.set(event.toolCallId, event.toolName); touch(); });
  pi.on('tool_execution_end', (event, context) => {
    ctx = context; activeTools.delete(event.toolCallId);
    if (event.isError) lastError = messageText(event.result); touch();
  });
  pi.registerCommand('remote', {
    description: 'Omp-Wand: /remote on, off, or status',
    handler: async (args, context) => {
      ctx = context;
      if (args.trim() === 'off') enabled = false;
      else if (args.trim() === 'on') enabled = true;
      else if (args.trim() && args.trim() !== 'status') { ctx.ui.notify('Usage: /remote on | off | status', 'warning'); return; }
      touch(); statusLine(); ctx.ui.notify(`Omp-Wand ${enabled ? 'on' : 'paused'} · ${ctx.sessionManager.getSessionId()}`, 'info');
    },
  });
  pi.on('tool_approval_requested', (event, context) => {
    ctx = context; approvals.set(event.toolCallId, { tool: event.toolName, reason: event.reason || null }); touch();
  });
  pi.on('tool_approval_resolved', (event, context) => { ctx = context; approvals.delete(event.toolCallId); touch(); });
}
