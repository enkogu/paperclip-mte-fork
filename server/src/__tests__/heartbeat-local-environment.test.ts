import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentRuntimeService } from "../services/environment-runtime.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForRunLeasesToRelease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return leases;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await db
    .select()
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, runId));
}

async function waitForRunningRunWithActiveLease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (run?.status === "running" && leases.some((lease) => lease.status === "active")) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describeEmbeddedPostgres("heartbeat local environment lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-environment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function terminalRows(runId: string) {
    const [run, wakeups, issueRows, sessions] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, runId)),
      db.select().from(issues).where(eq(issues.executionRunId, runId)),
      db.select().from(agentTaskSessions).where(eq(agentTaskSessions.lastRunId, runId)),
    ]);
    return { run, wakeups, issueRows, sessions };
  }

  it("runs work through the default Local environment lease", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const localRows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "local"));
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.name).toBe("Local");

    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.environmentId).toBe(localRows[0]?.id);
    expect(leases[0]?.status).toBe("expired");
    expect(leases[0]?.provider).toBe("local");
    expect(leases[0]?.releasedAt).not.toBeNull();

    const context = finished?.contextSnapshot as Record<string, unknown>;
    expect(context.paperclipEnvironment).toMatchObject({
      id: localRows[0]?.id,
      name: "Local",
      driver: "local",
      leaseId: leases[0]?.id,
    });
  });

  it("releases the lease before adapter failure becomes terminal", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FailingProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(7)"] },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("failed");
    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.status).toBe("failed");
  });

  it("single-run cancellation releases its active lease before terminal CAS", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CancellableProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    expect(await waitForRunningRunWithActiveLease(db, queued!.id)).not.toBeNull();
    const cancelled = await heartbeat.cancelRun(queued!.id);
    expect(cancelled?.status).toBe("cancelled");
    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.status).toBe("expired");
  });

  it("agent-wide cancellation releases each active lease before terminal CAS", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PausedProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    expect(await waitForRunningRunWithActiveLease(db, queued!.id)).not.toBeNull();
    expect(await heartbeat.cancelActiveForAgent(agentId)).toBe(1);
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("cancelled");
    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.status).toBe("released");
  });

  it("leaves run, wakeup, issue, and session rows unchanged when lease release rejects", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseRejectAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 100)"] },
      runtimeConfig: {},
      permissions: {},
    });

    const baseRuntime = environmentRuntimeService(db);
    let snapshot: Awaited<ReturnType<typeof terminalRows>> | null = null;
    let observedResolve!: () => void;
    const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: {
        ...baseRuntime,
        async releaseRunLeases(runId) {
          snapshot ??= await terminalRows(runId);
          observedResolve();
          throw new Error("injected release rejection");
        },
      },
    });
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await terminalRows(queued!.id)).toEqual(snapshot);
  });

  it("preserves the CAS winner and leaves wakeup, issue, and session rows unchanged after CAS loss", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CasLossAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 100)"] },
      runtimeConfig: {},
      permissions: {},
    });

    const baseRuntime = environmentRuntimeService(db);
    let injected = false;
    let winnerSnapshot: Awaited<ReturnType<typeof terminalRows>> | null = null;
    let observedResolve!: () => void;
    const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
    const heartbeat = heartbeatService(db, {
      environmentRuntime: {
        ...baseRuntime,
        async releaseRunLeases(runId, status) {
          const released = await baseRuntime.releaseRunLeases(runId, status);
          if (!injected) {
            injected = true;
            await finalizeTerminalRun(db, {
              runId,
              expectedStatus: "running",
              status: "cancelled",
              runPatch: {
                error: "injected CAS winner",
                finishedAt: new Date(),
              },
              wakeupRequestId: null,
              wakeupStatus: "cancelled",
              wakeupError: "injected CAS winner",
            });
            winnerSnapshot = await terminalRows(runId);
            observedResolve();
          }
          return released;
        },
      },
    });
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await terminalRows(queued!.id)).toEqual(winnerSnapshot);
  });
});

import { finalizeTerminalRun } from "../services/terminal-run-finalizer.ts";
