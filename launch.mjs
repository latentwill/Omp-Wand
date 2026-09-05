#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDir } from './shared.mjs';
import { findBinary, install } from './install.mjs';

try {
  // Verify the owned extension and MCP registration on every launcher run; a marker alone is not proof of registration.
  await install();
  const stateDir = join(homedir(), '.omp', 'omp-wand');
  await ensurePrivateDir(stateDir);
  const recentPath = join(stateDir, 'last-project');
  let recent = homedir();
  try {
    const stat = await lstat(recentPath);
    if (stat.isSymbolicLink() || !stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error('Refusing unsafe Omp-Wand last-project state.');
    recent = await readFile(recentPath, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let project = process.argv[2];
  if (!project) {
    // Folder values travel as argv, never interpolated into AppleScript or shell code.
    const result = spawnSync('/usr/bin/osascript', ['-e', 'on run argv\nreturn POSIX path of (choose folder with prompt "Open Omp-Wand in a project folder" default location (POSIX file (item 1 of argv)))\nend run', recent], { encoding: 'utf8' });
    if (result.status !== 0) { if (result.stderr?.includes('(-128)')) process.exit(0); throw new Error(result.stderr || 'Folder selection failed'); }
    project = result.stdout.trim();
  }
  if (!project) throw new Error('A project folder is required.');
  try {
    const stat = await lstat(recentPath);
    if (stat.isSymbolicLink() || !stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error('Refusing unsafe Omp-Wand last-project state.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(recentPath, project, { mode: 0o600 });
  const result = spawnSync(findBinary('omp'), ['--cwd', project], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) { console.error(`Omp-Wand: ${error.message}`); process.exitCode = 1; }
