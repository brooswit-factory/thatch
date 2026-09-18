import type { z } from "zod";
import type { Connection } from "../registry/connection.js";

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  input: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, connection: Connection) => unknown | Promise<unknown>;
}

export interface McpOptions {
  /**
   * Accept or reject a connecting client. Return false to refuse it (401).
   * Sees the raw request, so it can read any header. Default: accept everyone.
   * This is a GATE, not identity — an accepted client still gets a UUID and
   * holds its headers.
   */
  auth?: (req: Request) => boolean | Promise<boolean>;
  /** Mount path. Default "/mcp". */
  path?: string;
  /** The tools. The ONLY way a tool exists. */
  tools?: Record<string, ToolDef<any>>;
  /** Reported to clients at initialize. */
  serverInfo?: { name: string; version: string };
  /**
   * Server instructions, returned to every client at initialize (MCP `instructions`).
   * Clients such as Claude Code add them to the model's context, so behaviour every
   * caller should follow belongs here rather than in each agent's own setup.
   */
  instructions?: string;
  /**
   * Close sessions whose client went away without saying so (a killed process sends no
   * DELETE, so the transport never closes). A reaped session emits `disconnect` with
   * reason `"stale"`; if its client does come back, it gets 404 and re-initializes.
   * `false` disables reaping. Any request, or an attached notification stream, keeps a
   * session alive.
   */
  reap?: false | ReapOptions;
}

export interface ReapOptions {
  /** How long after its notification stream drops, with no request since, a session is stale. Default 60s. */
  detachGraceMs?: number;
  /** How long a session with no stream and no requests may sit before it is stale. Default 10 min. */
  idleMs?: number;
  /** How often to check. Default 15s. */
  intervalMs?: number;
}
