/**
 * job_supervisor.ts — one reaper loop for every server-managed process kind.
 *
 * The reaper ticks every 60 s and, for each stale job (no heartbeat for
 * HEARTBEAT_INTERVALS or more intervals), probes pid liveness and runs the
 * kind-specific recovery:
 *
 *  run          → existing markInProgressRunsFailed / fail-run path
 *  shift        → mark failed + kill leftover process group via killProcessTree
 *  chat         → mark stuck chat_run failed (queued/running with dead worker)
 *  global_session → mark session ended / expired
 *
 * Design notes:
 *  - Detached workers (runner_worker, chat_worker) are pid-probe-based; they
 *    don't tick heartbeats because they run out of process.  Their job rows
 *    are registered at spawn and reaped when the probe shows them dead.
 *  - In-process loops (global_session) can tick beatJob() on each iteration.
 *  - shift agents are detached+unref'd so also pid-probe-based.
 */

import {
  beatJob as _beatJob,
  completeJob,
  getDb,
  getRunById,
  listStaleJobs,
  updateRun,
  type JobRow,
} from "./db.js";
import { killProcessTree } from "./agent_execution.js";
import { updateChatRun } from "./chat_db.js";
import { isRunWorkerAlive } from "./runner_agent.js";
import { isProcessAlive } from "./process_utils.js";

export { beatJob } from "./db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the reaper wakes up. */
const REAP_INTERVAL_MS = 60_000;

/** A job is stale when its heartbeat is older than this many intervals. */
const HEARTBEAT_INTERVALS = 3;

// ---------------------------------------------------------------------------
// Kind-specific recovery
// ---------------------------------------------------------------------------

async function reapRunJob(job: JobRow): Promise<void> {
  // Targeted update: only fail the specific run identified by this job, not all
  // in-progress runs.  markInProgressRunsFailed is a boot-time bulk-sweep and
  // must not be used as a per-tick per-job handler (it would spuriously fail
  // unrelated runs on each reap tick).
  const run = getRunById(job.ref_id);
  if (run && isRunWorkerAlive(run.run_dir)) {
    // Worker is still alive; the heartbeat gap was spurious — beat the job row
    // on behalf of the detached worker so the next reap tick won't trigger again.
    // Do NOT call completeJob here: completing the job removes it from future
    // reaping, so if the worker later crashes it would never be reaped.
    _beatJob(job.id);
    return;
  }
  if (run) {
    const ACTIVE_STATUSES = new Set([
      "queued",
      "building",
      "ai_review",
      "testing",
      "waiting_for_input",
    ]);
    if (ACTIVE_STATUSES.has(run.status)) {
      updateRun(job.ref_id, {
        status: "failed",
        error: "runner process died (reaped by job supervisor)",
        finished_at: new Date().toISOString(),
      });
    }
  }
  completeJob(job.id, "failed");
}

async function reapShiftJob(job: JobRow): Promise<void> {
  const database = getDb();

  // Kill the process group if a pid was recorded.
  if (job.pid && isProcessAlive(job.pid)) {
    try {
      await killProcessTree(job.pid);
    } catch {
      // Best-effort; we mark failed regardless.
    }
  }

  // Mark the shift row failed so the scheduler can start a new one.
  const shift = database
    .prepare("SELECT * FROM shifts WHERE id = ? LIMIT 1")
    .get(job.ref_id) as { id: string; status: string } | undefined;
  if (shift && shift.status === "active") {
    const now = new Date().toISOString();
    database
      .prepare(
        `UPDATE shifts SET status = 'failed', completed_at = ?, error = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(now, "shift agent died (reaped by job supervisor)", shift.id);
  }
  completeJob(job.id, "failed");
}

async function reapChatJob(job: JobRow): Promise<void> {
  // Kill the worker process if still alive.
  if (job.pid && isProcessAlive(job.pid)) {
    try {
      await killProcessTree(job.pid);
    } catch {
      // Best-effort.
    }
  }

  // Mark the chat_run failed so the thread can enqueue a new one.
  const db = getDb();
  const chatRun = db
    .prepare("SELECT * FROM chat_runs WHERE id = ? LIMIT 1")
    .get(job.ref_id) as { id: string; status: string } | undefined;
  if (chatRun && (chatRun.status === "queued" || chatRun.status === "running")) {
    updateChatRun(chatRun.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "chat worker died (reaped by job supervisor)",
    });
  }
  completeJob(job.id, "failed");
}

async function reapGlobalSessionJob(job: JobRow): Promise<void> {
  // Global sessions run in-process; if the heartbeat is stale the server
  // loop must have crashed.  Mark the session ended so a fresh one can start.
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(job.ref_id) as { id: string; state: string } | undefined;
  if (session && session.state !== "ended") {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE global_agent_sessions SET state = 'ended', ended_at = ?, updated_at = ?
       WHERE id = ? AND state != 'ended'`
    ).run(now, now, session.id);
  }
  completeJob(job.id, "failed");
}

// ---------------------------------------------------------------------------
// Reaper tick
// ---------------------------------------------------------------------------

async function reaperTick(): Promise<void> {
  const stale = listStaleJobs(REAP_INTERVAL_MS, HEARTBEAT_INTERVALS);
  for (const job of stale) {
    try {
      switch (job.kind) {
        case "run":
          await reapRunJob(job);
          break;
        case "shift":
          await reapShiftJob(job);
          break;
        case "chat":
          await reapChatJob(job);
          break;
        case "global_session":
          await reapGlobalSessionJob(job);
          break;
        default: {
          // Unknown kind — just mark it done so it doesn't block future reaps.
          const _exhaustive: never = job.kind;
          void _exhaustive;
          completeJob(job.id, "failed");
          break;
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[job-supervisor] reap failed for job ${job.id} (${job.kind}/${job.ref_id}):`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Startup exports
// ---------------------------------------------------------------------------

let reaperTimer: NodeJS.Timeout | null = null;

export function startJobSupervisor(): void {
  if (reaperTimer) return;
  // Run an initial tick immediately, then every REAP_INTERVAL_MS.
  void reaperTick();
  reaperTimer = setInterval(() => {
    void reaperTick();
  }, REAP_INTERVAL_MS);
}

// Exported for tests.
export const __test__ = {
  isProcessAlive,
  reapRunJob,
  reapShiftJob,
  reapChatJob,
  reapGlobalSessionJob,
  reaperTick,
  REAP_INTERVAL_MS,
  HEARTBEAT_INTERVALS,
};
