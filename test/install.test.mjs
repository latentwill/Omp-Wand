import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'ompw-install-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
const codexHome = join(root, 'codex');
await mkdir(bin, { recursive: true });
await mkdir(home, { recursive: true });
await mkdir(codexHome, { recursive: true });
const codex = join(bin, 'codex');
await writeFile(codex, `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  if [ -f "$CODEX_TEST_CONFLICT" ]; then
    printf '{"command":"/tmp/unrelated-node","args":["/tmp/unrelated.mjs"]}\n'
    exit 0
  fi
  if [ -f "$CODEX_TEST_REGISTERED" ]; then
    printf '{"command":"%s","args":["%s"]}\n' "$CODEX_EXPECTED_NODE" "$CODEX_EXPECTED_MCP"
    exit 0
  fi
  echo "Error: No MCP server named 'omp-wand' found." >&2
  exit 1
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  if [ -f "$CODEX_TEST_FAIL" ]; then exit 1; fi
  touch "$CODEX_TEST_REGISTERED"
  exit 0
fi
exit 1
`);
await chmod(codex, 0o755);
const node = join(bin, 'node');
await writeFile(node, '#!/bin/sh\nexit 0\n'); await chmod(node, 0o755);
const omp = join(bin, 'omp');
await writeFile(omp, '#!/bin/sh\nexit 0\n'); await chmod(omp, 0o755);
process.env.HOME = home;
process.env.CODEX_HOME = codexHome;
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CODEX_TEST_REGISTERED = join(root, 'registered');
process.env.CODEX_TEST_FAIL = join(root, 'fail');
const destination = join(home, '.omp/agent/extensions/omp-wand');
process.env.CODEX_EXPECTED_NODE = node;
process.env.CODEX_EXPECTED_MCP = join(destination, 'mcp.mjs');
const { install } = await import(pathToFileURL(join(process.cwd(), 'install.mjs')).href);

test('failed MCP registration leaves retryable pending state and accepts exact absent response', async () => {
  await writeFile(process.env.CODEX_TEST_FAIL, 'fail');
  let failure;
  try { await install(); } catch (error) { failure = error; }
  assert.equal(await readFile(join(destination, '.omp-wand-install.pending'), 'utf8'), 'Omp-Wand installation in progress\n');
  await assert.rejects(stat(join(destination, '.omp-wand-install')));
  assert.ok(failure);
  await unlink(process.env.CODEX_TEST_FAIL);
  await install();
  assert.equal(await readFile(join(destination, '.omp-wand-install'), 'utf8'), 'Omp-Wand 1.0.0\n');
  await assert.rejects(stat(join(destination, '.omp-wand-install.pending')));
  // A completed install still verifies the exact native registration and updates owned files.
  await install();
  process.env.CODEX_TEST_CONFLICT = join(root, 'conflict');
  await writeFile(process.env.CODEX_TEST_CONFLICT, 'conflict');
  const runtime = join(destination, 'session.mjs');
  await writeFile(runtime, 'sentinel');
  await assert.rejects(install(), /unrelated MCP server/);
  assert.equal(await readFile(runtime, 'utf8'), 'sentinel');
});
