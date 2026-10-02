import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { createHmac, timingSafeEqual } from 'node:crypto';

export class EventError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
export const invalid = message => { throw new EventError(-32602, message); };
export const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function keys(value, allowed) {
  if (!plain(value)) invalid('Expected an object');
  if (Object.keys(value).some(k => !allowed.includes(k))) invalid('Unknown argument');
}
export function secretKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) invalid('Invalid signing secret');
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) invalid('Invalid signing secret');
  return key;
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function signedHeaders(subscription, id, body, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const secrets = [subscription.secret];
  if (subscription.previousSecret && subscription.rotationUntil > now) secrets.push(subscription.previousSecret);
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': secrets.map(secret => 'v1,' + createHmac('sha256', secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')).join(' '),
    'X-MCP-Subscription-Id': subscription.id };
}

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(address, prefix, 'ipv6');
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function callbackUrl(value, origins) {
  let url;
  try { url = new URL(value); } catch { invalid('Invalid callback URL'); }
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !origins.includes(url.origin)) invalid('Callback requires an allowed HTTPS origin and hostname');
  return url;
}
export async function resolveCallback(url, resolver = lookup) {
  const addresses = await resolver(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new EventError(-32015, 'Callback endpoint rejected', { reason: 'invalid_address' });
  return addresses[0];
}

// DNS is checked on EVERY connection and pinned into lookup. TLS still verifies the original hostname.
// No redirects, connection pooling, cookies, proxy env variables, or application credentials.
export function createWebhookTransport(origins, { resolver = lookup, requester = request } = {}) {
  return async (value, body, headers) => {
    const url = callbackUrl(value, origins);
    let dnsTimer;
    const address = await Promise.race([resolveCallback(url, resolver), new Promise((_resolve, reject) => {
      dnsTimer = setTimeout(() => reject(new Error('Callback DNS timeout')), 5000);
    })]).finally(() => clearTimeout(dnsTimer));
    return new Promise((resolve, reject) => {
      let req;
      const deadline = setTimeout(() => req?.destroy(new Error('Callback timeout')), 10_000);
      try { req = requester(url, { method: 'POST', agent: false, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup: (_host, options, done) => options?.all ? done(null, [address]) : done(null, address.address, address.family) }, res => {
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > 8192) req.destroy(new Error('Callback response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
      }); } catch (error) { clearTimeout(deadline); reject(error); return; }
      req.on('error', error => { clearTimeout(deadline); reject(error); });
      req.end(body);
    });
  };
}
