// Pi-coding-agent NDJSON event-type constants and a single-line filter for
// accumulated-state delta events. UI-safe: no Node-only or server-utils
// dependencies (only `JSON.parse`), so this module can be imported from
// browser builds (`src/ui/`) as well as server code (`src/server/`).
//
// The Pi event protocol is documented inline in `src/server/parse.ts`; keep
// this list as the single source of truth for which `message_update` event
// types carry accumulated partial state.

export const PI_DELTA = {
  thinking: "thinking_delta",
  text: "text_delta",
  toolcall: "toolcall_delta",
} as const;
export type PiDeltaEventType = (typeof PI_DELTA)[keyof typeof PI_DELTA];
export const PI_DELTA_EVENT_TYPES: readonly PiDeltaEventType[] = Object.values(PI_DELTA);
const DROPPABLE_DELTA_TYPES: ReadonlySet<string> = new Set(PI_DELTA_EVENT_TYPES);

/**
 * Returns true when `line` is an NDJSON `message_update` event whose
 * assistantMessageEvent.type is one of the accumulated-state delta types
 * (see PI_DELTA). Used by the pi-local adapter's bufferedOnLog filter to
 * keep these O(n²) lines out of the persisted run log.
 *
 * On any JSON.parse failure or shape mismatch, returns false (passthrough).
 */
export function isDroppableDeltaLine(line: string): boolean {
  // Cheap prefilter: avoid JSON.parse for lines that obviously don't match.
  if (!line.includes("_delta")) return false;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event?.type !== "message_update") return false;
    const msg = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const msgType = typeof msg?.type === "string" ? msg.type : "";
    return DROPPABLE_DELTA_TYPES.has(msgType);
  } catch {
    return false;
  }
}
