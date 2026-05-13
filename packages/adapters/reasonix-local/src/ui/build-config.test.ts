import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildReasonixLocalConfig } from "./build-config.js";

function values(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "reasonix_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 0,
    ...overrides,
  };
}

describe("buildReasonixLocalConfig", () => {
  it("applies defaults", () => {
    const ac = buildReasonixLocalConfig(values());
    expect(ac.model).toBe("deepseek-v4-flash");
    expect(ac.preset).toBe("auto");
    expect(ac.timeoutSec).toBe(0);
  });

  it("picks up cwd from top-level when schema empty", () => {
    const ac = buildReasonixLocalConfig(values({ cwd: "/repo" }));
    expect(ac.cwd).toBe("/repo");
  });

  it("schemaValues override top-level for cwd and instructionsFilePath", () => {
    const ac = buildReasonixLocalConfig(
      values({
        cwd: "/repo",
        instructionsFilePath: "/inst-top.md",
        adapterSchemaValues: {
          cwd: "/repo-2",
          instructionsFilePath: "/inst-schema.md",
        },
      }),
    );
    expect(ac.cwd).toBe("/repo-2");
    expect(ac.instructionsFilePath).toBe("/inst-schema.md");
  });

  it("parses newline-delimited extras", () => {
    const ac = buildReasonixLocalConfig(
      values({
        adapterSchemaValues: {
          mcpExtras: "extra=foo bar\n# comment\nanother=baz",
          commandAllowlistExtras: "rg\nfd",
          gitReadOnlySubcommandsExtras: "stash\nworktree",
        },
      }),
    );
    expect(ac.mcpExtras).toEqual(["extra=foo bar", "another=baz"]);
    expect(ac.commandAllowlistExtras).toEqual(["rg", "fd"]);
    expect(ac.gitReadOnlySubcommandsExtras).toEqual(["stash", "worktree"]);
  });

  it("merges env bindings, legacy env, and schema env JSON", () => {
    const ac = buildReasonixLocalConfig(
      values({
        envBindings: { DEEPSEEK_API_KEY: { type: "secret_ref", secretId: "ds-1" } },
        envVars: "FOO=bar\nBAR=baz",
        adapterSchemaValues: { env: JSON.stringify({ EXTRA: { type: "plain", value: "x" } }) },
      }),
    );
    expect(ac.env).toMatchObject({
      DEEPSEEK_API_KEY: { type: "secret_ref", secretId: "ds-1" },
      FOO: { type: "plain", value: "bar" },
      BAR: { type: "plain", value: "baz" },
      EXTRA: { type: "plain", value: "x" },
    });
  });

  it("reads numeric timeoutSec from string", () => {
    const ac = buildReasonixLocalConfig(values({ adapterSchemaValues: { timeoutSec: "120" } }));
    expect(ac.timeoutSec).toBe(120);
  });
});
