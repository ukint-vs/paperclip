import { describe, expect, it } from "vitest";
import { parseSemver, semverGte, testEnvironment } from "./test.js";

describe("parseSemver", () => {
  it("parses a plain x.y.z", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
  });

  it("parses semver inside a banner", () => {
    expect(parseSemver("reasonix 0.5.7 (commit abc)")).toEqual([0, 5, 7]);
  });

  it("returns null for unparseable", () => {
    expect(parseSemver("nope")).toBeNull();
  });
});

describe("semverGte", () => {
  it("returns true on equal", () => {
    expect(semverGte([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns true on greater minor", () => {
    expect(semverGte([1, 3, 0], [1, 2, 9])).toBe(true);
  });

  it("returns false on lower patch", () => {
    expect(semverGte([1, 2, 2], [1, 2, 3])).toBe(false);
  });
});

describe("testEnvironment", () => {
  it("flags missing reasonix binary as fail", async () => {
    const result = await testEnvironment(
      { adapterType: "reasonix_local", companyId: "c1", config: { env: { DEEPSEEK_API_KEY: "x" } } },
      {
        probeReasonixVersion: async () => ({ stdout: "", stderr: "command not found", exitCode: 127, error: "not found" }),
        resolveMcpBin: () => ({ binPath: null, source: null, error: "test" }),
        homeDir: "/tmp/does-not-exist",
      },
    );
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.code === "reasonix_binary_missing")?.level).toBe("error");
  });

  it("flags missing DEEPSEEK_API_KEY as fail", async () => {
    const result = await testEnvironment(
      { adapterType: "reasonix_local", companyId: "c1", config: {} },
      {
        probeReasonixVersion: async () => ({ stdout: "reasonix 99.0.0", stderr: "", exitCode: 0 }),
        resolveMcpBin: () => ({ binPath: null, source: null, error: "test" }),
        homeDir: "/tmp/does-not-exist",
      },
    );
    const apiKeyCheck = result.checks.find((c) => c.code === "reasonix_deepseek_api_key_missing");
    expect(apiKeyCheck?.level).toBe("error");
  });

  it("warns when version is unparseable", async () => {
    const result = await testEnvironment(
      { adapterType: "reasonix_local", companyId: "c1", config: { env: { DEEPSEEK_API_KEY: "x" } } },
      {
        probeReasonixVersion: async () => ({ stdout: "unknown", stderr: "", exitCode: 0 }),
        resolveMcpBin: () => ({ binPath: null, source: null, error: "skip" }),
        homeDir: "/tmp/does-not-exist",
      },
    );
    expect(result.checks.find((c) => c.code === "reasonix_version_unparseable")?.level).toBe("warn");
  });
});
