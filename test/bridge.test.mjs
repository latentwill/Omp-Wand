import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { attachRemote } from '../session.mjs';
import { request } from '../shared.mjs';
import { listSessions, readSession, sendPrompt, waitSessions } from '../controller.mjs';
import { dispatch } from '../mcp.mjs';

let dir, socket, sessionId = 'test-session-1', instanceId, sessionName = 'Test', idle = true, draft = '', aborted = 0, sent = [], notificationFails = false, events = new Map(), commands = new Map();
const ctx = { hasUI: true, mode: 'tui', cwd: '/test/project', model: { provider: 'test', id: 'offline' },
  isIdle: () => idle, hasPendingMessages: () => false, abort: () => { aborted++; },
  ui: { setStatus() {}, notify() { if (notificationFails) throw new Error('test notification failure'); }, getEditorText: () => draft },
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null,
    getBranch: () => [{ type: 'message', message: { role: 'user', content: 'local prompt' } }] } };
const emit = (type, data = {}) => events.get(type)?.(data, ctx);
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ompw-')); process.env.OMP_REMOTE_DIR = dir;
  attachRemote({ on: (name, handler) => events.set(name, handler), registerCommand: (name, cmd) => commands.set(name, cmd),
    getSessionName: () => sessionName, setSessionName: async name => { sessionName = name; }, sendUserMessage: (text, options) => sent.push({ text, options }) });
  await emit('session_start'); socket = join(dir, (await readdir(dir))[0]); instanceId = (await request(socket, { op: 'status' })).instance_id;
});
after(async () => { await emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); });
const send = extra => request(socket, { op: 'send', session_id: sessionId, instance_id: instanceId, text: 'Hello 世界\nsecond line', mode: 'prompt', request_id: randomUUID(), ...extra });
const rename = extra => request(socket, { op: 'rename', session_id: sessionId, instance_id: instanceId, name: 'Website polish', request_id: randomUUID(), ...extra });
test('private socket and directory; structured live state', async () => {
  assert.equal((await stat(dir)).mode & 0o777, 0o700); assert.equal((await stat(socket)).mode & 0o777, 0o600);
  const state = await request(socket, { op: 'read' }); assert.equal(state.status, 'idle'); assert.equal(state.messages[0].text, 'local prompt'); assert.equal(state.instance_id, instanceId);
});
test('client decodes a Unicode response split across socket chunks', async () => {
  const splitDir = await mkdtemp(join(tmpdir(), 'ompw-split-')); const splitSocket = join(splitDir, 'reply.sock');
  const server = createServer(client => client.once('data', () => {
    const frame = Buffer.from(JSON.stringify({ result: { text: '世界' } }) + '\n'); const split = frame.indexOf(Buffer.from('界')) + 1;
    client.write(frame.subarray(0, split)); setTimeout(() => client.end(frame.subarray(split)), 5);
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(splitSocket, resolve); }); await chmod(splitSocket, 0o600);
  assert.deepEqual(await request(splitSocket, { op: 'status' }), { text: '世界' });
  await new Promise(resolve => server.close(resolve)); await rm(splitDir, { recursive: true, force: true });
});
test('busy prompts and unfinished local drafts are rejected', async () => {
  idle = false; await assert.rejects(send(), /busy/); idle = true;
  draft = 'unfinished'; await assert.rejects(send(), /unsent local draft/); draft = '';
  assert.equal(sent.length, 0);
});
test('native submission preserves Unicode, newlines and shell-looking text; retries deduplicate', async () => {
  const request_id = randomUUID(); const text = 'Hello 世界\n$(touch /tmp/never) `literal`';
  const first = await send({ request_id, text }); const again = await send({ request_id, text });
  assert.equal(first.accepted, true); assert.equal(again.duplicate, true); assert.equal(sent.length, 1); assert.equal(sent[0].text, text);
  await assert.rejects(send({ request_id, text: 'different' }), /already used/);
  await new Promise(resolve => setTimeout(resolve, 1050));
});
test('submission remains idempotent when advisory notification fails', async () => {
  notificationFails = true; const request_id = randomUUID();
  await send({ request_id, text: 'notify once' }); const again = await send({ request_id, text: 'notify once' });
  assert.equal(again.duplicate, true); notificationFails = false;
  await new Promise(resolve => setTimeout(resolve, 1050));
});
test('request receipts survive session branch switches within one instance', async () => {
  const request_id = randomUUID();
  await rename({ request_id, name: 'switch-safe' });
  sessionId = 'test-session-2'; await emit('session_switch');
  sessionId = 'test-session-1'; await emit('session_switch');
  const retry = await rename({ request_id, name: 'switch-safe' });
  assert.equal(retry.duplicate, true);
});
test('followUp uses the native queue, and paused sessions reject writes', async () => {
  idle = false; await send({ mode: 'followUp' }); assert.deepEqual(sent.at(-1).options, { deliverAs: 'followUp' }); idle = true;
  await commands.get('remote').handler('off', ctx);
  await assert.rejects(send(), /paused/); assert.equal((await request(socket, { op: 'read' })).control, 'paused');
  await commands.get('remote').handler('on', ctx);
});
test('stale session identifiers cannot prompt a switched session', async () => {
  const old = sessionId; sessionId = 'test-session-2'; await emit('session_switch');
  await assert.rejects(send({ session_id: old }), /Session changed/);
});
test('followUp while idle starts a normal prompt rather than leaving it stuck in a queue', async () => {
  await new Promise(resolve => setTimeout(resolve, 1050));
  await send({ mode: 'followUp' }); assert.equal(sent.at(-1).options, undefined);
});
test('native rename persists without a model prompt and deduplicates', async () => {
  const request_id = randomUUID(); const first = await rename({ request_id }); const again = await rename({ request_id });
  assert.equal(first.operation, 'rename'); assert.equal(again.duplicate, true); assert.equal(sessionName, 'Website polish');
  assert.equal((await request(socket, { op: 'read' })).name, 'Website polish');
  await assert.rejects(rename({ name: 'bad\nname' }), /control characters/);
});
test('native approval state is visible and blocks prompts', async () => {
  await new Promise(resolve => setTimeout(resolve, 1050));
  await emit('tool_approval_requested', { toolCallId: 'approval-1', toolName: 'bash', reason: 'Review command' });
  assert.equal((await readSession(sessionId)).status, 'waiting_for_approval');
  await assert.rejects(send(), /native dialog/);
  await emit('tool_approval_resolved', { toolCallId: 'approval-1' });
});
test('interrupt uses OMP abort and deduplicates retries', async () => {
  await new Promise(resolve => setTimeout(resolve, 1050));
  const req = { op: 'interrupt', session_id: sessionId, instance_id: instanceId, request_id: randomUUID() };
  await request(socket, req); await request(socket, req); assert.equal(aborted, 1);
});
test('streaming text, ask state, and wait revisions reflect OMP events', async () => {
  await emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'streaming now' }] } });
  assert.equal((await readSession(sessionId)).live.text, 'streaming now');
  const { sessions } = await listSessions(); const current = sessions.find(s => s.id === sessionId);
  await emit('tool_execution_start', { toolCallId: 'tool-1', toolName: 'ask' });
  assert.equal((await readSession(sessionId)).status, 'waiting_for_input');
  const result = await waitSessions({ session_ids: [sessionId], after: { [sessionId]: current.revision }, timeout_ms: 0 });
  assert.equal(result.changed.length, 1);
  await emit('tool_execution_end', { toolCallId: 'tool-1', toolName: 'ask' });
});
test('controller rejects missing targets; wait reports disconnection', async () => {
  await assert.rejects(sendPrompt({ session_id: '../../bad', instance_id: instanceId }), /no longer connected/);
  const result = await waitSessions({ session_ids: ['closed-session'], timeout_ms: 0 }); assert.equal(result.changed[0].status, 'disconnected');
});
test('MCP validates arguments, handshake, schemas and bounded stdio framing', async () => {
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).result.protocolVersion, '2025-03-26');
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 6);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'omp_send_prompt', arguments: {} } })).error.code, -32602);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'omp_list_sessions', arguments: { extra: true } } })).error.code, -32602);
  const child = spawn(process.execPath, ['mcp.mjs'], { cwd: new URL('..', import.meta.url), env: process.env });
  let out = ''; child.stdout.on('data', b => { out += b; });
  const valid = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
  child.stdin.end(`${'x'.repeat(512 * 1024 + 1)}\n${valid}\n`);
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  const replies = out.trim().split('\n').map(JSON.parse); assert.equal(replies[0].error.code, -32600); assert.equal(replies[1].result.tools.length, 6);
});
