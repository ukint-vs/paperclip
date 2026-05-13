import { describe, expect, it } from "vitest";
import { parseAcpEventLine } from "./parse-acp-event.js";

describe("parseAcpEventLine", () => {
  it("parses initialize notification", () => {
    const ev = parseAcpEventLine(JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: 1 } }));
    expect(ev).toEqual({ kind: "initialize", protocolVersion: 1 });
  });

  it("parses session/new", () => {
    const ev = parseAcpEventLine(JSON.stringify({ jsonrpc: "2.0", method: "session/new", params: { sessionId: "s1" } }));
    expect(ev).toEqual({ kind: "session_new", sessionId: "s1" });
  });

  it("parses session/update agent_message_chunk", () => {
    const ev = parseAcpEventLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { type: "agent_message_chunk", content: { text: "hi" }, channel: "answer" } },
    }));
    expect(ev).toEqual({ kind: "agent_message_chunk", text: "hi", channel: "answer" });
  });

  it("parses session/update tool_call", () => {
    const ev = parseAcpEventLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { type: "tool_call", id: "t1", name: "paperclip_addComment", status: "running", input: { issueId: "x" } } },
    }));
    expect(ev).toEqual({
      kind: "tool_call",
      toolCallId: "t1",
      name: "paperclip_addComment",
      status: "running",
      input: { issueId: "x" },
    });
  });

  it("parses session/update tool_call_update", () => {
    const ev = parseAcpEventLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { type: "tool_call_update", id: "t1", status: "completed", output: { ok: true } } },
    }));
    expect(ev).toEqual({
      kind: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      output: { ok: true },
      isError: false,
    });
  });

  it("parses outbound session/request_permission", () => {
    const ev = parseAcpEventLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { options: { kind: "run_command", command: "git push" } },
    }));
    expect(ev).toEqual({
      kind: "request_permission",
      requestId: 7,
      gateKind: "run_command",
      payload: { kind: "run_command", command: "git push" },
    });
  });

  it("falls back to raw for malformed JSON", () => {
    expect(parseAcpEventLine("not json")).toEqual({ kind: "raw", text: "not json" });
  });

  it("falls back to raw for unknown event shape", () => {
    expect(parseAcpEventLine(JSON.stringify({ foo: "bar" }))).toEqual({
      kind: "raw",
      text: JSON.stringify({ foo: "bar" }),
    });
  });
});
