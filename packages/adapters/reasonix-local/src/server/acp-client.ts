import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

// Minimal ACP JSON-RPC client over stdio. Reasonix-local acts as an ACP
// CLIENT against the spawned `reasonix acp` server, which is the opposite of
// acpx-local's role (host ACP servers via acpx/runtime). The shape here is a
// hand-rolled subset of the Agent Client Protocol sufficient to drive a
// session, stream updates, and answer outbound permission requests.

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface AcpClientOptions {
  stdin: Writable;
  stdout: Readable;
  onLine?: (rawLine: string) => void;
  onProtocolError?: (err: Error) => void;
}

type IncomingMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface PendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface AcpClient extends EventEmitter {
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  on(event: "notification", listener: (note: JsonRpcNotification) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  setRequestHandler(method: string, handler: ServerRequestHandler): void;
  close(): void;
}

export function createAcpClient(opts: AcpClientOptions): AcpClient {
  const emitter = new EventEmitter() as AcpClient;
  let nextId = 1;
  const pending = new Map<number | string, PendingCall>();
  const requestHandlers = new Map<string, ServerRequestHandler>();
  let buffer = "";
  let closed = false;

  function write(message: unknown): void {
    if (closed) return;
    const line = `${JSON.stringify(message)}\n`;
    try {
      opts.stdin.write(line);
    } catch (err) {
      opts.onProtocolError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function isRequest(msg: IncomingMessage): msg is JsonRpcRequest {
    return typeof (msg as JsonRpcRequest).method === "string" &&
      Object.prototype.hasOwnProperty.call(msg, "id");
  }

  function isNotification(msg: IncomingMessage): msg is JsonRpcNotification {
    return typeof (msg as JsonRpcNotification).method === "string" &&
      !Object.prototype.hasOwnProperty.call(msg, "id");
  }

  function isResponse(msg: IncomingMessage): msg is JsonRpcResponse {
    return !(msg as JsonRpcRequest).method && Object.prototype.hasOwnProperty.call(msg, "id");
  }

  function dispatch(message: IncomingMessage): void {
    if (isNotification(message)) {
      emitter.emit("notification", message);
      return;
    }
    if (isRequest(message)) {
      const handler = requestHandlers.get(message.method);
      if (!handler) {
        write({
          jsonrpc: "2.0" as const,
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.params))
        .then((result) => {
          write({ jsonrpc: "2.0" as const, id: message.id, result });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          write({
            jsonrpc: "2.0" as const,
            id: message.id,
            error: { code: -32603, message: msg },
          });
        });
      return;
    }
    if (isResponse(message)) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) {
        handler.reject(new Error(message.error.message));
      } else {
        handler.resolve(message.result);
      }
    }
  }

  function processLine(rawLine: string): void {
    if (!rawLine.trim()) return;
    opts.onLine?.(rawLine);
    let parsed: IncomingMessage;
    try {
      parsed = JSON.parse(rawLine) as IncomingMessage;
    } catch (err) {
      opts.onProtocolError?.(
        new Error(`malformed ACP NDJSON line: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    dispatch(parsed);
  }

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processLine(line);
    }
  }

  function onClose(): void {
    if (closed) return;
    closed = true;
    if (buffer.trim()) processLine(buffer);
    buffer = "";
    for (const [, handler] of pending) {
      handler.reject(new Error("ACP client closed before response"));
    }
    pending.clear();
    emitter.emit("close");
  }

  opts.stdout.on("data", onData);
  opts.stdout.on("end", onClose);
  opts.stdout.on("close", onClose);

  emitter.call = function call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (closed) return Promise.reject(new Error("ACP client is closed"));
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      write({ jsonrpc: "2.0" as const, id, method, params });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`ACP call ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  };

  emitter.notify = function notify(method: string, params?: unknown): void {
    write({ jsonrpc: "2.0" as const, method, params });
  };

  emitter.setRequestHandler = function setRequestHandler(method: string, handler: ServerRequestHandler): void {
    requestHandlers.set(method, handler);
  };

  emitter.close = function close(): void {
    onClose();
  };

  return emitter;
}
