// APE-139: one-shot reconciliation for stale issue checkouts.
//
// Clears `issues.checkout_run_id` on any issue whose lock points at a heartbeat
// run that has reached a terminal status. Run once after the migration that
// adds the deferred force-release path lands so the existing backlog of stale
// locks is cleaned up. Idempotent — safe to run repeatedly.
//
// Usage:
//   pnpm --filter server tsx scripts/release-stale-issue-checkouts.ts \
//     --connection-string postgres://paperclip:paperclip@127.0.0.1:54329/paperclip
//
// Or set DATABASE_URL and call with no args.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { createDb, heartbeatRuns, issues } from "@paperclipai/db";

// Match the runtime release set in heartbeat.ts. `failed` and `timed_out`
// participate in the retry-handoff path, so we leave their checkouts alone.
const RELEASABLE_RUN_STATUSES = ["succeeded", "cancelled"] as const;

function readArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const connectionString =
    readArg("--connection-string") ?? process.env.DATABASE_URL ?? null;
  if (!connectionString) {
    throw new Error(
      "Connection string required. Pass --connection-string <url> or set DATABASE_URL.",
    );
  }

  const db = createDb(connectionString);

  // Two-step so we can log what we're about to release before mutating.
  const stale = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      checkoutRunId: issues.checkoutRunId,
      runStatus: heartbeatRuns.status,
      runFinishedAt: heartbeatRuns.finishedAt,
    })
    .from(issues)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issues.checkoutRunId))
    .where(
      and(
        isNotNull(issues.checkoutRunId),
        inArray(heartbeatRuns.status, [...RELEASABLE_RUN_STATUSES]),
      ),
    );

  if (stale.length === 0) {
    console.log("No stale issue checkouts found. Nothing to do.");
    return;
  }

  console.log(`Found ${stale.length} stale issue checkout(s):`);
  for (const row of stale) {
    console.log(
      `  ${row.identifier ?? row.issueId} → run ${row.checkoutRunId} (${row.runStatus}, finished ${
        row.runFinishedAt ? new Date(row.runFinishedAt).toISOString() : "unknown"
      })`,
    );
  }

  const releasedRunIds = Array.from(new Set(stale.map((r) => r.checkoutRunId).filter((v): v is string => v != null)));
  const result = await db
    .update(issues)
    .set({ checkoutRunId: null, updatedAt: new Date() })
    .where(
      and(
        isNotNull(issues.checkoutRunId),
        inArray(issues.checkoutRunId, releasedRunIds),
      ),
    )
    .returning({ id: issues.id });

  console.log(`Released ${result.length} issue checkout(s).`);
}

main().catch((err) => {
  console.error("release-stale-issue-checkouts failed:", err);
  process.exitCode = 1;
});
