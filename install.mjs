#!/usr/bin/env node
// Install the OMP extension and register the omp-wand MCP server with Claude Code and/or Codex.
// Usage: node install.mjs [--claude] [--codex]   (default: every CLI found on PATH)
import { mkdir, copyFile, lstat } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
export const destination = () => join(homedir(), '.omp/agent/extensions/omp-wand');
export const runtimeFiles = ['index.ts', 'session.mjs', 'dialogs.mjs', 'shared.mjs', 'controller.mjs', 'mcp.mjs'];

export function findBinary(name) {
  const dirs = [...(process.env.PATH || '').split(':'), join(homedir(), '.bun/bin'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs.filter(Boolean)) {
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
  return null;
}

export async function copyExtension(dest = destination()) {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  if ((await lstat(dest)).isSymbolicLink()) throw new Error(`Refusing symlinked extension folder ${dest}`);
  for (const file of runtimeFiles) await copyFile(join(source, file), join(dest, file));
  return dest;
}

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' });

// Remove then add, so a re-run repairs a stale path. A missing entry on remove is expected.
function register(cli, server) {
  const bin = findBinary(cli);
  if (!bin) return `${cli}: not found, skipped`;
  const scope = cli === 'claude' ? ['--scope', 'user'] : [];
  run(bin, ['mcp', 'remove', ...scope, 'omp-wand']);
  const added = run(bin, ['mcp', 'add', ...scope, 'omp-wand', '--', ...server]);
  if (added.status !== 0) throw new Error(`${cli} mcp add failed: ${(added.stderr || added.stdout).trim()}`);
  return `${cli}: registered omp-wand`;
}

export async function install(argv = process.argv.slice(2)) {
  if (!findBinary('omp')) console.warn('Warning: omp was not found on PATH.');
  const dest = await copyExtension();
  // The PATH node (e.g. /opt/homebrew/bin/node) survives upgrades; process.execPath can be a versioned Cellar path.
  const server = [findBinary('node') ?? process.execPath, join(dest, 'mcp.mjs')];
  const wanted = ['claude', 'codex'].filter(cli => !argv.length || argv.includes(`--${cli}`));
  console.log(`Extension installed in ${dest}`);
  for (const cli of wanted) console.log(register(cli, server));
  console.log('New omp terminals connect automatically. Restart already-open terminals (omp --resume <id>) to load the extension.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) install().catch(error => { console.error(error.message); process.exitCode = 1; });
