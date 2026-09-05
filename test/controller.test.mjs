import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'ompw-controller-'));
process.env.OMP_REMOTE_DIR = dir;
const socketPath = join(dir, `${process.pid}-feedbeef.sock`);
let status = { id: 'restart-session', instance_id: 'old-instance', revision: 4, status: 'idle', control: 'connected' };
const server = createServer(client => client.once('data', () => client.end(JSON.stringify({ result: status }) + '\n')));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
await chmod(socketPath, 0o600);
const { waitSessions } = await import('../controller.mjs');

test('wait detects a restarted session when revision is unchanged', async () => {
  setTimeout(() => { status = { ...status, instance_id: 'new-instance' }; }, 100);
  const result = await waitSessions({ session_ids: ['restart-session'], after: { 'restart-session': { revision: 4, instance_id: 'old-instance' } }, timeout_ms: 2000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.changed[0].instance_id, 'new-instance');
  assert.deepEqual(result.after['restart-session'], { revision: 4, instance_id: 'new-instance' });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});
