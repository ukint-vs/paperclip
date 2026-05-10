import { describe, expect, it } from "vitest";
import {
  PI_DELTA,
  PI_DELTA_EVENT_TYPES,
  isDroppableDeltaLine,
} from "./pi-event-types.js";

// These tests duplicate part of `server/parse.test.ts` intentionally — the
// constants now live in this UI-safe module and consumers can import either
// directly. Keeping the unit coverage colocated with the definition prevents
// regressions if the server-side re-export is ever moved.

describe("PI_DELTA constants (UI-safe module)", () => {
  it("matches the three known accumulated-state delta event types", () => {
    expect([...PI_DELTA_EVENT_TYPES].sort()).toEqual(
      ["text_delta", "thinking_delta", "toolcall_delta"].sort(),
    );
  });

  it("exposes per-name accessors via PI_DELTA", () => {
    expect(PI_DELTA.thinking).toBe("thinking_delta");
    expect(PI_DELTA.text).toBe("text_delta");
    expect(PI_DELTA.toolcall).toBe("toolcall_delta");
  });
});

describe("isDroppableDeltaLine (UI-safe module)", () => {
  it("drops message_update events for each delta type", () => {
    for (const deltaType of PI_DELTA_EVENT_TYPES) {
      const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: deltaType, delta: "x" },
      });
      expect(isDroppableDeltaLine(line)).toBe(true);
    }
  });

  it("keeps message_update events for *_end variants", () => {
    for (const endType of ["thinking_end", "text_end", "message_end"]) {
      const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: endType, content: "consolidated" },
      });
      expect(isDroppableDeltaLine(line)).toBe(false);
    }
  });

  it("passes through non-JSON lines and unrelated _delta substrings", () => {
    expect(isDroppableDeltaLine("not json")).toBe(false);
    expect(isDroppableDeltaLine("")).toBe(false);
    const line = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: "discussing thinking_delta" }],
    });
    expect(isDroppableDeltaLine(line)).toBe(false);
  });
});
