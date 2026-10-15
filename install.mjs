#!/usr/bin/env node
// Install the OMP extension and register the omp-wand MCP server with Claude Code and/or Codex.
// Usage: node install.mjs [--claude] [--codex]   (default: every CLI found on PATH)
import { mkdir, copyFile, lstat, readFile, writeFile } from 'node:fs/promises';
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

// Codex defaults to a 60 s tool timeout, which cuts off long omp_wait calls, and asks before each call.
const CODEX_SETTINGS = { tool_timeout_sec: '900', default_tools_approval_mode: '"approve"' };
export async function configureCodex(config = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')) {
  const lines = (await readFile(config, 'utf8')).split('\n');
  const start = lines.findIndex(line => line.trim() === '[mcp_servers.omp-wand]');
  if (start < 0) throw new Error(`No [mcp_servers.omp-wand] table in ${config}`);
  let end = lines.findIndex((line, i) => i > start && line.trim().startsWith('['));
  if (end < 0) end = lines.length;
  const keep = lines.slice(start + 1, end).filter(line => !Object.keys(CODEX_SETTINGS).some(key => line.trim().startsWith(`${key} `) || line.trim().startsWith(`${key}=`)));
  const settings = Object.entries(CODEX_SETTINGS).map(([key, value]) => `${key} = ${value}`);
  await writeFile(config, [...lines.slice(0, start + 1), ...keep.filter(line => line.trim()), ...settings, '', ...lines.slice(end)].join('\n'));
}

export async function install(argv = process.argv.slice(2)) {
  if (!findBinary('omp')) console.warn('Warning: omp was not found on PATH.');
  const dest = await copyExtension();
  // The PATH node (e.g. /opt/homebrew/bin/node) survives upgrades; process.execPath can be a versioned Cellar path.
  const server = [findBinary('node') ?? process.execPath, join(dest, 'mcp.mjs')];
  const wanted = ['claude', 'codex'].filter(cli => !argv.length || argv.includes(`--${cli}`));
  console.log(`Extension installed in ${dest}`);
  for (const cli of wanted) {
    const result = register(cli, server);
    if (cli === 'codex' && !result.includes('skipped')) await configureCodex();
    console.log(result);
  }
  console.log('New omp terminals connect automatically. Restart already-open terminals (omp --resume <id>) to load the extension.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) install().catch(error => { console.error(error.message); process.exitCode = 1; });
