import { describe, expect, it } from "vitest";
import { parseTranscriptForUsage } from "./execute.js";

describe("parseTranscriptForUsage", () => {
  it("returns zeros for empty input", () => {
    const acc = parseTranscriptForUsage([]);
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
    expect(acc.costUsd).toBe(0);
    expect(acc.hasAssistantFinal).toBe(false);
  });

  it("extracts usage and cost from assistant_final", () => {
    const acc = parseTranscriptForUsage([
      JSON.stringify({ type: "assistant_final", usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 10 }, costUsd: 0.05, stopReason: "end_turn" }),
    ]);
    expect(acc.inputTokens).toBe(100);
    expect(acc.outputTokens).toBe(200);
    expect(acc.cachedInputTokens).toBe(10);
    expect(acc.costUsd).toBeCloseTo(0.05);
    expect(acc.stopReason).toBe("end_turn");
    expect(acc.hasAssistantFinal).toBe(true);
  });

  it("accumulates usage records when no assistant_final present", () => {
    const acc = parseTranscriptForUsage([
      JSON.stringify({ type: "usage", inputTokens: 10, outputTokens: 20, costUsd: 0.001 }),
      JSON.stringify({ type: "usage", inputTokens: 5, outputTokens: 5, costUsd: 0.0005 }),
    ]);
    expect(acc.inputTokens).toBe(15);
    expect(acc.outputTokens).toBe(25);
    expect(acc.costUsd).toBeCloseTo(0.0015);
    expect(acc.hasAssistantFinal).toBe(false);
  });

  it("supports snake_case keys", () => {
    const acc = parseTranscriptForUsage([
      JSON.stringify({ type: "assistant_final", usage: { input_tokens: 7, output_tokens: 9 }, cost_usd: 0.01, stop_reason: "complete" }),
    ]);
    expect(acc.inputTokens).toBe(7);
    expect(acc.outputTokens).toBe(9);
    expect(acc.costUsd).toBeCloseTo(0.01);
    expect(acc.stopReason).toBe("complete");
  });

  it("ignores malformed lines", () => {
    const acc = parseTranscriptForUsage([
      "garbage",
      JSON.stringify({ type: "usage", inputTokens: 1, outputTokens: 2 }),
    ]);
    expect(acc.inputTokens).toBe(1);
    expect(acc.outputTokens).toBe(2);
  });
});
