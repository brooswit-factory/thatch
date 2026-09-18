import type { Delivery } from "../protocol/delivery.js";
import type { Frame } from "../protocol/frame.js";

/**
 * A connected client. Identity is a server-assigned UUID — the library imposes
 * no naming. Every header from the initialize request is held for the app to
 * use however it likes (including `authorization`/`cookie`: treat a connection
 * list as sensitive).
 */
export interface Connection {
  readonly id: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectedAt: number;
  /** Push a frame to this connection. Sugar for `mcp.send(id, frame)`, routed by id so a stale reference refuses cleanly. */
  send(frame: Frame): Promise<Delivery>;
  /** Disconnect this client. */
  close(): Promise<void>;
}

/** `stale`: the client went away without closing, and thatch reaped the session (see `McpOptions.reap`). */
export type DisconnectReason = "closed" | "error" | "stale";
