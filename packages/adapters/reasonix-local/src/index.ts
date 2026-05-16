import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "reasonix_local";
export const label = "Reasonix (local)";

export const DEFAULT_REASONIX_MODEL = "deepseek-v4-flash";
export const DEFAULT_REASONIX_PRESET = "auto";
export const DEFAULT_REASONIX_TIMEOUT_SEC = 0;

// First tag that contains the three ACP plumbing PRs the adapter relies on:
// #766 (--transcript), #767 (--yolo), #780 (--mcp + --mcp-prefix). v0.42.0-0
// is a canary; the next stable release in the 0.42.x line works too.
export const REQUIRED_REASONIX_VERSION = "0.42.0-0";

export const models: AdapterModel[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export const reasonixPresetOptions = [
  { id: "auto", label: "Auto" },
  { id: "fast", label: "Fast" },
  { id: "thorough", label: "Thorough" },
] as const;

export const agentConfigurationDoc = `# reasonix_local agent configuration

Adapter: reasonix_local

Use when:
- The agent should run through Reasonix (a DeepSeek-native AI coding agent) over
  ACP, with Paperclip tools exposed via the bundled paperclip-mcp-server.
- You want Paperclip-managed state isolation, a tightened read-only command
  allowlist, and partial-transcript cost extraction.

Don't use when:
- Reasonix is not installed on the Paperclip host or is older than the pinned
  REQUIRED_REASONIX_VERSION.
- DEEPSEEK_API_KEY is not available to the host (env or ~/.reasonix/config.json).

Core fields:
- model (string, optional): DeepSeek model id. Defaults to deepseek-v4-flash.
- preset (string, optional): auto, fast, or thorough. Defaults to auto.
- cwd (string, optional): absolute working directory the agent operates in.
  Paperclip execution workspaces can override at runtime. The read-only
  allowlist constrains the agent to this directory.
- timeoutSec (number, optional): run timeout. 0 means no adapter timeout.
- env (object, optional): KEY=VALUE environment variables or secret bindings.
  DEEPSEEK_API_KEY must be reachable.
- mcpExtras (string[], optional): extra --mcp specs to pass to reasonix acp on
  top of the bundled paperclip MCP server.
- commandAllowlistExtras (string[], optional): extra read-only commands to add
  to the default allowlist (ls, cat, head, tail, wc, tree, pwd, echo, grep,
  find). Anything that runs arbitrary code (npm, pnpm, pytest, vitest, cargo,
  tsc, ...) is intentionally excluded — those are denied with a stderr log.
- gitReadOnlySubcommandsExtras (string[], optional): extra read-only git
  subcommands beyond the default set (status, log, diff, show, blame,
  ls-files, rev-parse, branch).
- instructionsFilePath (string, optional): absolute path to a markdown
  instructions file injected into the prompt.
- promptTemplate (string, optional): run prompt template.

State isolation:
- The adapter spawns reasonix with HOME overridden to
  <stateDir>/home-overlay so that ~/.reasonix lives inside the Paperclip
  state directory. POSIX-only in v1; Windows is unsupported.

Permissions:
- reasonix acp is spawned with --yolo. The adapter intercepts outbound
  session/request_permission calls and applies a tightened read-only
  allowlist. Anything not on the allowlist is auto-denied and logged to
  stderr (Paperclip does not support mid-run interactive permission bridging
  today). Adjust commandAllowlistExtras / gitReadOnlySubcommandsExtras to
  widen the policy.
`;
