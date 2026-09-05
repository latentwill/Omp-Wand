#!/usr/bin/env node
import { mkdir, copyFile, readFile, writeFile, unlink, lstat, realpath } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
const extensionName = 'omp-wand';
const destination = join(homedir(), '.omp/agent/extensions', extensionName);
const markerName = '.omp-wand-install';
const pendingName = '.omp-wand-install.pending';
const runtimeFiles = ['index.ts', 'session.mjs', 'shared.mjs', 'controller.mjs', 'mcp.mjs'];
const currentUid = () => typeof process.getuid === 'function' ? process.getuid() : null;
export function findBinary(name) {
  const dirs = [...(process.env.PATH || '').split(':'), join(homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/Applications/Codex.app/Contents/Resources'];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
  throw new Error(`${name} is required but was not found. Install ${name}, then launch again.`);
}
async function regularOwned(path, label, maxBytes = 4096) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing non-regular ${label} ${path}.`);
  if (currentUid() !== null && stat.uid !== currentUid()) throw new Error(`Refusing ${label} owned by another user.`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`Refusing ${label} writable by another user.`);
  if (stat.size > maxBytes) throw new Error(`${label} is too large.`);
  return stat;
}
async function ensureDestination() {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const homeReal = await realpath(homedir());
  if ((await realpath(parent)) !== resolve(join(homeReal, '.omp/agent/extensions'))) throw new Error(`Refusing symlinked extension parent ${parent}.`);
  let stat;
  try { stat = await lstat(destination); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(destination, { mode: 0o700 });
    stat = await lstat(destination);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to use unrelated extension path ${destination}.`);
  return stat;
}
async function markerState(name, expected) {
  const path = join(destination, name);
  try {
    await regularOwned(path, `${name} marker`);
    return (await readFile(path, 'utf8')) === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function registrationObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.command === 'string' && Array.isArray(value.args)) return { command: value.command, args: value.args };
  for (const child of Object.values(value)) {
    const found = registrationObject(child);
    if (found) return found;
  }
  return null;
}
function registrationAbsent(output) { return /^Error: No MCP server named ['"]omp-wand['"] found\.$/i.test(output.trim()); }
function inspectRegistration(codex, expected) {
  try {
    const output = execFileSync(codex, ['mcp', 'get', extensionName, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw new Error('Codex returned an invalid MCP registration response.'); }
    const found = registrationObject(parsed);
    if (!found) throw new Error('Codex returned no usable MCP transport details.');
    if (found.command !== expected.command || JSON.stringify(found.args) !== JSON.stringify(expected.args)) throw new Error(`An unrelated MCP server named ${extensionName} already exists; installation stopped.`);
    return true;
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('invalid MCP') || error.message.includes('no usable MCP')) throw error;
    const output = `${error.stdout || ''}\n${error.stderr || ''}`;
    if (registrationAbsent(output)) return false;
    throw new Error(`Could not safely inspect the ${extensionName} MCP registration; installation stopped.`);
  }
}
async function assertConfigPath(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to follow non-regular Codex config path ${path}.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function copyRuntimeFiles(ours) {
  for (const file of runtimeFiles) {
    const target = join(destination, file);
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile() || (currentUid() !== null && stat.uid !== currentUid()) || (stat.mode & 0o022) !== 0 || !ours) throw new Error(`Refusing to overwrite unrelated extension file ${target}.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await copyFile(join(source, file), target);
  }
}
export async function install() {
  const codex = findBinary('codex'); findBinary('omp');
  const node = findBinary('node');
  await ensureDestination();
  const marker = join(destination, markerName);
  const pending = join(destination, pendingName);
  const markerExpected = 'Omp-Wand 1.0.0\n';
  const pendingExpected = 'Omp-Wand installation in progress\n';
  const complete = await markerState(markerName, markerExpected);
  const pendingState = await markerState(pendingName, pendingExpected);
  if (!complete && !pendingState) {
    for (const file of runtimeFiles) {
      try { await lstat(join(destination, file)); throw new Error(`An unrelated extension already exists at ${destination}; installation stopped without replacing it.`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const configHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const configHomeStat = await lstat(configHome);
  if (configHomeStat.isSymbolicLink() || !configHomeStat.isDirectory()) throw new Error(`Refusing non-regular Codex config directory ${configHome}.`);
  const config = join(configHome, 'config.toml');
  await assertConfigPath(config);
  const expected = { command: node, args: [join(destination, 'mcp.mjs')] };
  // Inspect the installed Codex representation before changing any extension files.
  const registered = inspectRegistration(codex, expected);
  if (!complete && !pendingState) await writeFile(pending, pendingExpected, { flag: 'wx', mode: 0o600 });
  await copyRuntimeFiles(true);
  if (!registered) {
    const configText = await readFile(config, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (configText) {
      const backup = `${config}.before-omp-wand`;
      await assertConfigPath(backup);
      try { await writeFile(backup, configText, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    // The completion marker is written only after this registration succeeds.
    execFileSync(codex, ['mcp', 'add', extensionName, '--', node, join(destination, 'mcp.mjs')], { stdio: 'inherit' });
  }
  await writeFile(marker, markerExpected, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log('Omp-Wand installed. New omp terminals connect automatically.');
  console.log('For already-open OMP terminals, exit when idle and use the printed omp --resume command once. Reconnect MCP or restart Codex to load its new tools.');
  return destination;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) install().catch(error => { console.error(error.message); process.exitCode = 1; });
