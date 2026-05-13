import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  DEFAULT_REASONIX_MODEL,
  DEFAULT_REASONIX_PRESET,
  DEFAULT_REASONIX_TIMEOUT_SEC,
} from "../index.js";

function parseLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
    }
  }
  return env;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function buildReasonixLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const schemaValues = v.adapterSchemaValues ?? {};
  const ac: Record<string, unknown> = {
    model: schemaValues.model || v.model || DEFAULT_REASONIX_MODEL,
    preset: schemaValues.preset || DEFAULT_REASONIX_PRESET,
    timeoutSec: readNumber(schemaValues.timeoutSec, DEFAULT_REASONIX_TIMEOUT_SEC),
  };

  for (const key of ["cwd", "instructionsFilePath", "promptTemplate"]) {
    const value = schemaValues[key];
    if (typeof value === "string" && value.trim()) ac[key] = value.trim();
  }
  if (!ac.cwd && v.cwd) ac.cwd = v.cwd;
  if (!ac.instructionsFilePath && v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (!ac.promptTemplate && v.promptTemplate) ac.promptTemplate = v.promptTemplate;

  const mcpExtras = parseLines(schemaValues.mcpExtras);
  if (mcpExtras.length > 0) ac.mcpExtras = mcpExtras;
  const allowlistExtras = parseLines(schemaValues.commandAllowlistExtras);
  if (allowlistExtras.length > 0) ac.commandAllowlistExtras = allowlistExtras;
  const gitExtras = parseLines(schemaValues.gitReadOnlySubcommandsExtras);
  if (gitExtras.length > 0) ac.gitReadOnlySubcommandsExtras = gitExtras;

  const env = parseEnvBindings(v.envBindings);
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (typeof schemaValues.env === "string") {
    const schemaEnv = parseJsonObject(schemaValues.env);
    if (schemaEnv) Object.assign(env, schemaEnv);
  } else if (typeof schemaValues.env === "object" && schemaValues.env !== null && !Array.isArray(schemaValues.env)) {
    Object.assign(env, schemaValues.env as Record<string, unknown>);
  }
  if (Object.keys(env).length > 0) ac.env = env;

  return ac;
}
