import { Elysia } from "elysia";
import { Registry } from "../registry/registry.js";
import { Sender, type Pushable } from "../channel/sender.js";
import type { Connection, DisconnectReason } from "../registry/connection.js";
import type { Frame } from "../protocol/frame.js";
import type { Delivery } from "../protocol/delivery.js";
import type { McpOptions, ReapOptions } from "./options.js";
import { Session } from "./session.js";

const SESSION_HEADER = "mcp-session-id";

/** What `mcp` exposes to daemon-side code. */
export interface McpHandle {
  connections: {
    list(): Connection[];
    get(id: string): Connection | undefined;
    has(id: string): boolean;
    count(): number;
    find(pred: (c: Connection) => boolean): Connection | undefined;
    filter(pred: (c: Connection) => boolean): Connection[];
  };
  send(id: string, frame: Frame): Promise<Delivery>;
  sendMany(ids: readonly string[], frame: Frame): ReturnType<Sender["sendMany"]>;
  sendAll(frame: Frame, opts?: { where?: (c: Connection) => boolean }): ReturnType<Sender["sendAll"]>;
  on(event: "connect", fn: (c: Connection) => void): () => void;
  on(event: "disconnect", fn: (c: Connection, reason: DisconnectReason) => void): () => void;
  once(event: "connect" | "disconnect"): Promise<Connection>;
  off(event: "connect" | "disconnect", fn: (...a: any[]) => void): void;
  closeAll(): Promise<void>;
}

function build(o: McpOptions) {
  const path = o.path ?? "/mcp";
  const registry = new Registry<Session>();
  const sender = new Sender(registry as unknown as Registry<Pushable>);
  const sessions = new Map<string, Session>(); // id → session
  const serverInfo = o.serverInfo ?? { name: "thatch", version: "0" };

  const closeById = async (id: string, reason: DisconnectReason = "closed") => {
    const s = sessions.get(id);
    if (s) { sessions.delete(id); registry.remove(id, reason); await s.close(); }
    if (!sessions.size) stopSweep();
  };

  // Stale-session reaping: runs only while there are sessions, and never holds the process open.
  const reap: Required<ReapOptions> | undefined = o.reap === false ? undefined
    : { detachGraceMs: 60_000, idleMs: 600_000, intervalMs: 15_000, ...(o.reap ?? {}) };
  let sweep: ReturnType<typeof setInterval> | undefined;
  const sweepOnce = async () => {
    const now = Date.now();
    for (const [id, s] of [...sessions]) if (s.isStale(now, reap!.detachGraceMs, reap!.idleMs)) await closeById(id, "stale");
  };
  const startSweep = () => {
    if (!reap || sweep) return;
    sweep = setInterval(() => { void sweepOnce(); }, reap.intervalMs);
    (sweep as { unref?: () => void }).unref?.();
  };
  function stopSweep() { if (sweep) { clearInterval(sweep); sweep = undefined; } }

  // Fresh connect (no sid: id is new, req must be the initialize POST) and resurrection
  // (sid: a caller-chosen id thatch no longer recognizes) both land here. Either way the
  // connection's headers come only from THIS request — a resurrection never inherits the
  // headers of whatever session used to hold that id.
  async function connectSession(req: Request, id: string, resurrected: boolean): Promise<Response> {
    if (!(await (o.auth ?? (() => true))(req))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const session = await Session.open({
      serverInfo, instructions: o.instructions, tools: o.tools ?? {}, sessionId: id, resurrected,
      connection: () => registry.get(id)!,
      onClose: () => { void closeById(id); },
    });
    registry.add(id, session, (cid) => {
      return {
        id: cid, headers, connectedAt: Date.now(),
        send: (frame: Frame) => sender.send(cid, frame),
        close: () => closeById(cid),
      };
    });
    sessions.set(id, session);
    startSweep();
    return session.handle(req);
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const sid = req.headers.get(SESSION_HEADER);
    if (sid) {
      const entry = registry.entry(sid);
      if (entry) return entry.handle.handle(req);
      if (!o.resurrectSessions) return new Response(JSON.stringify({ error: "unknown session" }), { status: 404, headers: { "content-type": "application/json" } });
      return connectSession(req, sid, true);
    }
    if (req.method !== "POST") return new Response("session required", { status: 400 });
    return connectSession(req, crypto.randomUUID(), false);
  }

  const handle: McpHandle = {
    connections: registry,
    send: (id, f) => sender.send(id, f),
    sendMany: (ids, f) => sender.sendMany(ids, f),
    sendAll: (f, opts) => sender.sendAll(f, opts),
    on: ((event: "connect" | "disconnect", fn: any) => registry.on(event, fn)) as McpHandle["on"],
    once: (event) => registry.once(event),
    off: ((event: "connect" | "disconnect", fn: any) => registry.off(event, fn)) as McpHandle["off"],
    closeAll: async () => { for (const c of registry.list()) await closeById(c.id); },
  };

  const plugin = new Elysia({ name: "thatch" }).all(path, (ctx) => fetchHandler(ctx.request));
  return { plugin, mcp: handle };
}

/**
 * Build a thatch MCP endpoint.
 *
 *   const { plugin, mcp } = thatch({ tools });
 *   const app = new Elysia().use(plugin).listen(3000);
 *   const c = await mcp.once("connect");
 *   await c.send({ content: "welcome", meta: {} });
 *
 * Every client is accepted and gets a UUID; it holds all its request headers.
 * Reject unwanted clients with an Elysia guard on the route, before this handler.
 */
export function thatch(o: McpOptions = {}): { plugin: Elysia; mcp: McpHandle } {
  const { plugin, mcp } = build(o);
  return { plugin: plugin as Elysia, mcp };
}
