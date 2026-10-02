# Optional MCP events

Wand's default installation remains a local, tools-only stdio MCP server. The optional
companion `relay.mjs` exposes the same six tools and three webhook events on one
authenticated `/mcp` endpoint using MCP 2.0 (`2026-07-28`). It does not replace the
local bridge or answer native approval dialogs.

Protocol references checked on 2026-10-02:

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Plugin quickstart](https://developers.openai.com/plugins/quickstart)
- [MCP HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [OpenAI authentication](https://developers.openai.com/plugins/build/auth)

## Events and boundaries

| Name | When it fires |
| --- | --- |
| `omp.job.completed` | An agent run settles. Completion means the run ended; read the session to assess success. |
| `omp.job.failed` | The final assistant message ends with an agent error. Intermediate tool failures that the agent recovers from do not fire this event. |
| `omp.approval.needed` | A new native tool approval becomes pending. It still requires local terminal interaction. |

Automatic continuations (`willContinue`) and aborted runs do not count as completed
runs. Streaming tokens and ordinary tool progress do not generate webhook events.
Repeated pending approval hooks and repeated terminal run notifications are suppressed.

Every subscription requires one exact `session_id`. Payloads contain only
`session_id`, `instance_id`, `revision`, and a fixed status `summary` (under 160
characters), inside the MCP event envelope (`eventId`, `name`, `timestamp`, `data`,
`cursor`). No transcript, approval reason, tool arguments, model name, project path,
or user-authored text enters the event payload. Read tools can still return sensitive
session content to an authorized account; a session grant permits all six tools,
including writes. Tool descriptions continue to require explicit human authorization
for prompts and interrupts. Do not grant a session to an untrusted account.

## Preparing live setup

No public endpoint, credentials, access grants, or plugin registration are created by
the installer or test suite. Before performing live setup, obtain approval for:

1. The public HTTPS hostname and proxy/tunnel provider, exposure of `/mcp`, and any
   hosting cost. The relay itself binds only to `127.0.0.1`.
2. Choosing/configuring an OAuth identity provider and creating any persistent client
   credentials or account mapping. ChatGPT's documented authenticated plugin flow is
   OAuth. The relay includes a resource-server adapter for RFC 9068 RS256 access JWTs;
   the provider must handle authorization-code + PKCE (`S256`), client registration,
   resource/audience binding and any approved login/client credentials. Static bearer
   auth is also available for private/manual clients, but is not a verified ChatGPT
   connection option.
3. The exact OMP session IDs the connected principal can read and control, and the
   actual HTTPS callback origin supplied by ChatGPT. Never guess or wildcard an origin.
4. Registering/installing the live personal plugin and creating a dot event task.

Once those decisions are approved:

- Install the current checkout with `node install.mjs`. Review any old `omp-remote`
  prototype installation first, as described in the main README. Run the relay from
  this checkout; it is deliberately not installed or started automatically.
- Enable the source hooks only in intended TUI terminals, for example
  `OMP_WAND_EVENTS=1 omp --resume EXACT_SESSION_ID`. An already running extension
  needs a normal idle exit/resume to load the updated code. `session_id` is the native
  saved-session ID; `instance_id` changes on extension restart.
- Create a private configuration file outside the repository, mode `0600`, and a
  state directory owned by the same OS user, mode `0700`. For the OAuth adapter, use:

```json
{
  "publicOrigin": "https://YOUR_APPROVED_WAND_HOST",
  "callbackOrigins": ["https://EXACT_CHATGPT_CALLBACK_ORIGIN"],
  "oauth": {
    "issuer": "https://YOUR_APPROVED_IDENTITY_PROVIDER",
    "audience": "https://YOUR_APPROVED_WAND_HOST/mcp",
    "scopes": ["wand"],
    "keys": [
      {
        "kty": "RSA", "kid": "ACTUAL_PROVIDER_KEY_ID", "alg": "RS256", "use": "sig",
        "n": "ACTUAL_PUBLIC_JWK_MODULUS", "e": "ACTUAL_PUBLIC_JWK_EXPONENT"
      }
    ]
  },
  "principals": [
    {
      "id": "owner",
      "subject": "EXACT_APPROVED_PROVIDER_SUBJECT",
      "sessionIds": ["EXACT_NATIVE_OMP_SESSION_ID"]
    }
  ]
}
```

These placeholders are not working configuration. Copy the public JWK from the
approved provider through a trusted admin workflow; never copy private key fields.
The adapter pins up to 16 public RSA keys (minimum 2048 bits). Rotate the pinned key
set when the provider rotates keys; unknown key IDs fail closed. It deliberately does
not fetch arbitrary `jku`/`x5u` URLs from tokens or discover signing keys during a call.

Require provider access tokens with `typ: at+jwt` (or `application/at+jwt`), `alg: RS256`,
the exact configured issuer and resource audience, `sub`, space-separated `scope`,
integer `iat`/`exp`, and a lifetime of at most one hour. `nbf` is enforced if present.
ID tokens, opaque access tokens, other algorithms, unknown subjects, expired tokens,
wrong issuers/audiences and insufficient scopes are rejected. Configure the provider's
metadata, exact ChatGPT redirect URL and client registration using the official auth
guide; the relay is not an authorization server. Its unauthenticated protected-resource
metadata endpoint is `/.well-known/oauth-protected-resource`; `401` responses point to
it and tool definitions declare OAuth scopes. If your provider does not issue this
token format, adapting its token verification is additional implementation work before
live use. Token revocation is bounded by token expiration; revoke the local subject's
session grant to stop both requests and persistent event delivery immediately.

For a manual private client only, omit `oauth` and replace each `subject` with a unique
`token`. Static tokens must be 32–256 ASCII letters, digits, underscores or hyphens,
generated with cryptographic randomness after approval. OAuth mode does not permit
static tokens as a fallback. Avoid shell history and logs when provisioning secrets.
Principal IDs and subject/token identities must be unique. Session IDs have no wildcard
syntax. Update the config atomically so readers do not observe partial writes.

```sh
OMP_WAND_RELAY_CONFIG=/absolute/private/relay-config.json \
OMP_WAND_RELAY_STATE=/absolute/private/relay-state \
OMP_WAND_RELAY_PORT=8787 node relay.mjs
```

- Configure the approved HTTPS reverse proxy on the Mac to forward `/mcp` and the
  public protected-resource metadata path to `127.0.0.1:8787`. Preserve the public
  `Host`, `Authorization`, `Origin`, and MCP
  headers; do not inject an authenticated identity or bypass bearer checks. Keep
  authorization headers and bodies out of proxy logs. Only HTTPS should be externally
  reachable. The relay trusts no forwarded identity headers and emits no CORS grants.
- Connect the personal plugin to `https://YOUR_APPROVED_WAND_HOST/mcp` using the
  approved OAuth provider. Rescan tools/events after updates. MCP requests
  use per-request `_meta`, `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for
  tool calls; every modern result has `resultType: "complete"`. The endpoint has no
  legacy initialize handshake, GET stream, or protocol session ID.
- Ask a Work Cloud chat or dot to watch one event for one allowed session, including
  what to do when it arrives. For example, report completion without sending another
  prompt. Confirm subscription, callback verification, webhook receipt, and dot action.

## Subscription and delivery behavior

`events/list`, `events/subscribe`, and `events/unsubscribe` share the authenticated
tool endpoint. Both tools and events enforce the principal's session allowlist.
Subscriptions are identified by the canonical tuple of principal, exact callback URL,
event name, and exact session ID. Repeating a subscription refreshes it; unsubscribing
with the original tuple is idempotent. Another principal cannot remove it.

The relay grants a maximum/default lifetime of 24 hours. Positive `ttlMs` requests are
honored up to that limit; `ttlMs: null` still receives a finite expiration. Delivery
stops at expiration. ChatGPT must refresh before `refreshBefore`.

Callbacks must be HTTPS on port 443, on an explicitly allowed origin, with no userinfo,
fragment, or IP-literal host. Verification and delivery resolve DNS on every new
connection, reject any local/private/reserved answer, and pin the validated address
while retaining hostname TLS verification. Redirects are never followed. DNS is
bounded to five seconds, HTTPS requests to ten seconds, and callback responses to
8 KiB. Do not weaken this policy to test a local callback; tests inject mocks.

Each callback is verified using a signed, fresh challenge before application data is
sent. The challenge response must be `2xx` and match in constant time. Verification
is cached in memory for five minutes per principal, URL and secret. Failures return
`-32015` with a categorized reason. Signing secrets must use `whsec_` and decode to
24–64 bytes. Standard Webhooks HMAC-SHA256 covers `webhook-id.webhook-timestamp.body`;
the exact serialized UTF-8 body is sent once. Secret replacement verifies the new key
and signs with both keys for a five-minute rotation window, then discards the old key.

The outbox persists before transmission. Transient network errors, `408`, `429`, and
`5xx` responses retry with exponential backoff (2, 4, 8, 16 seconds), at most five
attempts. Each retry keeps its event ID/body and uses a fresh signing time/signature.
`410` removes the subscription; `413` and other permanent errors drop that delivery
without retry. Logs report only categorized status/count information. A `2xx` confirms
receipt, not execution of the dot's task. A crash after receipt but before saving the
ack can cause duplicate delivery; receivers must deduplicate event IDs. Write tools
retain Wand's existing live-instance request-ID protections.

Subscription secrets, pending payloads and per-instance source revision watermarks
are stored atomically in `events.json` (0600), with file and directory fsync. One relay
process owns a directory via `relay.lock`. A crash can leave a lock: verify that the
recorded PID is no longer the relay before manually removing that lock. Never run two
processes against the same state directory. Storage is bounded to 256 subscriptions,
1024 pending deliveries and 4096 source instances; capacity errors fail closed. Before
archiving/resetting old state at the source-instance limit, stop the relay, preserve
pending work, and have clients unsubscribe/resubscribe. Treat state backups as secrets.

Principal and session authorization are re-read from the private config on each
request and before delivery. Remove a principal or session grant to revoke access;
the next worker pass removes related subscriptions/outbox records. Static token rotation
changes login access; subscriptions owned by the same retained principal continue.
Keep at least one principal in a valid config, with an empty `sessionIds` array if all
access is revoked. A malformed config stops request processing and delivery while
preserving existing subscription/outbox state. Restart
the relay after changing `publicOrigin` or `callbackOrigins`. `/remote off` retains its
existing behavior: it pauses local writes but not reads or events. Disable event source
hooks or unsubscribe to stop event monitoring.

## Reliability and tests

The TUI keeps the latest 128 events in memory. The companion collects those local
socket records once per second, then uses persistent revision watermarks to avoid
re-enqueueing them. This is a bounded local handoff; MCP advertises **no replay**
(`cursor: null`). Buffered events retain their original session IDs across TUI session
switches; the relay applies authorization and filters to those IDs. Closing the terminal,
a long relay outage, or more than 128 events between collections can lose source
events. Revisions and instance IDs let a reader identify current state, but missed
events cannot be recovered through this protocol. Keep the Mac awake and the relay
running; use read tools to reconcile after interruptions. There is no token streaming,
MCP polling/streaming, or unsupported `gap`/`terminated` notification.

Run `npm test`. Tests use deterministic ephemeral mock keys, temporary directories,
private Unix sockets, loopback HTTP, mock DNS and mock HTTPS callbacks. An ephemeral
RSA key simulates an OAuth provider without creating persistent credentials. Tests cover
subscriptions, verification, signatures/tampering, owner isolation, URL/IP rejection,
DNS pinning, retries, deduplication, key rotation, TTL/revocation, restart persistence,
OAuth metadata/JWT claims, source lifecycle and the existing stdio/installer behavior. No model calls, public
listeners or permanent credentials are needed.

The tested local integration path does not prove a live dot wakeup. After live setup,
verify all three events, a nonmatching session, refresh across relay restart,
unsubscribe, revoked access and exactly one expected dot response to a matching event.
If actions write to Wand, ensure the task cannot create a self-triggering prompt loop.

To stop/remove this integration, unsubscribe event tasks, stop the relay, disable its
approved proxy, revoke the plugin credential, and remove secret configuration/state
only after checking pending work. The original local stdio bridge continues to work.
