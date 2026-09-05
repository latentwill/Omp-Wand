import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { lstat, mkdir } from 'node:fs/promises';
import { lstatSync, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const remoteDir = () => process.env.OMP_REMOTE_DIR || join(homedir(), '.omp', 'omp-wand');
export const MAX_FRAME = 512 * 1024;
export const MAX_CLIENT_TIMEOUT = 2500;

function uid() { return typeof process.getuid === 'function' ? process.getuid() : null; }
function assertOwner(stat, label) {
  const current = uid();
  if (current !== null && stat.uid !== current) throw new Error(`${label} is owned by another user`);
}
function assertPrivateDirectoryStat(stat, label) {
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  assertOwner(stat, label);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${label} must have mode 0700`);
}
function assertSocketStat(stat, label) {
  if (!stat.isSocket()) throw new Error(`${label} is not a Unix socket`);
  assertOwner(stat, label);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
}
export async function ensurePrivateDir(path = remoteDir()) {
  try { await mkdir(path, { recursive: true, mode: 0o700 }); } catch (error) { throw new Error(`Cannot create private socket directory: ${error.message}`); }
  const stat = await lstat(path);
  assertPrivateDirectoryStat(stat, 'Private socket directory');
  return stat;
}
export function ensurePrivateDirSync(path = remoteDir()) {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch (error) { throw new Error(`Cannot create private socket directory: ${error.message}`); }
  const stat = lstatSync(path);
  assertPrivateDirectoryStat(stat, 'Private socket directory');
  return stat;
}
export async function assertPrivateSocket(path) {
  const stat = await lstat(path);
  assertSocketStat(stat, 'Socket entry');
  return stat;
}
export function assertPrivateSocketSync(path) {
  const stat = lstatSync(path);
  assertSocketStat(stat, 'Socket entry');
  return stat;
}
export function messageText(message) {
  if (typeof message?.content === 'string') return message.content.slice(-16000);
  return (message?.content || []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n').slice(-16000);
}
export async function request(socketPath, payload, timeout = MAX_CLIENT_TIMEOUT) {
  await assertPrivateSocket(socketPath);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const decoder = new StringDecoder('utf8');
    let data = '';
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const deadline = setTimeout(() => finish(new Error('Session did not respond; delivery may be uncertain. Retry with the same request_id.')), timeout);
    deadline.unref?.();
    socket.setNoDelay(true);
    socket.on('error', error => finish(error));
    socket.on('connect', () => {
      try { socket.write(JSON.stringify(payload) + '\n'); } catch (error) { finish(error); }
    });
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME) { finish(new Error('Response too large')); return; }
      data += decoder.write(chunk);
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(data.slice(0, newline));
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Invalid session response');
        finish(reply.error ? new Error(String(reply.error)) : null, reply.result);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => {
      data += decoder.end();
      if (!data.includes('\n')) finish(new Error('Session closed before replying'));
    });
  });
}
