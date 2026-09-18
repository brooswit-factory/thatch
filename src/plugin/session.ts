import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CHANNEL_CAPABILITY } from "../protocol/method.js";
import type { Pushable } from "../channel/sender.js";
import type { Connection } from "../registry/connection.js";
import type { ToolDef } from "./options.js";

/** One connected client: its own McpServer + transport. Implements Pushable for the channel. */
export class Session implements Pushable {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;

  /** True while the client holds an open server→client SSE stream (a GET). Only then can a pushed frame land. */
  channelAttached = false;
  /** When the client was last heard from (any request started or finished). Drives stale-session reaping. */
  lastActivity = Date.now();
  /** When the notification stream last dropped; undefined if it never attached. */
  detachedAt: number | undefined;
  /** Requests being handled right now. A session with one in flight is never stale. */
  inFlight = 0;
  private onAttachChange?: (attached: boolean) => void;

  private constructor(server: McpServer, transport: WebStandardStreamableHTTPServerTransport) {
    this.server = server; this.transport = transport;
  }

  onAttach(fn: (attached: boolean) => void): void { this.onAttachChange = fn; }

  static async open(opts: {
    serverInfo: { name: string; version: string };
    instructions?: string | undefined;
    tools: Record<string, ToolDef<any>>;
    connection: () => Connection;
    sessionId: string;
    onClose: () => void;
  }): Promise<Session> {
    const server = new McpServer(opts.serverInfo, {
      capabilities: { ...CHANNEL_CAPABILITY, tools: {} },
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    });
    for (const [name, def] of Object.entries(opts.tools)) {
      server.tool(name, def.description, def.input, async (args: unknown) => {
        const out = await def.handler(args as never, opts.connection());
        return { content: [{ type: "text" as const, text: typeof out === "string" ? out : JSON.stringify(out) }] };
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => opts.sessionId });
    transport.onclose = opts.onClose;
    await server.connect(transport);
    return new Session(server, transport);
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.server.server.notification({ method, params: params as Record<string, unknown> });
  }

  async handle(req: Request): Promise<Response> {
    this.lastActivity = Date.now(); this.inFlight++;
    let res: Response;
    try { res = await this.transport.handleRequest(req); }
    catch (e) { this.settle(); throw e; }
    if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) { this.settle(); return res; }
    // An SSE body outlives handleRequest: a POST's streams its tool result later, and a
    // GET's IS the standalone notification stream. Either way the request is in flight
    // until the body closes; a GET also marks the channel reachable while it lives.
    const isChannel = req.method === "GET";
    if (isChannel) this.setAttached(true);
    const reader = res.body.getReader();
    let settled = false;
    const done = () => { if (settled) return; settled = true; if (isChannel) this.setAttached(false); this.settle(); };
    const watched = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done: end, value } = await reader.read();
          if (end) { controller.close(); done(); } else controller.enqueue(value);
        } catch (e) { controller.error(e); done(); }
      },
      cancel(reason) { void reader.cancel(reason); done(); },   // client hung up
    });
    return new Response(watched, { status: res.status, headers: res.headers });
  }

  private settle(): void { this.inFlight--; this.lastActivity = Date.now(); }

  private setAttached(v: boolean): void {
    if (this.channelAttached === v) return;
    this.channelAttached = v;
    if (!v) this.detachedAt = Date.now();
    this.onAttachChange?.(v);
  }

  /**
   * A client that dies without a DELETE never fires the transport's onclose, so its
   * session would stay registered forever. It is stale when nothing is in flight, its
   * stream is not attached, and either the stream dropped `detachGraceMs` ago with no
   * request since, or it has been silent for `idleMs`.
   */
  isStale(now: number, detachGraceMs: number, idleMs: number): boolean {
    if (this.channelAttached || this.inFlight > 0) return false;
    const quiet = now - Math.max(this.lastActivity, this.detachedAt ?? 0);
    if (this.detachedAt !== undefined && quiet >= detachGraceMs) return true;
    return now - this.lastActivity >= idleMs;
  }
  async close(): Promise<void> { await this.transport.close().catch(() => {}); await this.server.close().catch(() => {}); }
}
export { z };
