import { isJSONRPCRequest, type JSONRPCErrorResponse } from "@modelcontextprotocol/sdk/types.js";

/** Legacy stdio relays must answer the modern probe before forwarding to sessionful HTTP. */
export function legacyStdioDiscoveryResponse(message: unknown): JSONRPCErrorResponse | undefined {
  if (!isJSONRPCRequest(message) || message.method !== "server/discover") return undefined;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
}
