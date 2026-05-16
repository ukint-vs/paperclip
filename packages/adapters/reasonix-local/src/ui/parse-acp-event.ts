// ACP IS the stdout protocol for `reasonix acp` — there is no separate raw
// log channel to parse. This module turns one NDJSON JSON-RPC line into a
// typed AcpEvent for the run timeline; malformed lines yield a "raw" event
// rather than throwing.

export type AcpEvent =
  | { kind: "initialize"; protocolVersion?: number }
  | { kind: "session_new"; sessionId?: string }
  | { kind: "agent_message_chunk"; text: string; channel?: "thinking" | "answer" | null }
  | { kind: "tool_call"; toolCallId: string; name: string; status?: string; input?: unknown }
  | { kind: "tool_call_update"; toolCallId: string; status?: string; output?: unknown; isError?: boolean }
  | { kind: "request_permission"; requestId?: number | string; gateKind: string; payload: Record<string, unknown> }
  | { kind: "result"; stopReason?: string; usage?: Record<string, unknown>; costUsd?: number }
  | { kind: "error"; message: string }
  | { kind: "raw"; text: string };

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function parseAcpEventLine(line: string): AcpEvent {
  const parsed = parseJson(line);
  if (!parsed) return { kind: "raw", text: line };

  const method = asString(parsed.method);
  const params = asRecord(parsed.params);

  if (method === "initialize") {
    return { kind: "initialize", protocolVersion: asNumberOrUndefined(params.protocolVersion) };
  }

  if (method === "session/new" || method === "session/created") {
    return { kind: "session_new", sessionId: asString(params.sessionId) || undefined };
  }

  if (method === "session/update") {
    const update = asRecord(params.update ?? params);
    const updateType = asString(update.type ?? update.kind);
    if (updateType === "agent_message_chunk" || updateType === "text_delta") {
      const content = asRecord(update.content);
      const text = asString(content.text ?? update.text);
      const channelRaw = asString(update.channel);
      const channel: "thinking" | "answer" | null =
        channelRaw === "thinking" ? "thinking" : channelRaw === "answer" ? "answer" : null;
      return { kind: "agent_message_chunk", text, channel };
    }
    if (updateType === "tool_call") {
      return {
        kind: "tool_call",
        toolCallId: asString(update.toolCallId ?? update.id),
        name: asString(update.name ?? update.title, "tool"),
        status: asString(update.status) || undefined,
        input: update.input,
      };
    }
    if (updateType === "tool_call_update") {
      return {
        kind: "tool_call_update",
        toolCallId: asString(update.toolCallId ?? update.id),
        status: asString(update.status) || undefined,
        output: update.output ?? update.content,
        isError: update.isError === true,
      };
    }
  }

  if (method === "session/request_permission") {
    const payload = asRecord(params.options ?? params);
    const gateKind = asString(payload.kind ?? params.kind, "unknown");
    const rawId = parsed.id;
    return {
      kind: "request_permission",
      requestId: typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined,
      gateKind,
      payload,
    };
  }

  if (parsed.result && typeof parsed.result === "object") {
    const result = asRecord(parsed.result);
    if ("stopReason" in result || "usage" in result || "costUsd" in result) {
      return {
        kind: "result",
        stopReason: asString(result.stopReason) || undefined,
        usage: asRecord(result.usage),
        costUsd: asNumberOrUndefined(result.costUsd),
      };
    }
  }

  if (parsed.error && typeof parsed.error === "object") {
    const err = asRecord(parsed.error);
    return { kind: "error", message: asString(err.message, line) };
  }

  return { kind: "raw", text: line };
}
