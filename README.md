# @brooswit/thatch

A central HTTP MCP server, as an [Elysia](https://elysiajs.com) plugin. Many Claude Code sessions connect to one server by URL; the server addresses them by name and can push messages into a live session.

```ts
import { Elysia } from "elysia";
import { thatch, z } from "@brooswit/thatch";

const { plugin, mcp } = thatch({
  tools: {
    status: { description: "Fleet status", input: {}, handler: (_a, c) => `hello ${c.id}` },
  },
});

const app = new Elysia().use(plugin).listen(3000);

// every client is accepted and gets a UUID; it holds all its request headers.
mcp.on("connect", (c) => console.log("connected", c.id, c.headers["x-workspace"]));

// address by a header predicate, then push into that session — from anywhere
const c = mcp.connections.find((c) => c.headers["x-workspace"] === "epic/KAN-39");
const d = await c?.send({ content: "PR #296 approved", meta: { key: "KAN-39" } });
//  d: { claim: "C2" }  — a connected session's stream took it
//     { claim: "refused", reason: "not-connected" | "no-channel-stream" | "bad-meta" | "closed-mid-send" }
```

Claude Code connects with:

```
claude mcp add --transport http fleet http://localhost:3000/mcp --header "x-workspace: epic/KAN-39"
```

## Receiving channel messages in Claude Code

thatch pushes `notifications/claude/channel`. For a session to *render* it, Claude Code must opt in:

- Launch it **interactively** (not `claude -p`) with `--channels server:<name>`, e.g.
  `claude --mcp-config mcp.json --channels server:thatch`. A pushed frame raises a permission
  prompt the user accepts; headless `-p` has no acceptor and skips channels.
- On claude.ai **Teams/Enterprise**, channel notifications are org-gated (default off) and the
  org must enable them; Console accounts default on.

`test/live/channel-render.md` is a by-hand proof. Everything up to the frame leaving the server is
covered by the automated suite; this last hop is interactive-only.

## Why the delivery type is not `void`

Pushing into a session can fail in ways the MCP SDK hides: a connection can be registered while its notification stream isn't attached, in which case the SDK drops the frame silently. `thatch` refuses that out loud (`no-channel-stream`) and only claims `C2` when a stream is actually there to carry the frame. `C3` (entered the transcript) and `C4` (the model read it) are not observable, so no API here pretends to them.

## API

- `thatch({ tools?, auth?, path?, history?, serverInfo?, resurrectSessions? })` → `{ plugin, mcp }`. Every client is accepted and assigned a UUID. Gate connections with `auth(req) => boolean` (default accepts all); it does not identify — an accepted client still gets a UUID and holds its headers.
- `instructions` (optional string) is returned to every client at initialize as MCP server instructions. Claude Code adds it to the model's context, so behaviour every caller should follow (for example, how to reply in chat) goes here once, not in each agent's setup.
- `mcp.connections`: `list()`, `get(id)`, `has(id)`, `count()`, `find(pred)`, `filter(pred)`.
- `mcp.send(id, frame)`, `mcp.sendMany(ids, frame)`, `mcp.sendAll(frame, { where? })`.
- `mcp.on/once/off` for `connect` / `disconnect`. The disconnect reason is `closed`, `error`, or `stale`.
- **Stale-session reaping** (`reap`, on by default): a client that dies without a DELETE never closes its transport, so thatch closes the session itself, emitting `disconnect` with reason `stale`. That happens once its notification stream has been down for `detachGraceMs` (default 60s) with no request since, or once a session that never opened a stream has had no requests for `idleMs` (default 10 min). An open stream or any request keeps a session alive, and a reaped client that returns gets 404, which is MCP's signal to re-initialize. Tune it with `thatch({ reap: { detachGraceMs, idleMs, intervalMs } })`, or turn it off with `reap: false`.
- **Session resurrection** (`resurrectSessions`, off by default): see "Surviving a server restart" below.
- A `Connection` carries `id`, `headers` (all of them), `connectedAt`, and methods `send(frame)` / `close()`. No built-in history, `lastSeenAt`, or readiness flag — subscribe to the `send` event and key it however you like; the `send` result tells you if a frame could not land.
- `import { FakeConnection } from "@brooswit/thatch/testing"` for tests.

## Surviving a server restart (LIBS-7)

Every session id a thatch server has ever handed out lives only in that process. After a
restart (or any redeploy that replaces the process), every one of those ids is unknown to
the new process, and by default the new process answers `404 {"error":"unknown session"}`
to any request that carries one — including the client's own background GET, the
long-lived stream a channel push needs to land on. Per the MCP transport spec, a client
that gets 404 is supposed to re-`initialize`, forgetting the old id. **Whether that actually
happens automatically depends entirely on what the client does when the stream drops**,
and here that's a mixed picture:

- Claude Code's MCP client is the SDK's `StreamableHTTPClientTransport`. When its
  standalone notification stream drops, it retries the same GET, with the same session id
  and headers, using exponential backoff — by default twice, at roughly 1s and 1.5s later,
  then it gives up silently, for good. **It opens that stream in exactly one place**: right
  after `notifications/initialized` gets a 202. A later successful request never reopens
  it.
- Only a **request** (not the standalone GET stream reconnecting on its own) drives a full
  client-side re-initialize — which is what opens a fresh stream. So without
  `resurrectSessions`, an otherwise-idle session's channel is silently unreachable until the
  caller happens to use it for something else, at which point a 404 forces the client
  through a full re-initialize and a fresh stream.

`thatch({ resurrectSessions: true })` closes part of this gap from the server side — **for
the standalone stream's GET reconnect only**: an unrecognized `mcp-session-id` on a GET
re-creates a session under that exact id instead of 404ing, provided the `auth` hook
accepts the new request (a rejection still answers 401, exactly as a fresh connect, and
never resurrects). The resurrected connection's `headers` come only from the request that
resurrected it — the old connection, whatever headers it held, is gone, so there's nothing
to reuse or guess.

**A POST or DELETE under an unrecognized id still 404s, even with this on.** That's
deliberate, not an oversight: since the SDK client only ever reopens its stream right after
its own `initialize` handshake, resurrecting a POST would make that request "succeed" with
no re-initialize — and thus no stream ever reopens. The session would stay registered but
permanently deaf, which is worse than today's 404. Only a GET is the client's own stream
literally trying to come back; that's the one case resurrection can help without cutting
off the client's self-healing path. So the net effect is:

- A restart that completes within the client's own retry window (a couple of seconds, by
  default): the GET retry reattaches with **no client-side change at all** — no
  re-initialize, no dropped push once reattached.
- A restart that takes longer: the GET retries are exhausted before the new process exists,
  so the stream stays dead until the client's next request — which still 404s (POST/DELETE
  aren't resurrected) and drives the same full re-initialize → fresh stream path that
  exists today, with or without this option.

It's off by default because even that narrower GET-only path works by marking a
freshly-constructed SDK transport as already having completed its handshake under a
caller-chosen id — a use of transport internals (`sessionId`, `_initialized`), not the
transport's public API — pinned by a test (`test/unit/end-to-end.test.ts`,
`describe("session resurrection (LIBS-7)")`) so an SDK upgrade that changes those internals
fails loudly here rather than silently stop working in production.

## Legacy stdio discovery fallback

`server/discover` is standardized in MCP 2026-07-28. Newer stdio clients probe it before the legacy `initialize` handshake and fall back when they receive JSON-RPC `-32601`. Thatch uses the legacy sessionful HTTP lifecycle; it does not claim modern stateless protocol support.

For a stdio-to-HTTP relay, call the shared helper before forwarding a request:

```ts
import { legacyStdioRelayAction } from "@brooswit/thatch";

const action = legacyStdioRelayAction(message, !!http.sessionId);
if (action.type === "reply") await stdio.send(action.message);
else if (action.type === "forward") await http.send(message);
```

The helper replies only to valid `server/discover` requests, preserving their IDs. It ignores `notifications/roots/list_changed` before an HTTP session exists: fresh agy startup emits this early, when no server session state needs invalidation. Once there is a session it forwards that notification normally. All other messages are forwarded. The lower-level `legacyStdioDiscoveryResponse(message)` remains available for discovery alone (response or `undefined`).

Neither helper creates a session, queues messages, or advertises modern capabilities. Handle this at the stdio boundary: HTTP initialization guards may reject sessionless messages before they reach Thatch. The HTTP plugin and its initialization rules are unchanged.

See the [MCP discovery specification](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) and [stdio backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).

## Layers

`protocol` (frame, delivery, method — pure) · `registry` (named connections + history) · `channel` (sending, honest claims) · `plugin` (the Elysia mount, one MCP server per connection) · `testing`.

## Scripts

```
bun run check        # generate load tests + typecheck + unit + load + coverage ≥90%
bun test test/unit
MCP_LIVE=1 bun test test/live   # against a real Claude Code session (opt-in)
```
