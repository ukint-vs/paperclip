import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildPaperclipPromptContext } from "./prompt-context.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "alice", adapterType: "reasonix_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("buildPaperclipPromptContext", () => {
  it("includes issue id and title when present", () => {
    const ctx = makeCtx({
      context: { issue: { id: "PAP-123", title: "Fix the bug" } },
    });
    const out = buildPaperclipPromptContext(ctx);
    expect(out).toContain("PAP-123");
    expect(out).toContain("Fix the bug");
  });

  it("falls back to identifier when id missing", () => {
    const ctx = makeCtx({ context: { issue: { identifier: "PAP-9" } } });
    expect(buildPaperclipPromptContext(ctx)).toContain("PAP-9");
  });

  it("includes the default paperclip_ tool list", () => {
    const out = buildPaperclipPromptContext(makeCtx());
    expect(out).toContain("paperclip_addComment");
    expect(out).toContain("paperclip_updateIssue");
    expect(out).toContain("paperclip_apiRequest");
  });

  it("rewrites the prefix when supplied", () => {
    const out = buildPaperclipPromptContext(makeCtx(), { mcpToolPrefix: "pc__" });
    expect(out).toContain("pc__addComment");
    expect(out).not.toContain("paperclip_addComment");
  });

  it("includes the agent id when available", () => {
    expect(buildPaperclipPromptContext(makeCtx())).toContain("agent-1");
  });

  it("appends extra tools when supplied", () => {
    const out = buildPaperclipPromptContext(makeCtx(), { extraTools: ["paperclip_custom(x)"] });
    expect(out).toContain("paperclip_custom(x)");
  });
});
