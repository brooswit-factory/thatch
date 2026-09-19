# Changelog

All notable changes to `@brooswit/thatch`. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/`, `schema/` or `package.json` without a new entry here.

## Versioning — what the numbers mean in this project

- **MAJOR** — a restructuring or rewrite that breaks a lot of things, requiring reimplementation by consumers. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction that requires no consumer code changes, or very minor ones.

## [0.9.0] - 2026-09-18
### Added
- `thatch({ resurrectSessions: true })` (LIBS-7): opt-in server-side session resurrection. Off by default, a request carrying an `mcp-session-id` thatch doesn't recognize — e.g. every id after a restart — gets 404, forcing the client through a full re-`initialize` before its next request succeeds, and its background notification stream stays dead until then. With it on, such a request instead re-creates the session under that same id: the `auth` hook re-runs against the NEW request (a rejection still answers 401, and never resurrects), and the resurrected connection's `headers` come only from that new request — never the old, gone connection's. `connect` fires again, same as a fresh connection. Measured against a real client (the MCP SDK's `StreamableHTTPClientTransport`, which Claude Code embeds): it retries its dropped notification GET automatically, with the original session id and headers, for a couple of seconds before giving up — resurrection lets that retry reattach with no client-side change at all. See `README.md`'s restart-behaviour section.

## [0.8.0] - 2026-09-18
### Added
- `thatch({ instructions })`: an optional string returned to every client at initialize as MCP server instructions (the SDK's `ServerOptions.instructions`). Clients such as Claude Code put it in the model's context, so a server can state its usage norms once for every caller. It's omitted from the initialize result when unset, so existing servers behave exactly as before.

## [0.7.0] - 2026-09-18
### Added
- Stale-session reaping, on by default. A client whose process dies sends no DELETE, so its transport never closed and its connection stayed registered forever, refusing every push with `no-channel-stream`. thatch now closes such a session and emits `disconnect` with the new reason `"stale"`. That happens once its notification stream has been down for `detachGraceMs` (default 60s) with no request since, or once a session that never opened a stream has been silent for `idleMs` (default 10 min). An open stream or an in-flight request, including a streamed tool response, keeps a session alive. A reaped client that returns gets 404 and re-initializes. Configure it with `thatch({ reap: { detachGraceMs, idleMs, intervalMs } })`, or disable it with `reap: false`. New type export: `ReapOptions`.

### Changed
- `DisconnectReason` gains `"stale"`. A consumer that switches exhaustively on it needs the new case.

## [0.6.3] - 2026-09-11
### Fixed
- Export `legacyStdioRelayAction` to combine discovery fallback with ignoring `notifications/roots/list_changed` before the HTTP session exists. Fresh agy startup emits this notification before `initialize`; relaying it closes a sessionful transport. Other messages and roots notifications after session creation remain forwarded. No queue, session ownership, or stateless protocol support is added.

## [0.6.2] - 2026-09-11
### Fixed
- Export `legacyStdioDiscoveryResponse` for relays to answer the standardized `server/discover` probe with legacy `-32601` fallback before forwarding to a sessionful HTTP endpoint. This avoids closing newer stdio clients before `initialize`; it does not implement the 2026-07-28 stateless protocol or change the HTTP plugin's lifecycle.

## [0.6.1] - 2026-08-26
### Changed
- Repository moved to the brooswit-factory org; package.json repository/homepage/bugs URLs updated (npm provenance verifies repository.url against the building repo).

## [0.6.0] - 2026-08-24
### Removed
- The `send` event (`mcp.on("send", ...)`). A send is something you initiate and already get a `Delivery` back from synchronously, so the event was redundant to the caller; a central audit of sends is better done at your call sites or by wrapping `mcp.send`. `connect` and `disconnect` — which happen *to* you — remain.

## [0.5.0] - 2026-08-24
### Removed
- `connection.lastSeenAt` — convenience metadata nothing depended on; derive it from the `send` event if wanted.
- `connection.channelReady` (the public getter). Stream-attachment is still tracked internally — it is what keeps `C2` honest and lets `send` return `no-channel-stream` — but it is no longer exposed. Use the `send` result as the signal. (If the connect→send readiness race bites in practice, a `ready` event is the fix, not a pollable flag.)

## [0.4.0] - 2026-08-24
### Removed
- Per-connection send history (`connection.history`, the `history` option, `HistoryEntry`). The UUID redesign meant it no longer spanned a reconnect, which was its whole reason to exist; and the `send` event `(connection, frame, delivery)` lets an app build exactly the history it wants — keyed by a header so it *does* survive reconnect. The library version was strictly weaker, so it is gone.

## [0.3.0] - 2026-08-24
### Added
- `auth(req) => boolean | Promise<boolean>` option: a gate run when a client connects — return false to refuse it (401). Default accepts everyone. It is a gate, not identity: an accepted client still gets a UUID and holds its headers.

## [0.2.0] - 2026-08-24
### Changed
- Connections are identified by a server-assigned **UUID**, not a caller-supplied name. `identify` and `onDuplicate` are removed; every client is accepted (reject unwanted ones with an Elysia route guard before the handler). A connection now **holds all its request headers** (`connection.headers`, including `authorization`/`cookie` — treat a connection list as sensitive), and you address/find connections by id or by a header predicate.
### Added
- `connection.send(frame)` and `connection.close()`.
- `connections.find(pred)` / `connections.filter(pred)`; `mcp.once(event)` (promise) and `mcp.off(event, fn)`.
- Send history and `disconnect` reasons are now keyed by connection id (history no longer spans a reconnect — a new connection is a new id).

## [0.1.0] - 2026-08-24
### Added
- `thatch()` — an Elysia plugin + handle for a central HTTP MCP server that many Claude Code sessions connect to by URL.
- Named connections: `identify()` names each connection; `connections.{list,get,has,count,waitFor}`; `onDuplicate: "replace" | "reject"`.
- A channel that pushes `<channel>` frames into a session, addressed by name: `send`, `sendMany`, `sendAll`.
- `Delivery` — a discriminated union, never `void`. `C2` is claimed only when a client's notification stream is actually attached; a registered connection with no stream refuses as `no-channel-stream` rather than a false success. Non-string meta refuses as `bad-meta` instead of being silently dropped.
- Per-name send history (survives reconnect), events (`connect`/`disconnect`/`send`), and `connection.channelReady`.
- `@brooswit/thatch/testing` — `FakeConnection`, a Claude-Code stand-in over real HTTP.
