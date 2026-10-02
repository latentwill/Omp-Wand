import { readdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { remoteDir, request, messageText, ensurePrivateDir, assertPrivateSocket } from './shared.mjs';
const exec = promisify(execFile);
const MAX_LEGACY_TAIL = 256 * 1024;
const MAX_MARKER = 4096;
const agentRoot = () => join(homedir(), '.omp', 'agent');
const sessionsRoot = () => resolve(join(agentRoot(), 'sessions'));
const within = (root, file) => file === root || file.startsWith(root + sep);
const userUid = () => typeof process.getuid === 'function' ? process.getuid() : null;
async function openOwnedRegular(path, label) {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0);
  const file = await open(path, flags);
  const stat = await file.stat();
  if (!stat.isFile()) { await file.close(); throw new Error(`${label} is not a regular file`); }
  if (userUid() !== null && stat.uid !== userUid()) { await file.close(); throw new Error(`${label} is owned by another user`); }
  if ((stat.mode & 0o022) !== 0) { await file.close(); throw new Error(`${label} is writable by another user`); }
  return { file, stat };
}
async function readOwnedRegular(path, maxSize, label) {
  const { file, stat } = await openOwnedRegular(path, label);
  try {
    if (stat.size > maxSize) throw new Error(`${label} is too large`);
    const buffer = Buffer.alloc(stat.size);
    await file.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8');
  } finally { await file.close(); }
}
async function validSessionFile(candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/')) return null;
  const root = sessionsRoot();
  const path = resolve(candidate);
  if (!within(root, path)) return null;
  try {
    const real = await realpath(path);
    if (!within(root, real)) return null;
    // O_NOFOLLOW + fstat rejects symlinks, FIFOs, sockets, and device files.
    const { file } = await openOwnedRegular(path, 'Saved session file');
    await file.close();
    return real;
  } catch { return null; }
}
async function connected() {
  const dir = remoteDir();
  try { await ensurePrivateDir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = await readdir(dir, { withFileTypes: true });
  const results = await Promise.all(entries.filter(entry => /^\d+-[a-f0-9]{8}\.sock$/.test(entry.name) && entry.isSocket()).map(async entry => {
    const path = join(dir, entry.name);
    try { await assertPrivateSocket(path); return { ...await request(path, { op: 'status' }, 800), socket: path }; }
    catch { return null; }
  }));
  return results.filter(Boolean);
}
async function legacySessions(live) {
  const uid = userUid();
  if (uid === null) throw new Error('Current-user process discovery is unavailable');
  const { stdout } = await exec('/bin/ps', ['-u', String(uid), '-o', 'pid=,tty=,comm='], { timeout: 1000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' });
  const rows = stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/)).filter(Boolean);
  const results = await Promise.all(rows.filter(([, pid, tty, command]) => /^[A-Za-z0-9._-]{1,32}$/.test(tty) && tty !== '??' && /(^|\/)omp$/.test(command) && !live.some(s => s.pid === Number(pid))).map(async ([, pid, tty]) => {
    const markerPath = join(agentRoot(), 'terminal-sessions', tty);
    let project = null, sessionFile = null;
    try {
      const marker = await readOwnedRegular(markerPath, MAX_MARKER, 'Terminal marker');
      const lines = marker.trim().split('\n');
      project = lines[0] || null;
      sessionFile = await validSessionFile(lines[1]);
    } catch {}
    return { id: `terminal-${pid}`, pid: Number(pid), terminal: tty, project,
      sessionFile, status: 'unknown', control: 'monitor_only',
      note: 'Monitor-only process; status cannot be inferred reliably from saved logs. When idle, exit OMP and resume the same saved session to load the extension.' };
  }));
  return results;
}
export async function listSessions() {
  const live = await connected();
  let legacy = [], warning;
  try { legacy = await legacySessions(live); } catch { warning = 'Process discovery unavailable; only connected sessions are listed.'; }
  return { sessions: [...live.map(({ socket, ...session }) => session), ...legacy], ...(warning ? { warning } : {}) };
}
// Local collector only: excludes monitor-only logs and never asks for transcript text.
export async function collectEvents() {
  const sessions = await connected();
  const batches = await Promise.all(sessions.map(async session => {
    try { return (await request(session.socket, { op: 'events', session_id: session.id })).events || []; }
    catch { return []; } // Old extensions do not implement this optional operation.
  }));
  return batches.flat();
}
async function target(id) {
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('An exact session_id from omp_list_sessions is required');
  const matches = (await connected()).filter(s => s.id === id);
  if (matches.length > 1) throw new Error('This saved session is open in multiple terminals. Close the duplicate before controlling it.');
  if (matches.length === 1) return matches[0];
  const legacy = (await listSessions()).sessions.find(s => s.id === id);
  if (legacy) return legacy;
  throw new Error('Session is no longer connected; list sessions again');
}
export async function readSession(id) {
  const session = await target(id);
  if (session.socket) return request(session.socket, { op: 'read', session_id: id });
  if (!session.sessionFile) return { ...session, messages: [] };
  const path = await validSessionFile(session.sessionFile);
  if (!path) return { ...session, sessionFile: null, messages: [] };
  const { file, stat } = await openOwnedRegular(path, 'Saved session file');
  try {
    const start = Math.max(0, stat.size - MAX_LEGACY_TAIL);
    const buffer = Buffer.alloc(stat.size - start);
    await file.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
    const entries = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { ...session, messages: entries.filter(e => e.type === 'message').slice(-10)
      .map(e => ({ role: e.message.role, text: messageText(e.message) })),
    note: 'Saved log tail only; may include inactive branches. Transient UI and current activity are unknown. When idle, exit OMP and resume the same saved session for live control.' };
  } finally { await file.close(); }
}
export async function sendPrompt(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Prompt arguments must be an object');
  const session = await target(args.session_id);
  if (!session.socket) throw new Error('Monitor-only terminal. When idle, exit OMP and resume the same saved session before sending prompts.');
  return request(session.socket, { ...args, mode: args.mode || 'prompt', op: 'send' });
}
export async function interruptSession(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Interrupt arguments must be an object');
  const session = await target(args.session_id);
  if (!session.socket) throw new Error('Monitor-only terminal; interruption is unavailable.');
  return request(session.socket, { session_id: args.session_id, instance_id: args.instance_id, request_id: args.request_id, op: 'interrupt' });
}
export async function waitSessions({ session_ids, after = {}, timeout_ms = 20000 }) {
  if (!Array.isArray(session_ids) || !session_ids.length || session_ids.length > 20 || session_ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Choose 1–20 exact session_ids');
  if (!after || typeof after !== 'object' || Array.isArray(after)) throw new Error('after must be a mapping of session IDs to cursors');
  if (!Number.isFinite(timeout_ms) || !Number.isInteger(timeout_ms) || timeout_ms < 0 || timeout_ms > 25000) throw new Error('timeout_ms must be between 0 and 25000');
  const cursor = value => {
    if (value === null || (Number.isInteger(value) && value >= 0)) return { revision: value, instance_id: null };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('after cursors must contain revision and instance_id');
    if (value.revision !== null && (!Number.isInteger(value.revision) || value.revision < 0)) throw new Error('cursor revisions must be non-negative integers or null');
    if (value.instance_id !== undefined && value.instance_id !== null && (typeof value.instance_id !== 'string' || value.instance_id.length > 100)) throw new Error('cursor instance_id must be a string or null');
    return { revision: value.revision, instance_id: value.instance_id ?? null };
  };
  const deadline = Date.now() + timeout_ms;
  const baseline = Object.fromEntries(Object.entries(after).map(([id, value]) => [id, cursor(value)]));
  while (true) {
    const { sessions, warning } = await listSessions();
    const selected = session_ids.map(id => sessions.find(s => s.id === id) || { id, status: 'disconnected' });
    for (const session of selected) {
      if (session.control === 'monitor_only') throw new Error('Wait requires connected sessions. Restart and resume monitor-only terminals first.');
      if (!(session.id in baseline)) baseline[session.id] = { revision: session.revision ?? null, instance_id: session.instance_id ?? null };
    }
    const changed = selected.filter(s => s.status === 'disconnected' || s.revision !== baseline[s.id].revision || s.instance_id !== baseline[s.id].instance_id);
    if (changed.length || Date.now() >= deadline) return { changed, sessions: selected, after: Object.fromEntries(selected.map(s => [s.id, { revision: s.revision ?? null, instance_id: s.instance_id ?? null }])), timedOut: !changed.length, ...(warning ? { warning } : {}) };
    await new Promise(resolve => setTimeout(resolve, Math.min(700, Math.max(0, deadline - Date.now()))));
  }
}
export async function renameSession(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Rename arguments must be an object');
  const session = await target(args.session_id);
  if (!session.socket) throw new Error('Monitor-only terminal. When idle, exit OMP and resume the same saved session before renaming it.');
  return request(session.socket, { session_id: args.session_id, instance_id: args.instance_id, name: args.name, request_id: args.request_id, op: 'rename' });
}
