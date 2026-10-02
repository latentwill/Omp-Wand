import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirSync } from './shared.mjs';

export function readPrivateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || (typeof process.getuid === 'function' && s.uid !== process.getuid()) || (s.mode & 0o777) !== 0o600 || s.size > 16 * 1024 * 1024) throw new Error('Expected an owned regular 0600 JSON file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

// One process owns a state directory. Fail closed on stale locks; operator verifies before removal.
export class EventStore {
  constructor(dir) {
    ensurePrivateDirSync(dir); this.dir = dir; this.path = join(dir, 'events.json'); this.lock = join(dir, 'relay.lock');
    const fd = openSync(this.lock, 'wx', 0o600);
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    try {
      try { this.state = readPrivateJson(this.path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 1, subscriptions: [], pending: [], seen: [] }; }
      if (this.state.version !== 1 || !['subscriptions', 'pending', 'seen'].every(k => Array.isArray(this.state[k]))) throw new Error('Invalid event state');
    } catch (error) { this.close(); throw error; }
  }
  save(next) {
    if (this.closed) throw new Error('Event store closed');
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    ensurePrivateDirSync(this.dir);
    try {
      const s = lstatSync(this.path);
      if (!s.isFile() || (s.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('Unsafe event state file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(this.dir, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(temporary, this.path);
      this.state = next;
      const directory = openSync(this.dir, constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { try { unlinkSync(temporary); } catch {} }
  }
  close() { if (!this.closed) { unlinkSync(this.lock); this.closed = true; } }
}
