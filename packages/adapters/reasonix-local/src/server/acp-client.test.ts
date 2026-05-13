import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createAcpClient, type JsonRpcNotification } from "./acp-client.js";

function pair() {
  const stdin = new PassThrough(); // client writes here (we read)
  const stdout = new PassThrough(); // we write here (client reads)
  return { stdin, stdout };
}

function readLines(stream: PassThrough): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    setTimeout(() => resolve(lines), 50);
  });
}

describe("createAcpClient", () => {
  it("sends a request and resolves on matching response", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    const linesPromise = readLines(stdin);
    const callPromise = client.call("initialize", { protocolVersion: 1 });
    await new Promise((r) => setTimeout(r, 10));
    // Server-side response: the request id is 1 (first call)
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
    const result = await callPromise;
    expect(result).toEqual({ ok: true });
    const lines = await linesPromise;
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
  });

  it("rejects on error response", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    const p = client.call("session/new");
    await new Promise((r) => setTimeout(r, 10));
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "nope" } }) + "\n");
    await expect(p).rejects.toThrow("nope");
  });

  it("emits notifications", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    const seen: JsonRpcNotification[] = [];
    client.on("notification", (n) => seen.push(n));
    stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { foo: 1 } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([
      { jsonrpc: "2.0", method: "session/update", params: { foo: 1 } },
    ]);
  });

  it("handles server-initiated request via setRequestHandler", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    client.setRequestHandler("session/request_permission", async (params) => {
      expect(params).toEqual({ kind: "run_command", command: "ls" });
      return { decision: "approve" };
    });
    const linesPromise = readLines(stdin);
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: { kind: "run_command", command: "ls" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 30));
    const lines = await linesPromise;
    const reply = lines.map((l) => JSON.parse(l)).find((m) => m.id === 99);
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 99, result: { decision: "approve" } });
  });

  it("skips malformed JSON lines without throwing", async () => {
    const { stdin, stdout } = pair();
    const errors: Error[] = [];
    const client = createAcpClient({ stdin, stdout, onProtocolError: (e) => errors.push(e) });
    let notifCount = 0;
    client.on("notification", () => notifCount++);
    stdout.write("garbage not json\n");
    stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "x" }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(errors.length).toBe(1);
    expect(notifCount).toBe(1);
  });

  it("rejects pending calls on close", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    const p = client.call("foo");
    stdout.end();
    await expect(p).rejects.toThrow("ACP client closed");
  });

  it("rejects after explicit timeout", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    const p = client.call("slow", null, 30);
    await expect(p).rejects.toThrow(/timed out/);
  });

  it("notify writes a notification without an id", async () => {
    const { stdin, stdout } = pair();
    const client = createAcpClient({ stdin, stdout });
    const linesPromise = readLines(stdin);
    client.notify("hello", { x: 1 });
    const lines = await linesPromise;
    const msg = JSON.parse(lines[0]!);
    expect(msg).toEqual({ jsonrpc: "2.0", method: "hello", params: { x: 1 } });
    expect("id" in msg).toBe(false);
  });
});
