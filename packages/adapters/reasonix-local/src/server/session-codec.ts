import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface ReasonixSessionState {
  configFingerprint: string;
  cwd: string;
  sessionDisplayId: string;
  reasonixSessionName: string | null;
  reasonixHome?: string | null;
  workspaceId?: string | null;
}

export function isCompatibleSession(
  prior: Record<string, unknown> | null,
  current: { configFingerprint: string; cwd: string; reasonixHome?: string | null },
): boolean {
  if (!prior) return false;
  if (readString(prior.configFingerprint) !== current.configFingerprint) return false;
  if (readString(prior.cwd) !== current.cwd) return false;
  if (current.reasonixHome) {
    const priorHome = readString(prior.reasonixHome);
    if (priorHome && priorHome !== current.reasonixHome) return false;
  }
  return true;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionDisplayId = readString(record.sessionDisplayId);
    const reasonixSessionName = readString(record.reasonixSessionName);
    const configFingerprint = readString(record.configFingerprint);
    const cwd = readString(record.cwd);
    if (!sessionDisplayId && !reasonixSessionName && !configFingerprint) return null;
    return {
      ...(configFingerprint ? { configFingerprint } : {}),
      ...(cwd ? { cwd } : {}),
      ...(sessionDisplayId ? { sessionDisplayId } : {}),
      ...(reasonixSessionName ? { reasonixSessionName } : {}),
      ...(readString(record.reasonixHome) ? { reasonixHome: readString(record.reasonixHome) } : {}),
      ...(readString(record.workspaceId) ? { workspaceId: readString(record.workspaceId) } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return this.deserialize(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readString(params.sessionDisplayId) ?? readString(params.reasonixSessionName);
  },
};
