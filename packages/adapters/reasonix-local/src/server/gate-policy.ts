import path from "node:path";

export interface GatePolicy {
  cwd: string;
  commandAllowlist: ReadonlySet<string>;
  gitReadOnlySubcommands: ReadonlySet<string>;
}

export type GateRequest =
  | { kind: "path_access"; pathValue: string }
  | { kind: "run_command"; command: string }
  | { kind: string; [key: string]: unknown };

export type GateDecision =
  | { decision: "approve" }
  | { decision: "deny"; reason: string };

export const DEFAULT_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "tree",
  "pwd",
  "echo",
  "grep",
  "find",
]);

export const DEFAULT_GIT_READONLY: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "ls-files",
  "rev-parse",
  "branch",
]);

const FIND_REJECTED_FLAGS = new Set([
  "-exec",
  "-execdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

const SHELL_METACHAR_REGEX = /[;&|<>`]|\$\(|&&|\|\|/;

export function pathIsWithin(target: string, root: string): boolean {
  if (!target || !root) return false;
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  if (absTarget === absRoot) return true;
  const rel = path.relative(absRoot, absTarget);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export function tokenizeCommand(command: string): string[] {
  // Best-effort POSIX tokenization respecting single/double quotes.
  // Returns tokens with quotes stripped. Backslash escapes outside quotes are
  // honored for a single character.
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (!inSingle && !inDouble && c === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i++;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function hasShellMetacharacters(command: string): boolean {
  // Quoted regions can legitimately contain `;` etc. The cheap heuristic:
  // strip single- and double-quoted regions, then check the residual.
  let stripped = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    stripped += c;
  }
  return SHELL_METACHAR_REGEX.test(stripped);
}

export function evaluateGate(req: GateRequest, policy: GatePolicy): GateDecision {
  if (req.kind === "path_access") {
    const target = typeof req.pathValue === "string" ? req.pathValue : "";
    if (!target) return { decision: "deny", reason: "empty path" };
    if (!pathIsWithin(target, policy.cwd)) {
      return { decision: "deny", reason: `path outside cwd: ${target}` };
    }
    return { decision: "approve" };
  }

  if (req.kind === "run_command") {
    const command = typeof req.command === "string" ? req.command : "";
    if (!command.trim()) return { decision: "deny", reason: "empty command" };

    if (hasShellMetacharacters(command)) {
      return { decision: "deny", reason: "shell metacharacter rejected" };
    }

    const tokens = tokenizeCommand(command);
    if (tokens.length === 0) return { decision: "deny", reason: "empty command" };

    const head = tokens[0]!;

    if (head === "git") {
      const sub = tokens[1] ?? "";
      if (!sub) return { decision: "deny", reason: "git: missing subcommand" };
      if (!policy.gitReadOnlySubcommands.has(sub)) {
        return { decision: "deny", reason: `git subcommand not in read-only set: ${sub}` };
      }
      return { decision: "approve" };
    }

    if (!policy.commandAllowlist.has(head)) {
      return { decision: "deny", reason: `command not in allowlist: ${head}` };
    }

    if (head === "find") {
      for (const tok of tokens.slice(1)) {
        if (FIND_REJECTED_FLAGS.has(tok)) {
          return { decision: "deny", reason: `find flag rejected: ${tok}` };
        }
      }
    }

    return { decision: "approve" };
  }

  return { decision: "deny", reason: `unsupported gate kind: ${req.kind}` };
}
