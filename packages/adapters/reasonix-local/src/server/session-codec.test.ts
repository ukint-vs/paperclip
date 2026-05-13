import { describe, expect, it } from "vitest";
import { isCompatibleSession, sessionCodec } from "./session-codec.js";

describe("sessionCodec", () => {
  it("returns null for non-object input", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("x")).toBeNull();
    expect(sessionCodec.deserialize([])).toBeNull();
  });

  it("returns null when no identifying fields present", () => {
    expect(sessionCodec.deserialize({ cwd: "/repo" })).toBeNull();
  });

  it("round-trips a populated session", () => {
    const params = {
      configFingerprint: "abc123",
      cwd: "/repo",
      sessionDisplayId: "session-1",
      reasonixSessionName: "sess",
      reasonixHome: "/state/home-overlay",
      workspaceId: "w1",
    };
    const decoded = sessionCodec.deserialize(params);
    expect(decoded).toEqual(params);
    const reserialized = sessionCodec.serialize(decoded);
    expect(reserialized).toEqual(params);
  });

  it("strips empty-string fields", () => {
    const decoded = sessionCodec.deserialize({
      configFingerprint: "abc",
      cwd: "  ",
      sessionDisplayId: "sd",
    });
    expect(decoded).toEqual({ configFingerprint: "abc", sessionDisplayId: "sd" });
  });

  it("getDisplayId prefers sessionDisplayId", () => {
    expect(
      sessionCodec.getDisplayId?.({ sessionDisplayId: "primary", reasonixSessionName: "fallback" }),
    ).toBe("primary");
    expect(sessionCodec.getDisplayId?.({ reasonixSessionName: "fallback" })).toBe("fallback");
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});

describe("isCompatibleSession", () => {
  it("rejects null prior session", () => {
    expect(isCompatibleSession(null, { configFingerprint: "a", cwd: "/repo" })).toBe(false);
  });

  it("requires fingerprint match", () => {
    expect(
      isCompatibleSession(
        { configFingerprint: "old", cwd: "/repo" },
        { configFingerprint: "new", cwd: "/repo" },
      ),
    ).toBe(false);
  });

  it("requires cwd match", () => {
    expect(
      isCompatibleSession(
        { configFingerprint: "a", cwd: "/repo1" },
        { configFingerprint: "a", cwd: "/repo2" },
      ),
    ).toBe(false);
  });

  it("approves matching prior session", () => {
    expect(
      isCompatibleSession(
        { configFingerprint: "a", cwd: "/repo", reasonixHome: "/h" },
        { configFingerprint: "a", cwd: "/repo", reasonixHome: "/h" },
      ),
    ).toBe(true);
  });
});
