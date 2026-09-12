import { expect, test } from "bun:test";
import { legacyStdioDiscoveryResponse, legacyStdioRelayAction } from "../../src/index.js";

test("legacy stdio discovery preserves numeric/string IDs and requests legacy fallback", () => {
  for (const id of [0, 1, "discover-1"]) {
    expect(legacyStdioDiscoveryResponse({ jsonrpc: "2.0", id, method: "server/discover", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    } })).toEqual({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});

test("fresh agy startup drops only roots invalidation before a session, then forwards normally", () => {
  const discovery = { jsonrpc: "2.0", id: 1, method: "server/discover" };
  const roots = { jsonrpc: "2.0", method: "notifications/roots/list_changed" };
  expect(legacyStdioRelayAction(discovery, false)).toEqual({ type: "reply", message: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } } });
  expect(legacyStdioRelayAction(roots, false)).toEqual({ type: "ignore" });
  expect(legacyStdioRelayAction({ jsonrpc: "2.0", id: 2, method: "initialize" }, false)).toEqual({ type: "forward" });
  expect(legacyStdioRelayAction(roots, true)).toEqual({ type: "forward" });
  for (const method of ["notifications/initialized", "notifications/cancelled", "ping"]) {
    expect(legacyStdioRelayAction({ jsonrpc: "2.0", method }, false)).toEqual({ type: "forward" });
  }
  expect(legacyStdioRelayAction({ ...roots, id: 3 }, false)).toEqual({ type: "forward" });
  expect(legacyStdioRelayAction(null, false)).toEqual({ type: "forward" });
});

test("legacy discovery leaves initialization, tools, notifications, and malformed input alone", () => {
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "server/discover" },
    { jsonrpc: "2.0", id: null, method: "server/discover" },
    { jsonrpc: "1.0", id: 1, method: "server/discover" },
    { jsonrpc: "2.0", id: 1, result: {} },
    [], null, "server/discover",
  ]) expect(legacyStdioDiscoveryResponse(message)).toBeUndefined();
});
