import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { HeartbeatRunStatus } from "@paperclipai/shared";
import {
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

class RunAlreadyFinalizedError extends Error {}

export type TerminalHeartbeatRunStatus = Extract<
  HeartbeatRunStatus,
  "succeeded" | "failed" | "cancelled" | "timed_out"
>;

type TerminalRunPatch = Omit<
  Partial<typeof heartbeatRuns.$inferInsert>,
  "id" | "status" | "updatedAt"
>;

export type TerminalTaskSessionMutation =
  | { kind: "none" }
  | {
      kind: "clear";
      companyId: string;
      agentId: string;
      adapterType: string;
      taskKey: string;
    }
  | {
      kind: "upsert";
      companyId: string;
      agentId: string;
      adapterType: string;
      taskKey: string;
      sessionParamsJson: Record<string, unknown> | null;
      sessionDisplayId: string | null;
      lastRunId: string;
      lastError: string | null;
    };

export type TerminalRunFinalizerInput = {
  runId: string;
  expectedStatus: string;
  scheduledRetryDueAt?: Date;
  status: TerminalHeartbeatRunStatus;
  runPatch: TerminalRunPatch;
  wakeupRequestId: string | null;
  wakeupStatus: string;
  wakeupError: string | null;
  taskSession?: TerminalTaskSessionMutation;
  issueUnlock?: { companyId: string; issueId: string } | null;
  runEvent?: {
    seq?: number;
    eventType: (typeof heartbeatRunEvents.$inferInsert)["eventType"];
    stream: (typeof heartbeatRunEvents.$inferInsert)["stream"];
    level: (typeof heartbeatRunEvents.$inferInsert)["level"];
    message: string;
    payload?: Record<string, unknown> | null;
  } | null;
  now?: Date;
};

/**
 * The only direct terminal heartbeatRuns writer. The run CAS is deliberately
 * first so losing ownership rolls back every wakeup, issue, session, and event
 * side effect in the same transaction.
 */
export async function finalizeTerminalRun(
  db: Db,
  input: TerminalRunFinalizerInput,
  executor: DbOrTransaction = db,
) {
  const now = input.now ?? new Date();
  try {
    const write = async (tx: DbOrTransaction) => {
      const terminalRun = await tx
        .update(heartbeatRuns)
        .set({ ...input.runPatch, status: input.status, updatedAt: now })
        .where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.status, input.expectedStatus),
          ...(input.scheduledRetryDueAt ? [lte(heartbeatRuns.scheduledRetryAt, input.scheduledRetryDueAt)] : []),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!terminalRun) throw new RunAlreadyFinalizedError();

      const taskSession = input.taskSession ?? { kind: "none" as const };
      if (taskSession.kind === "clear") {
        await tx
          .delete(agentTaskSessions)
          .where(and(
            eq(agentTaskSessions.companyId, taskSession.companyId),
            eq(agentTaskSessions.agentId, taskSession.agentId),
            eq(agentTaskSessions.taskKey, taskSession.taskKey),
            eq(agentTaskSessions.adapterType, taskSession.adapterType),
          ));
      } else if (taskSession.kind === "upsert") {
        await tx
          .insert(agentTaskSessions)
          .values({
            companyId: taskSession.companyId,
            agentId: taskSession.agentId,
            adapterType: taskSession.adapterType,
            taskKey: taskSession.taskKey,
            sessionParamsJson: taskSession.sessionParamsJson,
            sessionDisplayId: taskSession.sessionDisplayId,
            lastRunId: taskSession.lastRunId,
            lastError: taskSession.lastError,
          })
          .onConflictDoUpdate({
            target: [
              agentTaskSessions.companyId,
              agentTaskSessions.agentId,
              agentTaskSessions.adapterType,
              agentTaskSessions.taskKey,
            ],
            set: {
              sessionParamsJson: taskSession.sessionParamsJson,
              sessionDisplayId: taskSession.sessionDisplayId,
              lastRunId: taskSession.lastRunId,
              lastError: taskSession.lastError,
              updatedAt: now,
            },
          });
      }

      if (input.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: input.wakeupStatus,
            finishedAt: now,
            error: input.wakeupError,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, input.wakeupRequestId));
      }

      if (input.issueUnlock) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(issues.companyId, input.issueUnlock.companyId),
            eq(issues.id, input.issueUnlock.issueId),
            eq(issues.executionRunId, terminalRun.id),
          ));
      }

      const runEvent = input.runEvent;
      if (runEvent) {
        const eventSeq = runEvent.seq ?? await tx
          .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, terminalRun.id))
          .then((rows) => Number(rows[0]?.maxSeq ?? 0) + 1);
        await tx.insert(heartbeatRunEvents).values({
          companyId: terminalRun.companyId,
          runId: terminalRun.id,
          agentId: terminalRun.agentId,
          ...runEvent,
          seq: eventSeq,
        });
      }
      return terminalRun;
    };

    const run = executor === db ? await db.transaction(write) : await write(executor);
    return { run, updated: true as const };
  } catch (error) {
    if (!(error instanceof RunAlreadyFinalizedError)) throw error;
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .then((rows) => rows[0] ?? null);
    return { run, updated: false as const };
  }
}
