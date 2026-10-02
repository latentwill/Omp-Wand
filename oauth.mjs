import { createPublicKey, verify } from 'node:crypto';
import { plain } from './webhook.mjs';

// A resource-server adapter, not an authorization server. The approved provider owns login/PKCE.
// Public keys are pinned in private config; no issuer-controlled network fetch on a request path.
export function validateOAuth(config, publicOrigin) {
  if (!plain(config) || typeof config.issuer !== 'string' || new URL(config.issuer).protocol !== 'https:' || new URL(config.issuer).username || new URL(config.issuer).password || config.audience !== publicOrigin + '/mcp' || !Array.isArray(config.scopes) || !config.scopes.length || config.scopes.some(s => typeof s !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(s)) || !Array.isArray(config.keys) || !config.keys.length || config.keys.length > 16) throw new Error('Invalid OAuth resource configuration');
  const ids = new Set();
  for (const key of config.keys) {
    if (!plain(key) || key.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid || ids.has(key.kid) || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(k => Object.hasOwn(key, k)) || (key.use && key.use !== 'sig') || (key.alg && key.alg !== 'RS256')) throw new Error('Configure unique public RS256 signing keys');
    const publicKey = createPublicKey({ key, format: 'jwk' });
    if ((publicKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('RSA keys must be at least 2048 bits');
    ids.add(key.kid);
  }
}
function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid token encoding');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('Invalid token encoding');
  return bytes;
}
export function oauthSubject(token, config, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.'); if (parts.length !== 3) return null;
    const header = JSON.parse(decode(parts[0])), claims = JSON.parse(decode(parts[1]));
    if (!plain(header) || !plain(claims) || header.alg !== 'RS256' || header.crit !== undefined || (header.typ !== 'at+jwt' && header.typ !== 'application/at+jwt')) return null;
    const key = config.keys.find(k => k.kid === header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key, format: 'jwk' }), decode(parts[2]))) return null;
    const seconds = Math.floor(now / 1000);
    if (claims.iss !== config.issuer || !(claims.aud === config.audience || (Array.isArray(claims.aud) && claims.aud.includes(config.audience))) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) || !Number.isSafeInteger(claims.iat) || claims.iat > seconds || claims.exp - claims.iat > 3600 || typeof claims.scope !== 'string') return null;
    const scopes = claims.scope.split(' ');
    if (!config.scopes.every(s => scopes.includes(s))) return null;
    return claims.sub;
  } catch { return null; }
}
