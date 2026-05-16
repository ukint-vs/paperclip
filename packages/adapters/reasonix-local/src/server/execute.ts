// Reasonix-local adapter — driver for `reasonix acp`.
//
//                              PAPERCLIP MONOREPO
// +-----------------------+
// | paperclip-server      |
// +-----------+-----------+
//             | adapter.execute(ctx)
//             v
// +-----------+-----------+         ACP JSON-RPC NDJSON (stdio)
// | adapter.execute()     |<------------------------------------+
// | (reasonix-local)      |                                     |
// | - spawns child        |                                     |
// | - speaks ACP client   |  spawn reasonix acp                 |
// | - auto-approves gates |  --mcp paperclip=<bin>              |
// |   per 1A allowlist    |  --transcript <state>/run.jsonl     |
// |   (read-only only)    |  --yolo --dir <cwd>                 |
// | - parses transcript   |  env HOME=<state>/home-overlay      |
// |   for cost/usage      |  env DEEPSEEK_API_KEY=...           |
// +-----------+-----------+                                     |
//             | child_process.spawn                             |
//             v                                                 |
// +-----------+-----------+                                     |
// | reasonix acp (child)  +-------------------------------------+
// +-----------+-----------+
//             | spawn (via --mcp)
//             v
// +-----------+-----------+
// | paperclip-mcp-server  |   stdio (MCP protocol)
// +-----------------------+

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_REASONIX_MODEL,
  DEFAULT_REASONIX_PRESET,
  DEFAULT_REASONIX_TIMEOUT_SEC,
} from "../index.js";
import { createAcpClient, type AcpClient } from "./acp-client.js";
import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_GIT_READONLY,
  evaluateGate,
  type GatePolicy,
} from "./gate-policy.js";
import { buildPaperclipPromptContext } from "./prompt-context.js";
import { resolveMcpServerBin } from "./test.js";

const SIGTERM_GRACE_MS = 5000;
const MCP_TOOL_PREFIX = "paperclip_";

export interface ReasonixSpawnOverrides {
  reasonixBin?: string;
  mcpBin?: string;
  extraArgs?: string[];
}

export interface ReasonixLocalExecuteDeps {
  spawnReasonix?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcessWithoutNullStreams;
  resolveMcpBin?: () => { binPath: string | null; error?: string };
  now?: () => number;
  spawnOverrides?: ReasonixSpawnOverrides;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  stopReason: string | null;
  hasAssistantFinal: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function configFingerprint(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16);
}

function classifyStderr(stderr: string): { family: AdapterExecutionErrorFamily | null; code: string | null } {
  const text = stderr.toLowerCase();
  if (/deepseek_api_key|api key.*missing|missing.*api key|unauthorized/.test(text)) {
    return { family: null, code: "missing_credentials" };
  }
  if (/\b429\b|rate.?limit|\b5\d\d\b|temporarily unavailable|network|econn|etimedout|fetch failed/.test(text)) {
    return { family: "transient_upstream", code: "transient_upstream" };
  }
  return { family: null, code: null };
}

async function readTranscriptIfExists(transcriptPath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(transcriptPath, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export function parseTranscriptForUsage(lines: string[]): UsageAccumulator {
  const acc: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    stopReason: null,
    hasAssistantFinal: false,
  };
  for (const line of lines) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const candidate = JSON.parse(line) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!parsed) continue;
    const type = asString(parsed.type, "");
    if (type === "assistant_final" || type === "result" || type === "session_end") {
      acc.hasAssistantFinal = acc.hasAssistantFinal || type === "assistant_final";
      const usage = parseObject(parsed.usage);
      acc.inputTokens += asNumber(usage.inputTokens ?? usage.input_tokens, 0);
      acc.outputTokens += asNumber(usage.outputTokens ?? usage.output_tokens, 0);
      acc.cachedInputTokens += asNumber(usage.cachedInputTokens ?? usage.cached_input_tokens, 0);
      acc.costUsd += asNumber(parsed.costUsd ?? parsed.cost_usd, 0);
      const stop = asString(parsed.stopReason ?? parsed.stop_reason, "");
      if (stop) acc.stopReason = stop;
    } else if (type === "usage") {
      acc.inputTokens += asNumber(parsed.inputTokens ?? parsed.input_tokens, 0);
      acc.outputTokens += asNumber(parsed.outputTokens ?? parsed.output_tokens, 0);
      acc.cachedInputTokens += asNumber(parsed.cachedInputTokens ?? parsed.cached_input_tokens, 0);
      acc.costUsd += asNumber(parsed.costUsd ?? parsed.cost_usd, 0);
    }
  }
  return acc;
}

function toUsage(acc: UsageAccumulator): UsageSummary | undefined {
  if (!acc.inputTokens && !acc.outputTokens && !acc.cachedInputTokens) return undefined;
  const usage: UsageSummary = { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens };
  if (acc.cachedInputTokens) usage.cachedInputTokens = acc.cachedInputTokens;
  return usage;
}

interface ResolvedConfig {
  model: string;
  preset: string;
  cwd: string;
  timeoutSec: number;
  env: Record<string, string>;
  mcpExtras: string[];
  commandAllowlistExtras: string[];
  gitReadOnlySubcommandsExtras: string[];
  instructionsFilePath: string | null;
  promptTemplate: string | null;
  stateDir: string;
}

function resolveStringEnv(envValue: unknown): Record<string, string> {
  const record = parseObject(envValue);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") {
      out[key] = raw;
      continue;
    }
    if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") out[key] = rec.value;
    }
  }
  return out;
}

function resolveConfig(ctx: AdapterExecutionContext): ResolvedConfig {
  const config = parseObject(ctx.config);
  const cwd = asString(config.cwd, "").trim() || process.cwd();
  const env = resolveStringEnv(config.env);
  return {
    model: asString(config.model, DEFAULT_REASONIX_MODEL),
    preset: asString(config.preset, DEFAULT_REASONIX_PRESET),
    cwd,
    timeoutSec: asNumber(config.timeoutSec, DEFAULT_REASONIX_TIMEOUT_SEC),
    env,
    mcpExtras: asStringArray(config.mcpExtras),
    commandAllowlistExtras: asStringArray(config.commandAllowlistExtras),
    gitReadOnlySubcommandsExtras: asStringArray(config.gitReadOnlySubcommandsExtras),
    instructionsFilePath: asString(config.instructionsFilePath, "").trim() || null,
    promptTemplate: asString(config.promptTemplate, "").trim() || null,
    stateDir: asString(config.stateDir, "").trim() ||
      path.join(cwd, ".paperclip-reasonix", `agent-${ctx.agent.id}`),
  };
}

function buildPolicy(resolved: ResolvedConfig): GatePolicy {
  const allow = new Set<string>(DEFAULT_COMMAND_ALLOWLIST);
  for (const extra of resolved.commandAllowlistExtras) allow.add(extra);
  const git = new Set<string>(DEFAULT_GIT_READONLY);
  for (const extra of resolved.gitReadOnlySubcommandsExtras) git.add(extra);
  return { cwd: resolved.cwd, commandAllowlist: allow, gitReadOnlySubcommands: git };
}

function buildPrompt(ctx: AdapterExecutionContext, resolved: ResolvedConfig): string {
  const context = parseObject(ctx.context);
  const data: Record<string, unknown> = {
    ...context,
    agent: { id: ctx.agent.id, companyId: ctx.agent.companyId, name: ctx.agent.name },
  };
  const rendered = resolved.promptTemplate ? renderTemplate(resolved.promptTemplate, data) : "";
  const paperclipContext = buildPaperclipPromptContext(ctx, { mcpToolPrefix: MCP_TOOL_PREFIX });
  return [paperclipContext, rendered, asString(context.prompt, "")]
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildEnv(resolved: ResolvedConfig, ctx: AdapterExecutionContext, homeOverlay: string): NodeJS.ProcessEnv {
  const paperclipEnv = buildPaperclipEnv(ctx.agent);
  return {
    ...process.env,
    ...paperclipEnv,
    ...resolved.env,
    HOME: homeOverlay,
  };
}

function defaultSpawnReasonix(args: string[], env: NodeJS.ProcessEnv, cwd: string, bin?: string): ChildProcessWithoutNullStreams {
  return spawn(bin ?? "reasonix", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
}

export interface ReasonixExecuteHandle {
  promise: Promise<AdapterExecutionResult>;
  cancel(reason?: string): void;
}

export function createReasonixLocalExecutor(deps: ReasonixLocalExecuteDeps = {}) {
  return {
    execute: (ctx: AdapterExecutionContext) => execute(ctx, deps),
    start: (ctx: AdapterExecutionContext) => startExecution(ctx, deps),
  };
}

export function execute(ctx: AdapterExecutionContext, deps: ReasonixLocalExecuteDeps = {}): Promise<AdapterExecutionResult> {
  return startExecution(ctx, deps).promise;
}

export function startExecution(ctx: AdapterExecutionContext, deps: ReasonixLocalExecuteDeps = {}): ReasonixExecuteHandle {
  let cancelFn: ((reason?: string) => void) | null = null;
  let cancelReason: string | null = null;
  const promise = runExecution(ctx, deps, (fn) => {
    cancelFn = fn;
    if (cancelReason && cancelFn) cancelFn(cancelReason);
  });
  return {
    promise,
    cancel(reason?: string) {
      const r = reason ?? "cancelled";
      if (cancelFn) cancelFn(r);
      else cancelReason = r;
    },
  };
}

interface ExecState {
  child: ChildProcessWithoutNullStreams | null;
  client: AcpClient | null;
  stderr: string;
  killed: boolean;
  killReason: string | null;
  mcpUnhealthy: boolean;
  timedOut: boolean;
}

async function runExecution(
  ctx: AdapterExecutionContext,
  deps: ReasonixLocalExecuteDeps,
  registerCancel: (fn: (reason?: string) => void) => void,
): Promise<AdapterExecutionResult> {
  const resolved = resolveConfig(ctx);
  const fingerprint = configFingerprint({
    model: resolved.model,
    preset: resolved.preset,
    cwd: resolved.cwd,
    mcpExtras: resolved.mcpExtras,
    allowlistExtras: resolved.commandAllowlistExtras,
    gitExtras: resolved.gitReadOnlySubcommandsExtras,
  });

  const homeOverlay = path.join(resolved.stateDir, "home-overlay");
  const transcriptPath = path.join(resolved.stateDir, "run.jsonl");
  await fs.mkdir(homeOverlay, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  let mcpBinPath: string | null = null;
  const mcpResolver = deps.resolveMcpBin ?? resolveMcpServerBin;
  const mcpResolution = mcpResolver();
  if (mcpResolution.binPath) {
    mcpBinPath = mcpResolution.binPath;
  } else if (deps.spawnOverrides?.mcpBin) {
    mcpBinPath = deps.spawnOverrides.mcpBin;
  } else {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `paperclip-mcp-server bin not resolvable: ${mcpResolution.error ?? "unknown"}`,
      errorCode: "mcp_server_unresolved",
    };
  }
  // Honor explicit test overrides above default resolution.
  if (deps.spawnOverrides?.mcpBin) mcpBinPath = deps.spawnOverrides.mcpBin;

  const policy = buildPolicy(resolved);
  const env = buildEnv(resolved, ctx, homeOverlay);
  const prompt = buildPrompt(ctx, resolved);

  const args = ["acp", "--dir", resolved.cwd, "--model", resolved.model, "--transcript", transcriptPath, "--yolo"];
  if (resolved.preset && resolved.preset !== DEFAULT_REASONIX_PRESET) args.push("--preset", resolved.preset);
  args.push("--mcp", `${MCP_TOOL_PREFIX.replace(/_$/, "")}=${mcpBinPath}`);
  args.push("--mcp-prefix", MCP_TOOL_PREFIX);
  for (const extra of resolved.mcpExtras) args.push("--mcp", extra);
  if (deps.spawnOverrides?.extraArgs) args.push(...deps.spawnOverrides.extraArgs);

  const loggedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") loggedEnv[key] = value;
  }
  await ctx.onMeta?.({
    adapterType: "reasonix_local",
    command: deps.spawnOverrides?.reasonixBin ?? "reasonix",
    commandArgs: args,
    cwd: resolved.cwd,
    env: loggedEnv,
    prompt,
  });

  const spawnFn = deps.spawnReasonix
    ?? ((a, e, c) => defaultSpawnReasonix(a, e, c, deps.spawnOverrides?.reasonixBin));
  const child = spawnFn(args, env, resolved.cwd);
  const state: ExecState = {
    child,
    client: null,
    stderr: "",
    killed: false,
    killReason: null,
    mcpUnhealthy: false,
    timedOut: false,
  };

  function killChild(reason: string): void {
    if (!state.child || state.killed) return;
    state.killed = true;
    state.killReason = reason;
    try {
      state.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const c = state.child;
    setTimeout(() => {
      try {
        if (!c.killed) c.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, SIGTERM_GRACE_MS).unref?.();
  }

  registerCancel((reason) => killChild(reason ?? "cancelled"));

  if (child.pid) {
    await ctx.onSpawn?.({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
  }

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    state.stderr += chunk;
    void ctx.onLog("stderr", chunk);
  });

  const client = createAcpClient({
    stdin: child.stdin,
    stdout: child.stdout,
    onProtocolError: (err) => {
      void ctx.onLog("stderr", `[reasonix-local] ${err.message}\n`);
    },
  });
  state.client = client;

  client.on("notification", (note) => {
    const method = typeof note.method === "string" ? note.method : "";
    const params = note.params && typeof note.params === "object" && !Array.isArray(note.params)
      ? (note.params as Record<string, unknown>)
      : null;
    if (method === "session/update" && params) {
      const update = params.update && typeof params.update === "object" && !Array.isArray(params.update)
        ? (params.update as Record<string, unknown>)
        : null;
      if (!update) return;
      const type = asString(update.type, "");
      if (type === "agent_message_chunk" || type === "text_delta") {
        const content = update.content && typeof update.content === "object" && !Array.isArray(update.content)
          ? (update.content as Record<string, unknown>)
          : null;
        const text = asString(content?.text ?? update.text, "");
        if (text) void ctx.onLog("stdout", text);
      } else if (type === "tool_call" || type === "tool_call_update") {
        void ctx.onMeta?.({
          adapterType: "reasonix_local",
          command: "reasonix",
          context: { kind: "tool_call_event", event: update },
        });
        if (type === "tool_call_update") {
          const status = asString(update.status, "");
          const name = asString(update.name, "");
          const isError = update.isError === true || status === "failed";
          if (isError && name.startsWith(MCP_TOOL_PREFIX)) {
            state.mcpUnhealthy = true;
            void ctx.onLog(
              "stderr",
              `[reasonix-local] paperclip MCP tool ${name} failed (status=${status}); the MCP server may have crashed.\n`,
            );
          }
        }
      }
    }
  });

  client.setRequestHandler("session/request_permission", (rawParams) => {
    const opts = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};
    const options = opts.options && typeof opts.options === "object" && !Array.isArray(opts.options)
      ? (opts.options as Record<string, unknown>)
      : opts;
    const kind = asString(options.kind, "");
    let decision;
    if (kind === "path_access") {
      decision = evaluateGate(
        { kind: "path_access", pathValue: asString(options.path ?? options.pathValue, "") },
        policy,
      );
    } else if (kind === "run_command") {
      decision = evaluateGate(
        { kind: "run_command", command: asString(options.command ?? options.cmd, "") },
        policy,
      );
    } else {
      decision = evaluateGate({ kind }, policy);
    }
    if (decision.decision === "deny") {
      void ctx.onLog(
        "stderr",
        `[reasonix-local] auto-deny gate kind=${kind || "unknown"}: ${decision.reason}\n`,
      );
    }
    return decision;
  });

  const timeoutMs = resolved.timeoutSec > 0 ? resolved.timeoutSec * 1000 : 0;
  let timeoutHandle: NodeJS.Timeout | null = null;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      state.timedOut = true;
      killChild(`timeout after ${resolved.timeoutSec}s`);
    }, timeoutMs);
    timeoutHandle.unref?.();
  }

  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code: code ?? null, signal: signal ?? null }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });

  (async () => {
    try {
      await client.call("initialize", { protocolVersion: 1 }, 10_000);
      await client.call("session/new", { cwd: resolved.cwd, model: resolved.model }, 10_000);
      await client.call("session/prompt", { sessionId: "fake-session-1", prompt }, 60_000);
    } catch (err) {
      void ctx.onLog("stderr", `[reasonix-local] acp lifecycle error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  })();

  const exitInfo = await closePromise;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  client.close();

  const transcriptLines = await readTranscriptIfExists(transcriptPath);
  const usage = parseTranscriptForUsage(transcriptLines);
  const classification = classifyStderr(state.stderr);

  const result: AdapterExecutionResult = {
    exitCode: exitInfo.code,
    signal: exitInfo.signal,
    timedOut: state.timedOut,
    usage: toUsage(usage),
    costUsd: usage.costUsd > 0 ? usage.costUsd : null,
    model: resolved.model,
    sessionParams: {
      configFingerprint: fingerprint,
      cwd: resolved.cwd,
      reasonixHome: homeOverlay,
    },
    sessionDisplayId: null,
    resultJson: usage.stopReason ? { stopReason: usage.stopReason } : null,
  };

  if (state.mcpUnhealthy) {
    result.errorMessage = "paperclip MCP server reported tool failures during the run; check stderr.";
    result.errorCode = "mcp_unhealthy";
  }

  if (classification.code) {
    result.errorCode = result.errorCode ?? classification.code;
    if (classification.family) result.errorFamily = classification.family;
  }

  if (state.timedOut) {
    result.errorMessage = result.errorMessage ?? `reasonix run exceeded timeout of ${resolved.timeoutSec}s`;
    result.errorCode = result.errorCode ?? "timeout";
  } else if (state.killed) {
    result.errorMessage = result.errorMessage ?? `reasonix run was cancelled: ${state.killReason}`;
    result.errorCode = result.errorCode ?? "cancelled";
  } else if ((exitInfo.code ?? 0) !== 0 && !result.errorMessage) {
    const tail = state.stderr.trim().split(/\n/).slice(-5).join("\n");
    result.errorMessage = `reasonix exited with code ${exitInfo.code ?? "?"}${tail ? `: ${tail}` : ""}`;
    if (!result.errorCode) result.errorCode = "nonzero_exit";
  }

  return result;
}
