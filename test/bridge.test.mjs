import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'ompw-'));
process.env.OMP_WAND_DIR = dir;
const { attachRemote } = await import('../session.mjs');
const { listSessions, readSession, sendPrompt, answerDialog, waitSessions, interruptSession, renameSession } = await import('../controller.mjs');
const { dispatch } = await import('../mcp.mjs');

const sid = 'test-session-1';
let idle = true, draft = '', aborted = 0, sessionName = 'Test';
const sent = [], events = new Map(), commands = new Map();
const branch = [
  { type: 'message', message: { role: 'user', content: 'local prompt' } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading files' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.txt' } }] } },
  { type: 'message', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'file body' }] } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
];
// The UI's ask dialog stays open until aborted, like the real TUI with nobody at the desk.
const ui = {
  setStatus() {}, notify() {}, getEditorText: () => draft,
  askDialog: (_questions, options) => new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve(undefined))),
};
const ctx = { hasUI: true, mode: 'tui', cwd: '/test/project', model: { provider: 'test', id: 'offline' },
  isIdle: () => idle, hasPendingMessages: () => false, abort: () => { aborted++; }, ui,
  sessionManager: { getSessionId: () => sid, getSessionFile: () => null, getBranch: () => branch } };
const emit = (type, data = {}) => events.get(type)?.(data, ctx);

before(async () => {
  attachRemote({ on: (name, handler) => events.set(name, handler), registerCommand: (name, cmd) => commands.set(name, cmd),
    getSessionName: () => sessionName, setSessionName: async name => { sessionName = name; }, sendUserMessage: (text, options) => sent.push({ text, options }) });
  await emit('session_start');
});
after(async () => { await emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); });

test('private socket; list and read show status and a transcript with tool calls', async () => {
  const [socket] = await readdir(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, socket))).mode & 0o777, 0o600);
  const { sessions } = await listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'idle');
  const read = await readSession({ session_id: sid });
  assert.equal(read.last_assistant, 'Done.');
  assert.deepEqual(read.messages[1].tool_calls, ['read({"path":"a.txt"})']);
  assert.equal(read.messages[2].tool, 'read');
  assert.equal((await readSession({ session_id: sid, limit: 1 })).messages.length, 1);
});

test('send: plain prompt while idle, busy until the agent starts, then followUp queues', async () => {
  const text = 'Hello 世界\n$(touch /tmp/never)';
  assert.deepEqual(await sendPrompt({ session_id: sid, text }), { accepted: true, mode: 'prompt' });
  assert.deepEqual(sent.at(-1), { text, options: undefined });
  assert.equal((await readSession({ session_id: sid })).status, 'working', 'a submitted prompt counts as work');
  await assert.rejects(sendPrompt({ session_id: sid, text: 'again' }), /busy/);
  assert.equal((await sendPrompt({ session_id: sid, text: 'next', mode: 'followUp' })).mode, 'followUp');
  assert.deepEqual(sent.at(-1).options, { deliverAs: 'followUp' });
  idle = false; await emit('agent_start');
  idle = true; await emit('agent_end');
  assert.equal((await readSession({ session_id: sid })).status, 'idle');
});

test('send refuses drafts, commands and paused control', async () => {
  draft = 'unfinished'; await assert.rejects(sendPrompt({ session_id: sid, text: 'x' }), /unsent local draft/); draft = '';
  await assert.rejects(sendPrompt({ session_id: sid, text: '/compact' }), /plain prompts/);
  await commands.get('remote').handler('off', ctx);
  await assert.rejects(sendPrompt({ session_id: sid, text: 'x' }), /paused/);
  assert.equal((await readSession({ session_id: sid })).control, 'paused', 'reads still work');
  await commands.get('remote').handler('on', ctx);
});

test('a pending ask dialog is visible, blocks prompts, and is answered remotely', async () => {
  idle = false;
  const asked = ui.askDialog([{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]);
  const waited = await waitSessions({ session_ids: [sid], timeout_seconds: 2 });
  assert.equal(waited.timed_out, false);
  assert.equal(waited.sessions[0].status, 'waiting_for_input');
  const [dialog] = waited.sessions[0].dialogs;
  assert.equal(dialog.kind, 'ask');
  assert.equal(dialog.questions[0].options[1].label, 'SQLite');
  await assert.rejects(sendPrompt({ session_id: sid, text: 'x', mode: 'steer' }), /dialog is open/);
  await assert.rejects(answerDialog({ session_id: sid, choice: 'MySQL' }), /not one of/);
  assert.deepEqual(await answerDialog({ session_id: sid, dialog_id: dialog.id, choice: 1 }), { answered: dialog.id, kind: 'ask' });
  assert.deepEqual((await asked).results[0].selectedOptions, ['SQLite']);
  assert.equal((await readSession({ session_id: sid })).status, 'working');
  idle = true;
});

test('wait times out on a working session and reports disconnection', async () => {
  idle = false;
  const slow = await waitSessions({ session_ids: [sid], timeout_seconds: 1 });
  assert.equal(slow.timed_out, true);
  assert.equal(slow.sessions[0].status, 'working');
  idle = true;
  const gone = await waitSessions({ session_ids: ['closed-session'], timeout_seconds: 0 });
  assert.equal(gone.sessions[0].status, 'disconnected');
});

test('interrupt and rename', async () => {
  await interruptSession({ session_id: sid }); assert.equal(aborted, 1);
  await renameSession({ session_id: sid, name: 'Website polish' }); assert.equal(sessionName, 'Website polish');
  await assert.rejects(renameSession({ session_id: sid, name: 'bad\nname' }), /control characters/);
  await assert.rejects(readSession({ session_id: 'missing' }), /No connected OMP session/);
});

test('MCP: handshake, schema validation, and a tool call', async () => {
  const init = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.match(init.result.instructions, /omp_answer/);
  const names = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map(t => t.name);
  assert.deepEqual(names, ['omp_list_sessions', 'omp_read_session', 'omp_send_prompt', 'omp_answer', 'omp_wait', 'omp_interrupt', 'omp_rename_session']);
  const call = (name, args) => dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  assert.match((await call('omp_send_prompt', {})).error.message, /session_id is required/);
  assert.match((await call('omp_list_sessions', { extra: true })).error.message, /Unknown argument/);
  assert.match((await call('omp_answer', { session_id: sid, choice: true })).error.message, /string or integer/);
  assert.match((await call('omp_wait', { session_ids: [sid], timeout_seconds: 5000 })).error.message, /at most 900/);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
  const listed = await call('omp_list_sessions', {});
  assert.equal(JSON.parse(listed.result.content[0].text).sessions[0].id, sid);
  const failed = await call('omp_answer', { session_id: sid, choice: 0 });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /No dialog is open/);
});

test('MCP stdio framing drops oversized lines and keeps serving', async () => {
  const child = spawn(process.execPath, ['mcp.mjs'], { cwd: new URL('..', import.meta.url), env: process.env });
  let out = ''; child.stdout.on('data', b => { out += b; });
  child.stdin.end(`${'x'.repeat(1024 * 1024 + 1)}\n${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })}\n`);
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  const replies = out.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].error.code, -32600);
  assert.equal(replies.at(-1).result.tools.length, 7);
});
