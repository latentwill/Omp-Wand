import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { EventStore } from '../event-store.mjs';
import { Events, summaries } from '../events.mjs';
import { callbackUrl, createWebhookTransport, publicAddress, resolveCallback, secretKey, signedHeaders } from '../webhook.mjs';
import { EventEmitter } from 'node:events';

const origins = ['https://receiver.example'];
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64'); // Deterministic mock key only.
const subscribe = (extra = {}) => ({ name: 'omp.job.completed', arguments: { session_id: 'one' }, delivery: { mode: 'webhook', url: origins[0] + '/callback', secret }, ...extra });
const occurrence = (extra = {}) => ({ eventId: randomUUID(), name: 'omp.job.completed', timestamp: '2026-10-02T18:00:00Z', cursor: null,
  data: { session_id: 'one', instance_id: randomUUID(), revision: 42, summary: 'password=SECRET must never leave' }, ...extra });
function verify(body, headers, key = secret) {
  const signature = createHmac('sha256', Buffer.from(key.slice(6), 'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
  return headers['webhook-signature'].split(' ').includes('v1,' + signature);
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-events-')); let store = new EventStore(dir);
  t.after(async () => { if (!store.closed) store.close(); await rm(dir, { recursive: true, force: true }); });
  let clock = Date.parse('2026-10-02T18:00:00Z'), allowed = true, status = 200; const calls = [], reports = [];
  const transport = async (url, body, headers) => {
    calls.push({ url, body, headers }); assert.ok(verify(body, headers, options.key || secret));
    const payload = JSON.parse(body);
    if (payload.type === 'verification') return { status: 200, text: JSON.stringify({ challenge: payload.challenge }) };
    return { status, text: '{}' };
  };
  const make = () => new Events({ store, transport, origins, authorize: (owner, session) => allowed && ['alice', 'bob'].includes(owner) && session === 'one', now: () => clock, report: r => reports.push(r), ...options });
  let events = make();
  return { get events() { return events; }, get store() { return store; }, dir, calls, reports,
    advance(ms) { clock += ms; }, revoke() { allowed = false; }, status(s) { status = s; },
    restart() { store.close(); store = new EventStore(dir); events = make(); } };
}
test('subscriptions are verified, deterministic, persistent, isolated and idempotent', async t => {
  const f = await fixture(t); const a = await f.events.subscribe('alice', subscribe());
  assert.equal(a.cursor, null); assert.equal(a.truncated, false);
  assert.equal((await f.events.subscribe('alice', subscribe())).id, a.id); assert.equal(f.calls.length, 1);
  const b = await f.events.subscribe('bob', subscribe()); assert.notEqual(a.id, b.id);
  assert.equal((await stat(join(f.dir, 'events.json'))).mode & 0o777, 0o600);
  assert.throws(() => new EventStore(f.dir), /EEXIST/);
  f.restart(); assert.equal(f.store.state.subscriptions.length, 2);
  const stop = subscribe(); delete stop.delivery.secret;
  await f.events.unsubscribe('bob', stop); await f.events.unsubscribe('bob', stop);
  assert.equal(f.store.state.subscriptions[0].owner, 'alice');
  await f.events.unsubscribe('alice', stop); assert.equal(f.store.state.subscriptions.length, 0);
});
test('invalid names, arguments, keys, TTL, cursor and unauthorized sessions are rejected before networking', async t => {
  const f = await fixture(t);
  for (const params of [subscribe({ name: 'unknown' }), subscribe({ arguments: { session_id: 'other' } }), subscribe({ arguments: { session_id: 'one', extra: 1 } }), subscribe({ cursor: 'replay' }), subscribe({ ttlMs: 0 }), subscribe({ extra: true }), subscribe({ delivery: { ...subscribe().delivery, secret: 'whsec_AA==' } })]) await assert.rejects(f.events.subscribe('alice', params));
  await assert.rejects(f.events.subscribe('mallory', subscribe()), e => e.code === -32012);
  assert.equal(f.calls.length, 0);
  for (const key of ['abc', 'whsec_' + Buffer.alloc(23).toString('base64'), 'whsec_' + Buffer.alloc(65).toString('base64')]) assert.throws(() => secretKey(key));
});
test('wrong verification challenge, redirects, timeout and errors never activate delivery', async t => {
  for (const transport of [async () => ({ status: 200, text: '{"challenge":"wrong"}' }), async () => ({ status: 302, text: '{}' }), async () => { throw new Error('timeout'); }, async () => ({ status: 500, text: '{}' })]) {
    const f = await fixture(t, { transport });
    await assert.rejects(f.events.subscribe('alice', subscribe()), e => e.code === -32015 && ['challenge_failed', 'timeout'].includes(e.data.reason));
    assert.equal(f.store.state.subscriptions.length, 0);
  }
});
test('bounded TTL, expiration, revocation, unsubscribe and restart clean pending work', async t => {
  const f = await fixture(t);
  const sub = await f.events.subscribe('alice', subscribe({ ttlMs: 1000 }));
  await f.events.ingest(occurrence()); f.restart(); assert.equal(f.store.state.pending.length, 1);
  f.advance(1001); await f.events.drain(); assert.equal(f.store.state.pending.length, 0); assert.equal(f.store.state.subscriptions.length, 0);
  const none = await f.events.subscribe('alice', subscribe({ ttlMs: null })); assert.ok(none.refreshBefore);
  assert.notEqual(sub.refreshBefore, none.refreshBefore);
  await f.events.ingest(occurrence()); f.revoke(); await f.events.drain(); assert.equal(f.store.state.subscriptions.length, 0);
  assert.equal(f.calls.filter(c => !JSON.parse(c.body).type).length, 0);
});
test('delivery filters, redaction, stable retry IDs, fresh signatures and durable deduplication', async t => {
  const f = await fixture(t); await f.events.subscribe('alice', subscribe());
  await f.events.ingest(occurrence({ data: { session_id: 'other', instance_id: randomUUID(), revision: 1, summary: 'private' } }));
  assert.equal(f.store.state.pending.length, 0);
  const event = occurrence(); await f.events.ingest(event); await f.events.ingest(event); assert.equal(f.store.state.pending.length, 1);
  f.status(503); await f.events.drain(); f.restart(); await f.events.ingest(event); assert.equal(f.store.state.pending.length, 1);
  f.advance(3000); f.status(200); await f.events.drain();
  const deliveries = f.calls.filter(c => !JSON.parse(c.body).type);
  assert.equal(deliveries.length, 2); assert.equal(deliveries[0].body, deliveries[1].body);
  assert.equal(deliveries[0].headers['webhook-id'], event.eventId); assert.notEqual(deliveries[0].headers['webhook-signature'], deliveries[1].headers['webhook-signature']);
  assert.equal(JSON.parse(deliveries[0].body).data.summary, summaries[event.name]); assert.ok(!deliveries[0].body.includes('SECRET'));
  assert.equal(verify(deliveries[0].body + ' ', deliveries[0].headers), false);
  assert.equal(f.store.state.pending.length, 0);
});
test('retry attempts are bounded; 410 disables subscription and 413 never retries', async t => {
  for (const status of [410, 413, 400, 429, 503]) {
    const f = await fixture(t); await f.events.subscribe('alice', subscribe()); await f.events.ingest(occurrence()); f.status(status);
    for (let i = 0; i < 6; i++) { await f.events.drain(); f.advance(60_000); }
    assert.equal(f.calls.filter(c => !JSON.parse(c.body).type).length, status >= 500 || status === 429 ? 5 : 1);
    assert.equal(f.store.state.pending.length, 0); assert.equal(f.store.state.subscriptions.length, status === 410 ? 0 : 1);
  }
});
test('secret rotation verifies replacement, signs with both keys briefly, then erases old key', async t => {
  const key = 'whsec_' + Buffer.alloc(32, 8).toString('base64');
  const f = await fixture(t, { transport: async (_url, body, headers) => {
    assert.ok(verify(body, headers) || verify(body, headers, key));
    return { status: 200, text: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  } });
  const first = await f.events.subscribe('alice', subscribe());
  const second = await f.events.subscribe('alice', subscribe({ delivery: { ...subscribe().delivery, secret: key } })); assert.equal(first.id, second.id);
  const headers = signedHeaders(f.store.state.subscriptions[0], 'id', '{}', Date.parse('2026-10-02T18:00:00Z'));
  assert.ok(verify('{}', headers)); assert.ok(verify('{}', headers, key));
  f.advance(300_001); await f.events.drain(); assert.equal(f.store.state.subscriptions[0].previousSecret, undefined);
});
test('callback allowlist and IP policy block local/private/reserved IPv4 and IPv6 destinations', async () => {
  for (const url of ['http://receiver.example/a', 'https://evil.example/a', 'https://user:pass@receiver.example/a', 'https://receiver.example/a#x', 'https://receiver.example:444/a', 'https://127.0.0.1/']) assert.throws(() => callbackUrl(url, origins));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '192.0.2.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  await assert.rejects(resolveCallback(new URL(origins[0]), async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), e => e.data.reason === 'invalid_address');
});
test('HTTPS transport pins fresh DNS each time, preserves TLS hostname, and does not follow redirect', async () => {
  let resolved = 0, requests = 0;
  const transport = createWebhookTransport(origins, { resolver: async () => [{ address: ++resolved === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }],
    requester: (url, options, callback) => {
      requests++; assert.equal(url.hostname, 'receiver.example'); assert.equal(options.agent, false);
      options.lookup(url.hostname, {}, (_err, address) => assert.equal(address, '8.8.8.8'));
      const req = new EventEmitter(); req.end = () => { const res = new EventEmitter(); res.statusCode = 302; callback(res); queueMicrotask(() => res.emit('end')); }; return req;
    } });
  assert.equal((await transport(origins[0] + '/a', '{}', {})).status, 302);
  await assert.rejects(transport(origins[0] + '/a', '{}', {})); assert.equal(requests, 1);
});
test('store rejects unsafe files and symlinks without overwriting targets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'other'), 'sentinel', { mode: 0o600 }); await symlink(join(dir, 'other'), join(dir, 'events.json'));
  assert.throws(() => new EventStore(dir));
  await rm(join(dir, 'events.json')); await writeFile(join(dir, 'events.json'), '{}', { mode: 0o644 }); assert.throws(() => new EventStore(dir), /0600/);
});
