import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ompw-install-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
const log = join(root, 'calls.log');
await mkdir(bin, { recursive: true });
await mkdir(home, { recursive: true });
// Fake CLIs record their arguments.
for (const cli of ['claude', 'codex', 'omp', 'node']) {
  await writeFile(join(bin, cli), `#!/bin/sh\necho "${cli} $*" >> "${log}"\nexit 0\n`);
  await chmod(join(bin, cli), 0o755);
}
// Fake Codex config: `mcp add` writes the server table the way codex does.
const codexHome = join(root, 'codex');
const codexConfig = join(codexHome, 'config.toml');
await mkdir(codexHome);
await writeFile(codexConfig, 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n');
await writeFile(join(bin, 'codex'), `#!/bin/sh\necho "codex $*" >> "${log}"\nif [ "$2" = add ]; then grep -q 'mcp_servers.omp-wand' "${codexConfig}" || printf '\\n[mcp_servers.omp-wand]\\ncommand = "node"\\n' >> "${codexConfig}"; fi\nexit 0\n`);
process.env.CODEX_HOME = codexHome;
process.env.HOME = home;
process.env.PATH = `${bin}:${process.env.PATH}`;
const { install, runtimeFiles } = await import('../install.mjs');
const dest = join(home, '.omp/agent/extensions/omp-wand');

test('copies the extension and registers with each CLI (remove, then add)', async () => {
  await install([]);
  assert.deepEqual((await readdir(dest)).sort(), [...runtimeFiles].sort());
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  const server = `${join(bin, 'node')} ${join(dest, 'mcp.mjs')}`;
  assert.deepEqual(calls, [
    'claude mcp remove --scope user omp-wand',
    `claude mcp add --scope user omp-wand -- ${server}`,
    'codex mcp remove omp-wand',
    `codex mcp add omp-wand -- ${server}`,
  ]);
});

test('Codex gets a long tool timeout and no per-call approval, once', async () => {
  await install(['--codex']);
  const config = await readFile(codexConfig, 'utf8');
  assert.match(config, /\[mcp_servers\.omp-wand\]\ncommand = "node"\ntool_timeout_sec = 900\ndefault_tools_approval_mode = "approve"\n/);
  assert.equal(config.match(/tool_timeout_sec/g).length, 1);
  assert.match(config, /\[mcp_servers\.other\]\ncommand = "a"/);
});

test('--claude limits registration to Claude Code', async () => {
  await rm(log);
  await install(['--claude']);
  assert.ok((await readFile(log, 'utf8')).trim().split('\n').every(line => line.startsWith('claude ')));
});

test.after(() => rm(root, { recursive: true, force: true }));
