#!/usr/bin/env node
// Fake reasonix acp server for integration tests. Speaks a small subset of
// ACP JSON-RPC over stdio, driven by the FAKE_REASONIX_SCRIPT env var.
//
// The script is a JSON array of step objects executed in order after the
// first session/prompt arrives. Each step has the shape:
//   { type: "emit_text", text: "..." }
//   { type: "emit_tool_call", id: "...", name: "...", status: "..." }
//   { type: "request_gate", kind: "run_command", command: "ls" }       // expects "approve"
//   { type: "request_gate_expect_deny", kind: "run_command", command: "npm test" }
//   { type: "write_transcript", record: { ... } }
//   { type: "stderr", text: "..." }
//   { type: "crash", code: 137 }
//   { type: "sleep", ms: 100 }
// After all steps, the process exits 0 unless a "crash" step ran.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const transcriptPath = argValue("--transcript");
const script = (() => {
  try {
    return JSON.parse(process.env.FAKE_REASONIX_SCRIPT ?? "[]");
  } catch {
    return [];
  }
})();

let nextOutgoingId = 1;
const pendingResponses = new Map(); // id -> resolver
const lineBuffer = { buf: "" };

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function requestPermission(options) {
  const id = nextOutgoingId++;
  return new Promise((resolve) => {
    pendingResponses.set(id, resolve);
    send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { options } });
  });
}

function writeTranscript(record) {
  if (!transcriptPath) return;
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.appendFileSync(transcriptPath, JSON.stringify(record) + "\n", "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScript(sessionId) {
  for (const step of script) {
    switch (step.type) {
      case "emit_text": {
        notify("session/update", {
          sessionId,
          update: { type: "agent_message_chunk", content: { text: step.text }, channel: step.channel ?? "answer" },
        });
        break;
      }
      case "emit_tool_call": {
        notify("session/update", {
          sessionId,
          update: { type: "tool_call", id: step.id ?? "t1", name: step.name ?? "paperclip_addComment", status: step.status ?? "running" },
        });
        if (step.completeAs) {
          notify("session/update", {
            sessionId,
            update: { type: "tool_call_update", id: step.id ?? "t1", name: step.name ?? "paperclip_addComment", status: step.completeAs, isError: step.completeAs !== "completed" },
          });
        }
        break;
      }
      case "request_gate": {
        const reply = await requestPermission({ kind: step.kind, command: step.command, path: step.path, pathValue: step.path });
        process.stderr.write(`[fake-reasonix] gate ${step.kind} reply=${JSON.stringify(reply)}\n`);
        if (step.expectDecision && reply?.decision !== step.expectDecision) {
          notify("session/update", {
            sessionId,
            update: { type: "agent_message_chunk", content: { text: `UNEXPECTED:${reply?.decision}` }, channel: "answer" },
          });
        }
        break;
      }
      case "request_gate_expect_deny": {
        const reply = await requestPermission({ kind: step.kind, command: step.command, path: step.path, pathValue: step.path });
        if (reply?.decision !== "deny") {
          process.stderr.write(`[fake-reasonix] expected deny, got ${JSON.stringify(reply)}\n`);
          process.exit(2);
        }
        break;
      }
      case "write_transcript": {
        writeTranscript(step.record);
        break;
      }
      case "stderr": {
        process.stderr.write(step.text + "\n");
        break;
      }
      case "sleep": {
        await sleep(step.ms ?? 0);
        break;
      }
      case "crash": {
        process.exit(step.code ?? 1);
      }
      default: {
        process.stderr.write(`[fake-reasonix] unknown step: ${step.type}\n`);
      }
    }
  }
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lineBuffer.buf += chunk;
  let i;
  while ((i = lineBuffer.buf.indexOf("\n")) >= 0) {
    const line = lineBuffer.buf.slice(0, i);
    lineBuffer.buf = lineBuffer.buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session-1" } });
    } else if (msg.method === "session/prompt") {
      send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
      runScript("fake-session-1");
    } else if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const r = pendingResponses.get(msg.id);
      if (r) {
        pendingResponses.delete(msg.id);
        r(msg.result ?? { error: msg.error });
      }
    }
  }
});

process.on("SIGTERM", () => {
  process.stderr.write("[fake-reasonix] received SIGTERM\n");
  process.exit(143);
});
