import { exec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { REQUIRED_REASONIX_VERSION } from "../index.js";

const require = createRequire(import.meta.url);

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export function parseSemver(text: string): [number, number, number] | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

export function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

interface ExecOnceOptions {
  command: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface ExecOnceResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export function execOnce(opts: ExecOnceOptions): Promise<ExecOnceResult> {
  return new Promise((resolve) => {
    exec(opts.command, { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 5000 }, (err, stdout, stderr) => {
      const codeFromErr = err && typeof (err as NodeJS.ErrnoException).code === "number"
        ? ((err as NodeJS.ErrnoException).code as unknown as number)
        : err ? 1 : 0;
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        exitCode: codeFromErr,
        error: err ? err.message : undefined,
      });
    });
  });
}

export interface ReasonixVersionProbe {
  (): Promise<ExecOnceResult>;
}

export interface ResolveMcpBinResult {
  binPath: string | null;
  source: string | null;
  error?: string;
}

export function resolveMcpServerBin(): ResolveMcpBinResult {
  try {
    const pkgPath = require.resolve("@paperclipai/mcp-server/package.json");
    const pkgRoot = path.dirname(pkgPath);
    const pkg = require(pkgPath) as Record<string, unknown>;
    const bin = pkg.bin;
    let binEntry: string | null = null;
    if (typeof bin === "string") {
      binEntry = bin;
    } else if (bin && typeof bin === "object") {
      const map = bin as Record<string, unknown>;
      const preferred = map["paperclip-mcp-server"];
      if (typeof preferred === "string") binEntry = preferred;
      else {
        const first = Object.values(map).find((value): value is string => typeof value === "string");
        if (first) binEntry = first;
      }
    }
    if (!binEntry) {
      return { binPath: null, source: pkgPath, error: "@paperclipai/mcp-server has no bin entry" };
    }
    return { binPath: path.resolve(pkgRoot, binEntry), source: pkgPath };
  } catch (err) {
    return {
      binPath: null,
      source: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function readDeepseekApiKeyFromFile(homeDir: string): Promise<boolean> {
  const candidate = path.join(homeDir, ".reasonix", "config.json");
  try {
    const text = await fs.readFile(candidate, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const rec = parsed as Record<string, unknown>;
    return isNonEmpty(rec.apiKey) || isNonEmpty(rec.deepseekApiKey);
  } catch {
    return false;
  }
}

export interface TestEnvironmentDeps {
  probeReasonixVersion?: ReasonixVersionProbe;
  resolveMcpBin?: () => ResolveMcpBinResult;
  homeDir?: string;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  deps: TestEnvironmentDeps = {},
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const envConfig = parseObject(config.env);

  const probe = deps.probeReasonixVersion ?? (() => execOnce({ command: "reasonix --version" }));
  const versionResult = await probe();
  if (versionResult.error || versionResult.exitCode !== 0) {
    checks.push({
      code: "reasonix_binary_missing",
      level: "error",
      message: "`reasonix --version` failed.",
      detail: versionResult.stderr.trim() || versionResult.error || `exit ${versionResult.exitCode}`,
      hint: "Install Reasonix on the Paperclip host or expose it on PATH (npm/pnpm link the local fork during development).",
    });
  } else {
    const parsed = parseSemver(`${versionResult.stdout} ${versionResult.stderr}`);
    const required = parseSemver(REQUIRED_REASONIX_VERSION);
    if (!parsed) {
      checks.push({
        code: "reasonix_version_unparseable",
        level: "warn",
        message: "Could not parse reasonix --version output.",
        detail: versionResult.stdout.trim() || versionResult.stderr.trim(),
      });
    } else if (required && !semverGte(parsed, required)) {
      checks.push({
        code: "reasonix_version_too_old",
        level: "error",
        message: `reasonix ${parsed.join(".")} is older than the required ${REQUIRED_REASONIX_VERSION}.`,
        hint: "Upgrade Reasonix and try again.",
      });
    } else {
      checks.push({
        code: "reasonix_version_ok",
        level: "info",
        message: `Reasonix version ${parsed.join(".")} satisfies the required minimum.`,
      });
    }
  }

  const resolver = deps.resolveMcpBin ?? resolveMcpServerBin;
  const mcpBin = resolver();
  if (!mcpBin.binPath) {
    checks.push({
      code: "reasonix_mcp_server_unresolved",
      level: "error",
      message: "Could not resolve @paperclipai/mcp-server bin entry.",
      detail: mcpBin.error ?? null,
      hint: "Run pnpm install at the workspace root so paperclip-mcp-server is built and resolvable.",
    });
  } else {
    let binStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      binStat = await fs.stat(mcpBin.binPath);
    } catch {
      // ignore — null binStat handled below
    }
    if (!binStat || !binStat.isFile()) {
      checks.push({
        code: "reasonix_mcp_server_bin_missing",
        level: "error",
        message: "Resolved paperclip MCP server binary does not exist on disk.",
        detail: mcpBin.binPath,
        hint: "Run `pnpm --filter @paperclipai/mcp-server build` to produce dist/stdio.js.",
      });
    } else {
      checks.push({
        code: "reasonix_mcp_server_resolved",
        level: "info",
        message: "paperclip-mcp-server bin resolved.",
        detail: mcpBin.binPath,
      });
    }
  }

  const configuredKey = typeof envConfig.DEEPSEEK_API_KEY === "string" ? envConfig.DEEPSEEK_API_KEY : "";
  if (isNonEmpty(configuredKey)) {
    checks.push({
      code: "reasonix_deepseek_api_key_in_config",
      level: "info",
      message: "DEEPSEEK_API_KEY supplied via adapter config env.",
    });
  } else if (isNonEmpty(process.env.DEEPSEEK_API_KEY)) {
    checks.push({
      code: "reasonix_deepseek_api_key_in_env",
      level: "info",
      message: "DEEPSEEK_API_KEY present in server environment.",
    });
  } else {
    const homeDir = deps.homeDir ?? os.homedir();
    if (await readDeepseekApiKeyFromFile(homeDir)) {
      checks.push({
        code: "reasonix_deepseek_api_key_in_config_file",
        level: "info",
        message: "DEEPSEEK_API_KEY found in ~/.reasonix/config.json.",
      });
    } else {
      checks.push({
        code: "reasonix_deepseek_api_key_missing",
        level: "error",
        message: "DEEPSEEK_API_KEY is not configured.",
        hint: "Set DEEPSEEK_API_KEY in the adapter config env, the server environment, or ~/.reasonix/config.json.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
