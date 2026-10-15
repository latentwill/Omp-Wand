import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { lstat, mkdir } from 'node:fs/promises';
import { lstatSync, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const remoteDir = () => process.env.OMP_REMOTE_DIR || join(homedir(), '.omp', 'omp-wand');
export const MAX_FRAME = 1024 * 1024;
export const CLIENT_TIMEOUT = 2500;

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
  await mkdir(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectoryStat(await lstat(path), 'Private socket directory');
}
export function ensurePrivateDirSync(path = remoteDir()) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectoryStat(lstatSync(path), 'Private socket directory');
}
export async function assertPrivateSocket(path) { assertSocketStat(await lstat(path), 'Socket entry'); }
export function assertPrivateSocketSync(path) { assertSocketStat(lstatSync(path), 'Socket entry'); }

const clip = (text, max) => text.length > max ? `…${text.slice(-max)}` : text;
const clipHead = (text, max) => text.length > max ? `${text.slice(0, max)}…` : text;

/** Plain text of an OMP message: text blocks only, tail-clipped. */
export function messageText(message, max = 16000) {
  if (typeof message?.content === 'string') return clip(message.content, max);
  return clip((message?.content || []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n'), max);
}

/** Compact transcript entry: text plus one-line tool calls, so the reader can follow what the agent did. */
export function transcriptEntry(message, max = 4000) {
  const entry = { role: message.role, text: messageText(message, max) };
  if (message.role === 'toolResult') {
    entry.tool = message.toolName;
    entry.text = clip(entry.text, 600);
    if (message.isError) entry.error = true;
  }
  const calls = Array.isArray(message.content) ? message.content.filter(c => c.type === 'toolCall') : [];
  if (calls.length) entry.tool_calls = calls.map(c => `${c.name}(${clipHead(JSON.stringify(c.arguments ?? {}), 300)})`);
  return entry;
}

/** One newline-delimited JSON request/response over a private Unix socket. */
export async function request(socketPath, payload, timeout = CLIENT_TIMEOUT) {
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
    const deadline = setTimeout(() => finish(new Error('Session did not respond')), timeout);
    deadline.unref?.();
    socket.setNoDelay(true);
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
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
