#!/usr/bin/env node
// Fake paperclip MCP server. Speaks just enough MCP-ish JSON-RPC for the
// integration tests (the adapter never directly talks to it — the child
// reasonix would. The fixture exists so test.ts can resolve a working bin
// path on disk).

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

if (process.env.FAKE_MCP_CRASH === "1") {
  setTimeout(() => process.exit(99), 50);
}
