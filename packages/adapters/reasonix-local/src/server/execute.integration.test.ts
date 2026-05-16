import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { startExecution } from "./execute.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FAKE_REASONIX = path.resolve(__dirname, "../../tests/fixtures/fake-reasonix.mjs");
const FAKE_MCP = path.resolve(__dirname, "../../tests/fixtures/fake-mcp.mjs");

let workspaceRoot = "";
let stateDir = "";

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-local-it-"));
  stateDir = path.join(workspaceRoot, ".paperclip-reasonix", "agent-test");
  await fs.mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
});

interface LogEntry {
  stream: "stdout" | "stderr";
  text: string;
}

function buildCtx(overrides: Partial<AdapterExecutionContext> = {}): { ctx: AdapterExecutionContext; logs: LogEntry[]; meta: AdapterInvocationMeta[] } {
  const logs: LogEntry[] = [];
  const meta: AdapterInvocationMeta[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "tester", adapterType: "reasonix_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      model: "deepseek-v4-flash",
      cwd: workspaceRoot,
      stateDir,
      env: { DEEPSEEK_API_KEY: "test-key" },
    },
    context: { issue: { id: "PAP-1", title: "Test" }, prompt: "do the thing" },
    onLog: async (stream, text) => { logs.push({ stream, text }); },
    onMeta: async (m) => { meta.push(m); },
    onSpawn: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
  return { ctx, logs, meta };
}

function deps(script: unknown[]) {
  return {
    spawnReasonix: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => {
      const childEnv = { ...env, FAKE_REASONIX_SCRIPT: JSON.stringify(script) };
      return spawn("node", [FAKE_REASONIX, ...args], { env: childEnv, cwd, stdio: ["pipe", "pipe", "pipe"] });
    },
    resolveMcpBin: () => ({ binPath: FAKE_MCP }),
    spawnOverrides: { mcpBin: FAKE_MCP },
  };
}

describe("execute integration (fake reasonix + fake mcp)", () => {
  it("happy path: emits text and extracts cost/usage from transcript", async () => {
    const { ctx, logs } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "emit_text", text: "hello world" },
      { type: "write_transcript", record: { type: "assistant_final", usage: { inputTokens: 10, outputTokens: 20 }, costUsd: 0.01, stopReason: "end_turn" } },
    ]));
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(result.costUsd).toBeCloseTo(0.01);
    expect(logs.some((l) => l.stream === "stdout" && l.text.includes("hello world"))).toBe(true);
    expect(result.sessionParams?.configFingerprint).toBeTypeOf("string");
  });

  it("auto-approves ls and git status, denies git push and npm test", async () => {
    const { ctx, logs } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "request_gate", kind: "run_command", command: "ls -la", expectDecision: "approve" },
      { type: "request_gate", kind: "run_command", command: "git status", expectDecision: "approve" },
      { type: "request_gate_expect_deny", kind: "run_command", command: "git push origin main" },
      { type: "request_gate_expect_deny", kind: "run_command", command: "npm test" },
      { type: "request_gate_expect_deny", kind: "path_access", path: "/etc/passwd" },
      { type: "request_gate_expect_deny", kind: "run_command", command: "find . -exec rm {} ;" },
      { type: "write_transcript", record: { type: "assistant_final", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 } },
    ]));
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    const denials = logs.filter((l) => l.stream === "stderr" && l.text.includes("auto-deny gate"));
    expect(denials.length).toBeGreaterThanOrEqual(4);
  });

  it("partial transcript recovery on crash", async () => {
    const { ctx } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "write_transcript", record: { type: "usage", inputTokens: 5, outputTokens: 7, costUsd: 0.003 } },
      { type: "stderr", text: "boom" },
      { type: "crash", code: 137 },
    ]));
    const result = await handle.promise;
    expect(result.exitCode).toBe(137);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(result.costUsd).toBeCloseTo(0.003);
    expect(result.errorMessage).toBeTruthy();
  });

  it("flags MCP-related tool failure as unhealthy via onLog", async () => {
    const { ctx, logs } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "emit_tool_call", id: "t1", name: "paperclip_addComment", status: "running", completeAs: "failed" },
      { type: "write_transcript", record: { type: "assistant_final", usage: { inputTokens: 1, outputTokens: 1 } } },
    ]));
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("mcp_unhealthy");
    expect(logs.some((l) => l.stream === "stderr" && l.text.includes("paperclip MCP tool"))).toBe(true);
  });

  it("cancel mid-run triggers SIGTERM ladder and reports cancelled", async () => {
    const { ctx } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "sleep", ms: 5000 },
    ]));
    setTimeout(() => handle.cancel("test cancel"), 100);
    const result = await handle.promise;
    expect(result.errorCode === "cancelled" || result.signal === "SIGTERM" || result.exitCode === 143).toBe(true);
  });

  it("classifies 429 stderr as transient_upstream", async () => {
    const { ctx } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "stderr", text: "deepseek api returned 429 rate limit" },
      { type: "crash", code: 1 },
    ]));
    const result = await handle.promise;
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("classifies missing DEEPSEEK_API_KEY stderr as missing_credentials", async () => {
    const { ctx } = buildCtx();
    const handle = startExecution(ctx, deps([
      { type: "stderr", text: "DEEPSEEK_API_KEY missing; unauthorized" },
      { type: "crash", code: 2 },
    ]));
    const result = await handle.promise;
    expect(result.errorCode).toBe("missing_credentials");
  });
});
