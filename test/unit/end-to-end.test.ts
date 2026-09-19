import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { thatch, z, type McpHandle } from "../../src/index.js";
import { FakeConnection } from "../../src/testing/index.js";

function fresh(opts?: Parameters<typeof thatch>[0]) {
  const { plugin, mcp } = thatch({
    tools: {
      echo: { description: "echo", input: { text: z.string() }, handler: ({ text }, c) => ({ text, id: c.id, ws: c.headers["x-workspace"] ?? null }) },
      fail: { description: "throws", input: {}, handler: () => { throw new Error("boom"); } },
    },
    ...(opts ?? {}),
  });
  const app = new Elysia().use(plugin).listen(0);
  return { mcp, base: `http://localhost:${app.server!.port}`, stop: async () => { await mcp.closeAll(); app.stop(); } };
}
async function ready(mcp: McpHandle, base: string, headers?: Record<string, string>) {
  const c = await FakeConnection.connect(base, headers ? { headers } : {});
  const id = c.sessionId!;
  // wait until a pushed frame can land: send a NUL-marked probe until it is C2, then drain it
  for (let i = 0; i < 200 && (await mcp.send(id, { content: "\u0000", meta: {} })).claim !== "C2"; i++) await Bun.sleep(10);
  await c.nextFrame(50).catch(() => {});
  return c;
}

describe("thatch (uuid connections) end to end over real HTTP", () => {
  test("every client is accepted, gets a uuid, and holds its headers", async () => {
    const { mcp, base, stop } = fresh();
    const a = await FakeConnection.connect(base, { headers: { "x-workspace": "epic/KAN-39", authorization: "Bearer secret" } });
    expect(mcp.connections.count()).toBe(1);
    const c = mcp.connections.list()[0]!;
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.id).toBe(a.sessionId!);
    expect(c.headers["x-workspace"]).toBe("epic/KAN-39");
    expect(c.headers["authorization"]).toBe("Bearer secret"); // held as-is; connection list is sensitive
    expect(await a.callTool("echo", { text: "hi" })).toEqual({ text: "hi", id: c.id, ws: "epic/KAN-39" });
    await a.disconnect(); await stop();
  });

  test("server instructions reach the client at initialize, and are absent unless set", async () => {
    const withText = fresh({ instructions: "Reply inside the message's thread." });
    const a = await FakeConnection.connect(withText.base);
    expect(a.client.getInstructions()).toBe("Reply inside the message's thread.");
    await a.disconnect(); await withText.stop();
    const plain = fresh();
    const b = await FakeConnection.connect(plain.base);
    expect(b.client.getInstructions()).toBeUndefined();
    await b.disconnect(); await plain.stop();
  });

  test("find/filter by header; send by id and c.send both land; sendAll honours where", async () => {
    const { mcp, base, stop } = fresh();
    const a = await ready(mcp, base, { "x-role": "supervisor" });
    const b = await ready(mcp, base, { "x-role": "worker" });
    const sup = mcp.connections.find((c) => c.headers["x-role"] === "supervisor")!;
    expect(sup.id).toBe(a.sessionId!);
    expect(mcp.connections.filter((c) => c.headers["x-role"] === "worker").map((c) => c.id)).toEqual([b.sessionId!]);
    expect(await mcp.send(sup.id, { content: "by-id", meta: {} })).toEqual({ claim: "C2" });
    expect(await a.nextFrame()).toMatchObject({ content: "by-id" });
    expect(await sup.send({ content: "by-conn", meta: { k: "v" } })).toEqual({ claim: "C2" });
    expect(await a.nextFrame()).toEqual({ content: "by-conn", meta: { k: "v" } });
    expect((await mcp.sendAll({ content: "all", meta: {} }, { where: (c) => c.headers["x-role"] === "worker" })).sent).toEqual([b.sessionId!]);
    await a.disconnect(); await b.disconnect(); await stop();
  });

  test("refusals: bad meta, unknown id, and registered-but-no-stream", async () => {
    const { mcp, base, stop } = fresh();
    const a = await ready(mcp, base);
    const id = a.sessionId!;
    expect(await mcp.send(id, { content: "ok", meta: {} })).toEqual({ claim: "C2" });
    expect(await mcp.send(id, { content: "x", meta: { n: 1 as unknown as string } })).toMatchObject({ claim: "refused", reason: "bad-meta", keys: ["n"] });
    expect(await mcp.send("no-such-uuid", { content: "x", meta: {} })).toEqual({ claim: "refused", reason: "not-connected" });
    await a.disconnect(); await stop();
  });

  test("no-channel-stream: a session that never opens its stream refuses, not a false C2", async () => {
    const { mcp, base, stop } = fresh();
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "p", version: "0" } } }),
    });
    await r.text();
    const c = mcp.connections.list()[0]!;
    // no public channelReady flag — the send result is the honest signal
    expect(await c.send({ content: "x", meta: {} })).toEqual({ claim: "refused", reason: "no-channel-stream" });
    await stop();
  });

  test("connect/disconnect/once events; c.close() disconnects and a stale reference refuses", async () => {
    const { mcp, base, stop } = fresh();
    const seen: string[] = [];
    mcp.on("connect", (c) => seen.push("+" + c.id.slice(0, 4)));
    const off = mcp.on("disconnect", (c, r) => seen.push(`-${c.id.slice(0, 4)}:${r}`));
    const pending = mcp.once("connect");
    const a = await ready(mcp, base);
    expect((await pending).id).toBe(a.sessionId!);
    const c = mcp.connections.get(a.sessionId!)!;
    await c.close(); await Bun.sleep(30);
    expect(mcp.connections.has(a.sessionId!)).toBe(false);
    expect(await c.send({ content: "x", meta: {} })).toEqual({ claim: "refused", reason: "not-connected" }); // stale ref
    expect(seen.some((s) => s.startsWith("+"))).toBe(true);
    expect(seen.some((s) => s.includes(":closed"))).toBe(true);
    off();
    await a.disconnect().catch(() => {}); await stop();
  });

  test("a throwing tool is an error, not a crash; the connection stays", async () => {
    const { mcp, base, stop } = fresh();
    const a = await FakeConnection.connect(base);
    await expect(a.callTool("fail")).rejects.toThrow();
    expect(mcp.connections.count()).toBe(1);
    await a.disconnect(); await stop();
  });

  test("sendMany reports sent/refused by id", async () => {
    const { mcp, base, stop } = fresh();
    const a = await ready(mcp, base);
    expect(await mcp.sendMany([a.sessionId!, "ghost"], { content: "m", meta: {} })).toEqual({ sent: [a.sessionId!], refused: [{ id: "ghost", reason: "not-connected" }] });
    await a.disconnect(); await stop();
  });
});

describe("thatch auth hook", () => {
  test("auth returning false refuses the connection (401); true (default) accepts", async () => {
    const { plugin, mcp } = thatch({ auth: (req) => req.headers.get("x-key") === "let-me-in" });
    const app = new Elysia().use(plugin).listen(0);
    const base = `http://localhost:${app.server!.port}`;
    await expect(FakeConnection.connect(base, { headers: { "x-key": "nope" } })).rejects.toThrow();
    expect(mcp.connections.count()).toBe(0);
    const ok = await FakeConnection.connect(base, { headers: { "x-key": "let-me-in" } });
    expect(mcp.connections.count()).toBe(1);
    await ok.disconnect(); await mcp.closeAll(); app.stop();
  });
  test("an async auth hook is awaited", async () => {
    const { plugin, mcp } = thatch({ auth: async (req) => { await Bun.sleep(1); return req.headers.get("x-ok") === "1"; } });
    const app = new Elysia().use(plugin).listen(0);
    const base = `http://localhost:${app.server!.port}`;
    await expect(FakeConnection.connect(base, { headers: {} })).rejects.toThrow();
    const ok = await FakeConnection.connect(base, { headers: { "x-ok": "1" } });
    expect(mcp.connections.count()).toBe(1);
    await ok.disconnect(); await mcp.closeAll(); app.stop();
  });
});

describe("stale-session reaping", () => {
  const fast = { reap: { detachGraceMs: 100, idleMs: 400, intervalMs: 10 } } as const;
  // "is reaped" waits for it (a loaded box can lag the sweep); "not yet" checks run well inside the window
  const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(10); return cond(); };
  const init = (base: string) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "p", version: "0" } } }),
  }).then((r) => r.text());

  test("a client that dies with its stream open (no DELETE) is reaped as stale after the grace", async () => {
    const { mcp, base, stop } = fresh(fast);
    const reasons: string[] = [];
    mcp.on("disconnect", (_c, r) => reasons.push(r));
    const a = await ready(mcp, base);
    const id = a.sessionId!;
    await a.client.close();                       // process killed: stream drops, no terminateSession
    await Bun.sleep(20);
    expect(mcp.connections.has(id)).toBe(true);   // still inside the grace
    expect(await until(() => !mcp.connections.has(id))).toBe(true);
    expect(reasons).toEqual(["stale"]);
    expect(await mcp.send(id, { content: "x", meta: {} })).toEqual({ claim: "refused", reason: "not-connected" });
    await stop();
  });

  test("a session that never opens a stream is reaped after the idle TTL, not before", async () => {
    const { mcp, base, stop } = fresh(fast);
    await init(base);
    expect(mcp.connections.count()).toBe(1);
    await Bun.sleep(200);
    expect(mcp.connections.count()).toBe(1);      // past the detach grace, but it never attached: idle TTL applies
    expect(await until(() => mcp.connections.count() === 0)).toBe(true);
    await stop();
  });

  test("a live client with its stream attached is never reaped, and requests keep a streamless one alive", async () => {
    const { mcp, base, stop } = fresh(fast);
    const a = await ready(mcp, base);
    await Bun.sleep(600);
    expect(mcp.connections.has(a.sessionId!)).toBe(true);
    expect(await mcp.send(a.sessionId!, { content: "still here", meta: {} })).toEqual({ claim: "C2" });
    expect(await a.nextFrame()).toMatchObject({ content: "still here" });
    await init(base);
    const b = mcp.connections.list().find((c) => c.id !== a.sessionId!)!;
    const call = (n: number) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": b.id, "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/list", params: {} }),
    }).then((r) => r.text());
    for (let i = 0; i < 12; i++) { await call(10 + i); await Bun.sleep(50); }   // 600ms total, well past idleMs
    expect(mcp.connections.has(b.id)).toBe(true);
    await a.disconnect(); await stop();
  });

  test("a reaped client's next request gets 404 (the MCP signal to re-initialize)", async () => {
    const { mcp, base, stop } = fresh(fast);
    const a = await ready(mcp, base);
    const id = a.sessionId!;
    await a.client.close();
    expect(await until(() => !mcp.connections.has(id))).toBe(true);
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(r.status).toBe(404);
    await stop();
  });

  test("reap: false keeps a dead client's session registered", async () => {
    const { mcp, base, stop } = fresh({ reap: false });
    const a = await ready(mcp, base);
    await a.client.close();
    await Bun.sleep(300);                         // well past the grace the tests above reap within
    expect(mcp.connections.has(a.sessionId!)).toBe(true);
    await stop();
  });
});

describe("session resurrection (LIBS-7)", () => {
  const unknownId = "5f9c6f2e-0000-4000-8000-000000000000";
  // A tool call (POST) rather than the standalone GET stream: a resurrected session's
  // handling of it is identical either way, and unlike the GET stream — whose response
  // is a bare, long-lived SSE body with nothing written until the first push or keepalive
  // — a `tools/list` response completes right away, so `fetch()` resolves promptly.
  const call = (base: string, id: string, headers: Record<string, string> = {}) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": id, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  test("off by default: an unrecognized session id still 404s", async () => {
    const { mcp, base, stop } = fresh();
    const r = await call(base, unknownId);
    expect(r.status).toBe(404);
    await r.body?.cancel();
    expect(mcp.connections.has(unknownId)).toBe(false);
    await stop();
  });

  test("resurrectSessions: true re-creates a session under the SAME id, holding only the NEW request's headers", async () => {
    const { mcp, base, stop } = fresh({ resurrectSessions: true });
    const seen: string[] = [];
    mcp.on("connect", (c) => seen.push(c.id));
    const r = await call(base, unknownId, { "x-workspace": "epic/LIBS-7" });
    expect(r.status).toBe(200);
    await r.body?.cancel();
    expect(mcp.connections.has(unknownId)).toBe(true);
    const c = mcp.connections.get(unknownId)!;
    expect(c.headers["x-workspace"]).toBe("epic/LIBS-7");
    expect(c.headers["mcp-session-id"]).toBe(unknownId); // the resurrecting request's own headers, nothing carried over
    expect(seen).toEqual([unknownId]); // connect fires again, as for a fresh connect
    await stop();
  });

  test("auth rejecting the resurrecting request answers 401 and never resurrects", async () => {
    const { mcp, base, stop } = fresh({ resurrectSessions: true, auth: (req) => req.headers.get("x-key") === "let-me-in" });
    const r = await call(base, unknownId, { "x-key": "nope" });
    expect(r.status).toBe(401);
    await r.body?.cancel();
    expect(mcp.connections.has(unknownId)).toBe(false);
    const ok = await call(base, unknownId, { "x-key": "let-me-in" });
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    expect(mcp.connections.has(unknownId)).toBe(true);
    await stop();
  });

  // The regression this ticket is about: a client's automatic stream reconnect (the
  // StreamableHTTPClientTransport's own GET retry, unmodified) must reattach across a
  // full server restart — a brand-new thatch instance, same port, zero shared state —
  // with NO `initialize` from the client. Without `resurrectSessions` this test fails:
  // the retry lands on the new server and gets 404, same as the reap-then-404 test above.
  // `app1.stop(true)` force-closes the old server's live sockets — a keep-alive connection
  // left open (plain `.stop()`) would route the "retry" to the dead server's own listener,
  // masking the very restart this test exists to simulate.
  test("a client's stream survives a full server restart with no re-initialize", async () => {
    const opts: Parameters<typeof thatch>[0] = { resurrectSessions: true, tools: { echo: { description: "echo", input: { text: z.string() }, handler: ({ text }) => text } } };
    const { plugin: plugin1, mcp: mcp1 } = thatch(opts);
    const app1 = new Elysia().use(plugin1).listen(0);
    const port: number = app1.server!.port!;
    const a = await ready(mcp1, `http://localhost:${port}`);
    const id = a.sessionId!;
    await mcp1.closeAll();
    await app1.stop(true);

    const { plugin, mcp: mcp2 } = thatch(opts);
    const app2 = new Elysia().use(plugin).listen(port);
    try {
      const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(20); return cond(); };
      expect(await until(() => mcp2.connections.has(id))).toBe(true); // the client's own GET retry reattached this
      expect(mcp2.connections.get(id)!.id).toBe(id); // no re-initialize: the client never learned a new id
      expect(await mcp2.send(id, { content: "welcome back", meta: {} })).toEqual({ claim: "C2" });
      expect(await a.nextFrame()).toMatchObject({ content: "welcome back" });
    } finally {
      await mcp2.closeAll(); app2.stop();
      await a.disconnect().catch(() => {});
    }
  });
});
