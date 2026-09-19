import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, type StreamableHTTPReconnectionOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CHANNEL_METHOD } from "../protocol/method.js";
import type { Frame } from "../protocol/frame.js";
import { z } from "zod";

/**
 * Stands in for a Claude Code session: connects over streamable HTTP, lists and
 * calls tools, and collects channel frames as they arrive.
 */
export class FakeConnection {
  private frames: Frame[] = [];
  private waiters: Array<(f: Frame) => void> = [];
  private constructor(readonly client: Client, private readonly transport: StreamableHTTPClientTransport) {}

  static async connect(baseUrl: string | URL, opts: { path?: string; headers?: Record<string, string>; reconnectionOptions?: StreamableHTTPReconnectionOptions } = {}) {
    const url = new URL(opts.path ?? "/mcp", baseUrl);
    const headers = { ...(opts.headers ?? {}) };
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, ...(opts.reconnectionOptions ? { reconnectionOptions: opts.reconnectionOptions } : {}) });
    const client = new Client({ name: "fake-connection", version: "0" }, { capabilities: { experimental: { "claude/channel": {} } } });
    const fc = new FakeConnection(client, transport);
    client.setNotificationHandler(z.object({ method: z.literal(CHANNEL_METHOD), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), (n) => {
      const f = n.params as Frame; const w = fc.waiters.shift(); w ? w(f) : fc.frames.push(f);
    });
    // SDK types `sessionId?: string`; under exactOptionalPropertyTypes that is not `Transport`. Cast is the SDK's problem, not ours.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    return fc;
  }

  nextFrame(timeoutMs = 2000): Promise<Frame> {
    if (this.frames.length) return Promise.resolve(this.frames.shift()!);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("no channel frame within " + timeoutMs + "ms")), timeoutMs); this.waiters.push((f) => { clearTimeout(t); res(f); }); });
  }
  get sessionId(): string | undefined { return this.transport.sessionId; }
  async listTools() { return (await this.client.listTools()).tools; }
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const r = await this.client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    // MCP reports a tool that threw as a resolved result with isError:true, not a
    // protocol error. A test helper should make that a throw, or a failing tool
    // reads as a success.
    if (r.isError) throw new Error(`tool ${name} errored: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  async disconnect() { await this.transport.terminateSession().catch(() => {}); await this.client.close(); }
}
