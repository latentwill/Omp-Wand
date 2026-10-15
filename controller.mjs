import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { remoteDir, request, ensurePrivateDir } from './shared.mjs';

const SOCKET_NAME = /^\d+-[a-f0-9]{8}\.sock$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Status of every connected OMP terminal, with the socket path kept for routing. */
async function connected() {
  const dir = remoteDir();
  try { await ensurePrivateDir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = await readdir(dir, { withFileTypes: true });
  const results = await Promise.all(entries.filter(e => SOCKET_NAME.test(e.name) && e.isSocket()).map(async e => {
    const socket = join(dir, e.name);
    try { return { ...await request(socket, { op: 'status' }, 800), socket }; } catch { return null; }
  }));
  return results.filter(Boolean);
}

async function target(id) {
  const matches = (await connected()).filter(s => s.id === id);
  if (matches.length > 1) throw new Error('This session is open in more than one terminal. Close the duplicate first.');
  if (!matches.length) throw new Error(`No connected OMP session ${id}. Call omp_list_sessions.`);
  return matches[0];
}
const call = async (id, payload) => request((await target(id)).socket, { ...payload, session_id: id });

export async function listSessions() {
  return { sessions: (await connected()).map(({ socket, ...session }) => session) };
}
export const readSession = ({ session_id, limit }) => call(session_id, { op: 'read', limit });
export const answerDialog = ({ session_id, dialog_id, ...answer }) => call(session_id, { op: 'answer', dialog_id, answer });
export const interruptSession = ({ session_id }) => call(session_id, { op: 'interrupt' });
export const renameSession = ({ session_id, name }) => call(session_id, { op: 'rename', name });

export async function sendPrompt({ session_id, text, mode, wait_seconds = 0 }) {
  const sent = await call(session_id, { op: 'send', text, mode });
  if (!wait_seconds) return sent;
  return { sent, ...await waitSessions({ session_ids: [session_id], timeout_seconds: wait_seconds }) };
}

/**
 * Wait until sessions settle: idle, waiting on a dialog, or disconnected.
 * Returns each session's status, open dialogs and last assistant reply, so the caller can act at once.
 */
export async function waitSessions({ session_ids, all = false, timeout_seconds = 50 }) {
  const deadline = Date.now() + timeout_seconds * 1000;
  const settled = s => s.status !== 'working';
  while (true) {
    const live = await connected();
    const states = session_ids.map(id => live.find(s => s.id === id) || { id, status: 'disconnected' });
    const done = all ? states.every(settled) : states.some(settled);
    if (done || Date.now() >= deadline) {
      const sessions = await Promise.all(states.map(async s => {
        if (s.status === 'disconnected' || s.status === 'working') return { id: s.id, status: s.status, ...(s.tools?.length ? { tools: s.tools } : {}) };
        const read = await request(s.socket, { op: 'read', session_id: s.id, limit: 1 }).catch(() => s);
        return { id: s.id, name: read.name, status: read.status, dialogs: read.dialogs, last_assistant: read.last_assistant, last_error: read.last_error };
      }));
      return { timed_out: !done, sessions };
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}
