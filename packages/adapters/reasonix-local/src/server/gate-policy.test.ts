import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_GIT_READONLY,
  evaluateGate,
  pathIsWithin,
  tokenizeCommand,
} from "./gate-policy.js";

const policy = {
  cwd: "/repo",
  commandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
  gitReadOnlySubcommands: DEFAULT_GIT_READONLY,
};

describe("pathIsWithin", () => {
  it("approves path inside cwd", () => {
    expect(pathIsWithin("/repo/src/file.ts", "/repo")).toBe(true);
  });

  it("approves the cwd itself", () => {
    expect(pathIsWithin("/repo", "/repo")).toBe(true);
  });

  it("rejects sibling path with shared prefix (C4 fix)", () => {
    expect(pathIsWithin("/repo2/file.ts", "/repo")).toBe(false);
  });

  it("rejects parent traversal", () => {
    expect(pathIsWithin("/repo/../etc/passwd", "/repo")).toBe(false);
  });

  it("rejects absolute path outside cwd", () => {
    expect(pathIsWithin("/etc/passwd", "/repo")).toBe(false);
  });
});

describe("tokenizeCommand", () => {
  it("splits whitespace-separated tokens", () => {
    expect(tokenizeCommand("ls -la src/")).toEqual(["ls", "-la", "src/"]);
  });

  it("respects double quotes", () => {
    expect(tokenizeCommand('grep "hello world" file')).toEqual(["grep", "hello world", "file"]);
  });

  it("respects single quotes", () => {
    expect(tokenizeCommand("echo 'a b c'")).toEqual(["echo", "a b c"]);
  });
});

describe("evaluateGate path_access", () => {
  it("approves path inside cwd", () => {
    expect(evaluateGate({ kind: "path_access", pathValue: "/repo/x" }, policy)).toEqual({ decision: "approve" });
  });

  it("denies path outside cwd", () => {
    expect(evaluateGate({ kind: "path_access", pathValue: "/etc/passwd" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies sibling path with shared prefix", () => {
    expect(evaluateGate({ kind: "path_access", pathValue: "/repo2/file" }, policy)).toMatchObject({ decision: "deny" });
  });
});

describe("evaluateGate run_command", () => {
  it("approves ls in allowlist", () => {
    expect(evaluateGate({ kind: "run_command", command: "ls -la" }, policy)).toEqual({ decision: "approve" });
  });

  it("approves cat", () => {
    expect(evaluateGate({ kind: "run_command", command: "cat README.md" }, policy)).toEqual({ decision: "approve" });
  });

  it("approves git status (read-only subcommand)", () => {
    expect(evaluateGate({ kind: "run_command", command: "git status" }, policy)).toEqual({ decision: "approve" });
  });

  it("denies git push (not in read-only set)", () => {
    expect(evaluateGate({ kind: "run_command", command: "git push origin main" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies npm test (arbitrary code execution)", () => {
    expect(evaluateGate({ kind: "run_command", command: "npm test" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies pnpm install", () => {
    expect(evaluateGate({ kind: "run_command", command: "pnpm install" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies vitest", () => {
    expect(evaluateGate({ kind: "run_command", command: "vitest run" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies find with -exec", () => {
    expect(
      evaluateGate({ kind: "run_command", command: "find . -name '*.log' -exec rm {} ;" }, policy),
    ).toMatchObject({ decision: "deny" });
  });

  it("approves plain find", () => {
    expect(evaluateGate({ kind: "run_command", command: "find . -name '*.ts'" }, policy)).toEqual({ decision: "approve" });
  });

  it("denies find with -delete", () => {
    expect(evaluateGate({ kind: "run_command", command: "find . -name '*.log' -delete" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies pipe metacharacter", () => {
    expect(evaluateGate({ kind: "run_command", command: "ls | grep foo" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies command substitution", () => {
    expect(evaluateGate({ kind: "run_command", command: "echo $(id)" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies semicolon chaining", () => {
    expect(evaluateGate({ kind: "run_command", command: "ls; rm -rf /" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("denies && chaining", () => {
    expect(evaluateGate({ kind: "run_command", command: "ls && rm -rf /" }, policy)).toMatchObject({ decision: "deny" });
  });

  it("allows literal semicolon inside a quoted argument", () => {
    expect(evaluateGate({ kind: "run_command", command: "grep 'a;b' file" }, policy)).toEqual({ decision: "approve" });
  });
});

describe("evaluateGate unsupported kinds", () => {
  it("denies plan_proposed (or any unknown gate kind)", () => {
    expect(evaluateGate({ kind: "plan_proposed" }, policy)).toMatchObject({ decision: "deny" });
  });
});
