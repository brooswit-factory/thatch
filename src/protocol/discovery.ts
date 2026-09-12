import { isJSONRPCNotification, isJSONRPCRequest, type JSONRPCErrorResponse } from "@modelcontextprotocol/sdk/types.js";

/** Legacy stdio relays must answer the modern probe before forwarding to sessionful HTTP. */
export function legacyStdioDiscoveryResponse(message: unknown): JSONRPCErrorResponse | undefined {
  if (!isJSONRPCRequest(message) || message.method !== "server/discover") return undefined;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
}

export type LegacyStdioRelayAction =
  | { type: "reply"; message: JSONRPCErrorResponse }
  | { type: "ignore" }
  | { type: "forward" };

/** Apply before HTTP send; hasSession means the upstream transport has a session ID. */
export function legacyStdioRelayAction(message: unknown, hasSession: boolean): LegacyStdioRelayAction {
  const response = legacyStdioDiscoveryResponse(message);
  if (response) return { type: "reply", message: response };
  // Early roots invalidation has no server session state to invalidate. The client
  // can answer roots/list after initialization; do not queue a stale notification.
  if (!hasSession && isJSONRPCNotification(message) && message.method === "notifications/roots/list_changed") return { type: "ignore" };
  return { type: "forward" };
}
