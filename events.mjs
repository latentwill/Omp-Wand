import { createHash, randomUUID } from 'node:crypto';
import { EventError, callbackUrl, equal, invalid, keys, secretKey, signedHeaders } from './webhook.mjs';

const objectSchema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const sessionSchema = { type: 'string', minLength: 1, maxLength: 256 };
export const summaries = {
  'omp.job.completed': 'OMP run ended. Read the session to assess the result.',
  'omp.job.failed': 'OMP run ended with an agent error.',
  'omp.approval.needed': 'OMP is waiting for approval in the local terminal.',
};
export const eventDefinitions = Object.entries(summaries).map(([name, description]) => ({ name, description,
  delivery: ['webhook'], inputSchema: objectSchema({ session_id: sessionSchema }),
  payloadSchema: objectSchema({ session_id: sessionSchema, instance_id: { type: 'string', maxLength: 100 },
    revision: { type: 'integer', minimum: 0 }, summary: { type: 'string', maxLength: 160 } }) }));
const MAX_TTL = 24 * 60 * 60 * 1000;
const ROTATION_MS = 5 * 60 * 1000;
export function subscriptionId(owner, params) {
  // The only argument is session_id, so this is also canonical regardless of input key order.
  return 'sub_' + createHash('sha256').update(JSON.stringify([owner, params.delivery.url, params.name, params.arguments.session_id])).digest('hex');
}
function identity(owner, params, origins, authorize) {
  if (!Object.hasOwn(summaries, params.name)) throw new EventError(-32011, 'Unknown event', { kind: 'event' });
  keys(params.arguments, ['session_id']);
  const id = params.arguments.session_id;
  if (typeof id !== 'string' || !id || id.length > 256) invalid('An exact session_id is required');
  if (!authorize(owner, id)) throw new EventError(-32012, 'Session access denied');
  if (params.delivery?.mode !== 'webhook') invalid('Only webhook delivery is supported');
  callbackUrl(params.delivery.url, origins);
  return subscriptionId(owner, params);
}
export class Events {
  constructor({ store, transport, origins, authorize, now = Date.now, report = () => {} }) {
    Object.assign(this, { store, transport, origins, authorize, now, report });
    this.verifications = new Map(); this.chain = Promise.resolve();
  }
  serial(action) { const result = this.chain.then(action); this.chain = result.catch(() => {}); return result; }
  clean(state) {
    const now = this.now();
    state.subscriptions = state.subscriptions.filter(s => s.expires > now && this.authorize(s.owner, s.arguments.session_id));
    for (const s of state.subscriptions) if (s.rotationUntil <= now) { delete s.previousSecret; delete s.rotationUntil; }
    const ids = new Set(state.subscriptions.map(s => s.id));
    state.pending = state.pending.filter(p => ids.has(p.subscriptionId));
  }
  async subscribe(owner, params) {
    return this.serial(async () => {
      keys(params, ['name', 'arguments', 'delivery', 'cursor', 'ttlMs']);
      keys(params.delivery, ['mode', 'url', 'secret']);
      const id = identity(owner, params, this.origins, this.authorize);
      secretKey(params.delivery.secret);
      if (params.cursor !== undefined && params.cursor !== null) invalid('This event does not support replay; cursor must be null');
      if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) invalid('ttlMs must be a positive integer or null');
      const state = structuredClone(this.store.state); this.clean(state);
      const previous = state.subscriptions.find(s => s.id === id);
      if (!previous && state.subscriptions.length >= 256) throw new EventError(-32603, 'Subscription capacity reached');
      const secret = params.delivery.secret, url = params.delivery.url;
      const cacheKey = createHash('sha256').update(JSON.stringify([owner, url, secret])).digest('hex');
      const verifiedUntil = this.verifications.get(cacheKey) || 0;
      if (verifiedUntil <= this.now()) {
        const challenge = randomUUID(), body = JSON.stringify({ type: 'verification', challenge });
        try {
          const response = await this.transport(url, body, signedHeaders({ id, secret }, 'verify_' + randomUUID(), body, this.now()));
          if (response.status < 200 || response.status >= 300 || !equal(JSON.parse(response.text).challenge, challenge)) throw new Error('Challenge failed');
        } catch (error) { throw new EventError(-32015, 'Callback verification failed', { reason: error.data?.reason || (/timeout/i.test(error.message) ? 'timeout' : 'challenge_failed') }); }
        if (this.verifications.size >= 512) this.verifications.clear();
        this.verifications.set(cacheKey, this.now() + ROTATION_MS);
      }
      // Policy can change while awaiting the callback.
      if (!this.authorize(owner, params.arguments.session_id)) throw new EventError(-32012, 'Session access denied');
      const expires = this.now() + Math.min(params.ttlMs ?? MAX_TTL, MAX_TTL);
      const subscription = { id, owner, name: params.name, arguments: { session_id: params.arguments.session_id }, url, secret, expires };
      if (previous?.secret !== undefined && previous.secret !== secret) Object.assign(subscription, { previousSecret: previous.secret, rotationUntil: this.now() + ROTATION_MS });
      else if (previous?.rotationUntil > this.now()) Object.assign(subscription, { previousSecret: previous.previousSecret, rotationUntil: previous.rotationUntil });
      state.subscriptions = state.subscriptions.filter(s => s.id !== id); state.subscriptions.push(subscription);
      this.store.save(state);
      return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    });
  }
  unsubscribe(owner, params) {
    return this.serial(() => {
      keys(params, ['name', 'arguments', 'delivery']); keys(params.delivery, ['mode', 'url']);
      const id = identity(owner, params, this.origins, this.authorize);
      const state = structuredClone(this.store.state);
      state.subscriptions = state.subscriptions.filter(s => s.id !== id); this.clean(state); this.store.save(state);
      return {};
    });
  }
  ingest(event) {
    return this.serial(() => {
      keys(event, ['eventId', 'name', 'timestamp', 'data', 'cursor']);
      keys(event.data, ['session_id', 'instance_id', 'revision', 'summary']);
      if (!Object.hasOwn(summaries, event.name) || typeof event.eventId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.eventId) || event.cursor !== null || typeof event.timestamp !== 'string' || event.timestamp.length > 40 || !Number.isFinite(Date.parse(event.timestamp)) || typeof event.data.session_id !== 'string' || !event.data.session_id || event.data.session_id.length > 256 || typeof event.data.instance_id !== 'string' || !event.data.instance_id || event.data.instance_id.length > 100 || !Number.isSafeInteger(event.data.revision) || event.data.revision < 0) invalid('Invalid local event');
      const state = structuredClone(this.store.state); this.clean(state);
      const seen = state.seen.find(s => s.instanceId === event.data.instance_id);
      if (seen && seen.revision >= event.data.revision) return false;
      if (!seen && state.seen.length >= 4096) throw new Error('Source cursor capacity reached; archive old relay state before continuing');
      const matches = state.subscriptions.filter(s => s.name === event.name && s.arguments.session_id === event.data.session_id);
      if (state.pending.length + matches.length > 1024) throw new Error('Event outbox capacity reached');
      // Rebuild the entire envelope: no extra fields, no user/agent text, even from an old extension.
      const safeEvent = { eventId: event.eventId, name: event.name, timestamp: event.timestamp, cursor: null,
        data: { session_id: event.data.session_id, instance_id: event.data.instance_id, revision: event.data.revision, summary: summaries[event.name] } };
      for (const s of matches) state.pending.push({ subscriptionId: s.id, event: safeEvent, attempts: 0, due: this.now() });
      // TUI revisions are monotonic within an instance, including branch switches.
      // One watermark per instance prevents a large set of source rings evicting dedup receipts.
      if (seen) seen.revision = event.data.revision;
      else state.seen.push({ instanceId: event.data.instance_id, revision: event.data.revision });
      this.store.save(state);
      return true;
    });
  }
  drain() {
    return this.serial(async () => {
      const state = structuredClone(this.store.state); this.clean(state);
      // Bound each worker pass; unsubscribe and refresh can acquire the serial queue between passes.
      const pending = state.pending.find(p => p.due <= this.now());
      if (pending) {
        const subscription = state.subscriptions.find(s => s.id === pending.subscriptionId);
        // Recheck access immediately before every attempt. Each attempt has fresh DNS validation and signing.
        if (subscription && this.authorize(subscription.owner, subscription.arguments.session_id)) {
          const body = JSON.stringify(pending.event); let status = 0;
          try { status = (await this.transport(subscription.url, body, signedHeaders(subscription, pending.event.eventId, body, this.now()))).status; }
          catch {} // No callback URLs, secrets or response bodies in logs.
          pending.attempts++;
          const transient = status === 0 || status === 408 || status === 429 || status >= 500;
          if (transient && pending.attempts < 5) pending.due = this.now() + 1000 * 2 ** pending.attempts;
          else {
            state.pending = state.pending.filter(p => p !== pending);
            if (status === 410) state.subscriptions = state.subscriptions.filter(s => s.id !== subscription.id);
            if (status < 200 || status >= 300) this.report({ type: 'delivery_failed', status, attempts: pending.attempts });
          }
        }
      }
      this.clean(state); this.store.save(state);
    });
  }
}
