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

- `thatch({ tools?, auth?, path?, history?, serverInfo? })` → `{ plugin, mcp }`. Every client is accepted and assigned a UUID. Gate connections with `auth(req) => boolean` (default accepts all); it does not identify — an accepted client still gets a UUID and holds its headers.
- `mcp.connections`: `list()`, `get(id)`, `has(id)`, `count()`, `find(pred)`, `filter(pred)`.
- `mcp.send(id, frame)`, `mcp.sendMany(ids, frame)`, `mcp.sendAll(frame, { where? })`.
- `mcp.on/once/off` for `connect` / `disconnect`.
- A `Connection` carries `id`, `headers` (all of them), `connectedAt`, and methods `send(frame)` / `close()`. No built-in history, `lastSeenAt`, or readiness flag — subscribe to the `send` event and key it however you like; the `send` result tells you if a frame could not land.
- `import { FakeConnection } from "@brooswit/thatch/testing"` for tests.

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
