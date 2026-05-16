import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_REASONIX_MODEL,
  DEFAULT_REASONIX_PRESET,
  DEFAULT_REASONIX_TIMEOUT_SEC,
  models,
  reasonixPresetOptions,
} from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        default: DEFAULT_REASONIX_MODEL,
        required: true,
        options: models.map((m) => ({ value: m.id, label: m.label })),
      },
      {
        key: "preset",
        label: "Preset",
        type: "select",
        default: DEFAULT_REASONIX_PRESET,
        options: reasonixPresetOptions.map((p) => ({ value: p.id, label: p.label })),
        hint: "Reasonix planner preset.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute working directory. Paperclip execution workspaces can override at runtime.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_REASONIX_TIMEOUT_SEC,
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "JSON object of environment values or secret bindings. DEEPSEEK_API_KEY must be reachable.",
      },
      {
        key: "mcpExtras",
        label: "Extra MCP specs",
        type: "textarea",
        hint: "Additional --mcp specs (one per line, format name=command [args...]) layered on top of the bundled paperclip MCP server.",
      },
      {
        key: "commandAllowlistExtras",
        label: "Extra read-only commands",
        type: "textarea",
        hint: "Extra command names (one per line) to add to the read-only allowlist. Anything that runs arbitrary code is intentionally excluded by default.",
      },
      {
        key: "gitReadOnlySubcommandsExtras",
        label: "Extra git read-only subcommands",
        type: "textarea",
        hint: "Extra git subcommands (one per line) treated as read-only.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Optional absolute path to a markdown instructions file.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional prompt template override.",
      },
    ],
  };
}
