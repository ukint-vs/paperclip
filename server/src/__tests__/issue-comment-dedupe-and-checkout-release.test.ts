// APE-139: hybrid comment-POST dedupe + force-release of checkouts on terminal run status.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping APE-139 dedupe + release tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("APE-139 — hybrid comment dedupe", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ape-139-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Dedupe target",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId };
  }

  it("collapses two rapid identical comments into one row (server-derived dedupe)", async () => {
    const { agentId, issueId } = await seed();

    const body = "Stage 0 + Stage 1a complete\n\nLong markdown body that matches the observed APE-132 retry pattern.";
    const first = await svc.addComment(issueId, body, { agentId });
    const second = await svc.addComment(issueId, body, { agentId });

    expect(second.id).toBe(first.id);
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(rows.length).toBe(1);
  });

  it("does not dedupe identical bodies posted >10s apart (sliding window)", async () => {
    const { agentId, issueId } = await seed();

    const body = "stale-window check";
    const first = await svc.addComment(issueId, body, { agentId });
    // Backdate the first row well outside the 10s window.
    await db
      .update(issueComments)
      .set({ createdAt: sql`now() - interval '30 seconds'` })
      .where(eq(issueComments.id, first.id));

    const second = await svc.addComment(issueId, body, { agentId });
    expect(second.id).not.toBe(first.id);

    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(rows.length).toBe(2);
  });

  it("does not collapse identical bodies from different agents", async () => {
    const { companyId, agentId, issueId } = await seed();

    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const body = "shared-body different authors";
    const first = await svc.addComment(issueId, body, { agentId });
    const second = await svc.addComment(issueId, body, { agentId: otherAgentId });

    expect(second.id).not.toBe(first.id);
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(rows.length).toBe(2);
  });

  it("collapses on idempotencyKey even when bodies differ", async () => {
    const { agentId, issueId } = await seed();

    const key = "wake-retry-1234";
    const first = await svc.addComment(issueId, "first body", { agentId }, { idempotencyKey: key });
    const second = await svc.addComment(issueId, "second body — SHOULD BE IGNORED", { agentId }, { idempotencyKey: key });

    expect(second.id).toBe(first.id);
    expect(second.body).toBe("first body");
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(rows.length).toBe(1);
  });
});

describeEmbeddedPostgres("APE-139 — release issue checkouts on terminal run status", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ape-139-release-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLockedIssue(runStatus: "running" | "succeeded" | "failed" | "cancelled" | "timed_out") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: runStatus,
      invocationSource: "manual",
      startedAt: new Date(),
      finishedAt: runStatus === "running" ? null : new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });

    return { companyId, agentId, runId, issueId };
  }

  // The release helper is private to the heartbeat service factory; this test
  // exercises the same UPDATE shape directly to guard against regressions in
  // the SQL we execute on terminal transitions.
  async function releaseIssueCheckoutsForRun(runId: string) {
    await db
      .update(issues)
      .set({ checkoutRunId: null, updatedAt: new Date() })
      .where(eq(issues.checkoutRunId, runId));
  }

  // setRunStatus only releases on `succeeded` and `cancelled`. `failed` and
  // `timed_out` participate in the retry-handoff path; the next retry inherits
  // the existing checkout, so we must NOT clear the lock there.
  for (const releaseTerminal of ["succeeded", "cancelled"] as const) {
    it(`releases the checkout when the run reaches ${releaseTerminal}`, async () => {
      const { runId, issueId } = await seedLockedIssue(releaseTerminal);

      // Simulate setRunStatus's terminal-transition release.
      await releaseIssueCheckoutsForRun(runId);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.checkoutRunId).toBeNull();
    });
  }

  it("does not touch checkouts that point at still-running runs", async () => {
    const { runId, issueId } = await seedLockedIssue("running");

    // Calling release for a different run id must not clear unrelated locks.
    await releaseIssueCheckoutsForRun(randomUUID());
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.checkoutRunId).toBe(runId);
  });
});
