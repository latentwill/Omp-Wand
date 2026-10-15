import { chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { remoteDir, messageText, transcriptEntry, MAX_FRAME, ensurePrivateDirSync, assertPrivateSocketSync } from './shared.mjs';
import { createDialogBridge } from './dialogs.mjs';

const MODES = ['prompt', 'followUp', 'steer'];
const validName = value => typeof value === 'string' && value.trim().length > 0 && [...value].length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

// Runs inside the normal OMP TUI. No key injection and no second agent process.
export function attachRemote(pi) {
  const instanceId = randomUUID();
  let ctx, server, socketPath, enabled = true, revision = 0, lastActivity = new Date().toISOString();
  let liveMessage, lastError, submittedAt = 0;
  const activeTools = new Map();
  const clients = new Set();
  const touch = () => { revision++; lastActivity = new Date().toISOString(); };
  const dialogs = createDialogBridge({ onChange: touch });
  const statusLine = () => ctx?.ui.setStatus('Omp-Wand', enabled ? 'Remote connected' : 'Remote paused');
  const track = context => { ctx = context; if (server) dialogs.attach(context?.ui); };

  // A sent prompt counts as work until agent_start arrives, so a waiter never sees a false "idle".
  const pendingSubmit = () => submittedAt && Date.now() - submittedAt < 5000;
  const status = open => open.length ? 'waiting_for_input' : (!ctx.isIdle() || ctx.hasPendingMessages() || pendingSubmit()) ? 'working' : 'idle';

  const snapshot = (read, limit = 12) => {
    const open = dialogs.list();
    const result = {
      id: ctx.sessionManager.getSessionId(), instance_id: instanceId, pid: process.pid, project: ctx.cwd,
      name: pi.getSessionName?.() || null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      status: status(open), control: enabled ? 'connected' : 'paused', queued: ctx.hasPendingMessages(),
      local_draft: Boolean(ctx.ui.getEditorText?.()?.trim()),
      tools: [...activeTools.values()], dialogs: open, last_activity: lastActivity, revision,
    };
    if (read) {
      const messages = ctx.sessionManager.getBranch().filter(e => e.type === 'message').map(e => e.message);
      result.messages = messages.slice(-limit).map(m => transcriptEntry(m));
      // Only the current turn: a reply from before the latest prompt would read as an answer to it.
      const turn = messages.slice(messages.findLastIndex(m => m.role === 'user') + 1);
      const lastAssistant = turn.findLast(m => m.role === 'assistant' && messageText(m).trim());
      result.last_assistant = lastAssistant ? messageText(lastAssistant, 8000) : null;
      result.live = liveMessage ? { role: liveMessage.role, text: messageText(liveMessage, 8000) } : null;
      result.last_error = lastError || null;
      result.session_file = ctx.sessionManager.getSessionFile() || null;
    }
    return result;
  };

  const ops = {
    status: () => snapshot(false),
    read: req => snapshot(true, Number.isInteger(req.limit) ? Math.min(Math.max(req.limit, 1), 100) : 12),
    send: req => {
      const text = req.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('text must contain 1–32000 characters');
      const mode = req.mode ?? 'prompt';
      if (!MODES.includes(mode)) throw new Error('mode must be prompt, followUp, or steer');
      if (/^\s*[/!]/.test(text)) throw new Error('Remote sends plain prompts only; slash and ! commands need the terminal');
      if (ctx.ui.getEditorText?.()?.trim()) throw new Error('The terminal has an unsent local draft. Ask the user to submit or clear it.');
      if (dialogs.list().length) throw new Error('A dialog is open. Answer it with omp_answer first.');
      const idle = ctx.isIdle() && !ctx.hasPendingMessages() && !pendingSubmit();
      if (mode === 'prompt' && !idle) throw new Error('Session is busy. Use mode followUp to queue, or steer to redirect the current run.');
      pi.sendUserMessage(text, idle ? undefined : { deliverAs: mode });
      submittedAt = Date.now(); touch();
      try { ctx.ui.notify(`Omp-Wand: ${mode === 'followUp' ? 'queued a prompt' : mode === 'steer' ? 'sent steering' : 'sent a prompt'}`, 'info'); } catch {}
      return { accepted: true, mode: idle ? 'prompt' : mode };
    },
    answer: req => {
      const result = dialogs.answer(req.dialog_id, req.answer);
      try { ctx.ui.notify(`Omp-Wand: answered ${result.kind} dialog`, 'info'); } catch {}
      return result;
    },
    interrupt: () => { ctx.abort(); touch(); return { accepted: true }; },
    rename: async req => {
      if (!validName(req.name)) throw new Error('name must be 1–80 characters with no control characters');
      await pi.setSessionName(req.name); touch();
      return { accepted: true, name: req.name };
    },
  };
  const READ_ONLY = new Set(['status', 'read']);

  const handle = async req => {
    if (!req || typeof req !== 'object' || Array.isArray(req) || !Object.hasOwn(ops, req.op)) throw new Error('Unknown operation');
    if (req.session_id !== undefined && req.session_id !== ctx.sessionManager.getSessionId()) throw new Error('Session changed; list sessions again');
    if (READ_ONLY.has(req.op)) return ops[req.op](req);
    if (!enabled) throw new Error('Remote control is paused in this terminal (/remote on resumes it).');
    if (typeof req.session_id !== 'string') throw new Error('session_id is required');
    return ops[req.op](req);
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
      socket.on('close', () => clearTimeout(deadline));
      const decoder = new StringDecoder('utf8'); let data = ''; let bytes = 0; let answered = false;
      socket.on('data', chunk => {
        if (answered) return;
        bytes += chunk.length;
        if (bytes > MAX_FRAME) { socket.destroy(); return; }
        data += decoder.write(chunk);
        const newline = data.indexOf('\n');
        if (newline < 0) return;
        answered = true;
        let req;
        try { req = JSON.parse(data.slice(0, newline)); } catch { socket.end(JSON.stringify({ error: 'Invalid JSON request' }) + '\n'); return; }
        Promise.resolve().then(() => handle(req))
          .then(result => socket.end(JSON.stringify({ result }) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600); assertPrivateSocketSync(socketPath);
    server.on('error', error => { lastError = error.message; touch(); });
    server.unref();
    dialogs.attach(ctx.ui);
    touch(); statusLine();
  });
  pi.on('session_shutdown', stop);
  for (const event of ['session_switch', 'session_fork', 'session_tree']) pi.on(event, (_e, context) => {
    track(context); liveMessage = undefined; activeTools.clear(); lastError = undefined; touch();
  });
  pi.on('agent_start', (_e, context) => { track(context); submittedAt = 0; liveMessage = undefined; lastError = undefined; touch(); });
  pi.on('agent_end', (_e, context) => { track(context); liveMessage = undefined; activeTools.clear(); touch(); });
  pi.on('message_update', (event, context) => { track(context); liveMessage = event.message; });
  pi.on('message_end', (event, context) => {
    track(context); liveMessage = undefined;
    if (event.message?.errorMessage) lastError = event.message.errorMessage;
    touch();
  });
  pi.on('tool_execution_start', (event, context) => { track(context); activeTools.set(event.toolCallId, event.toolName); touch(); });
  pi.on('tool_execution_end', (event, context) => {
    track(context); activeTools.delete(event.toolCallId);
    if (event.isError) lastError = messageText(event.result, 2000);
    touch();
  });
  pi.registerCommand('remote', {
    description: 'Omp-Wand: /remote on, off, or status',
    handler: async (args, context) => {
      track(context);
      const arg = args.trim();
      if (arg === 'off') enabled = false;
      else if (arg === 'on') enabled = true;
      else if (arg && arg !== 'status') { ctx.ui.notify('Usage: /remote on | off | status', 'warning'); return; }
      touch(); statusLine(); ctx.ui.notify(`Omp-Wand ${enabled ? 'on' : 'paused'} · ${ctx.sessionManager.getSessionId()}`, 'info');
    },
  });
}
