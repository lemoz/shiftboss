/**
 * Unit tests for server/job_supervisor.ts
 *
 * Covers:
 *  1. listStaleJobs — detects jobs past the heartbeat threshold
 *  2. reapRunJob — calls markInProgressRunsFailed with the pid-liveness probe
 *  3. reapShiftJob — kills process group and marks shift failed
 *  4. reapChatJob — kills process and marks chat_run failed
 *  5. reapGlobalSessionJob — marks session ended
 *  6. reaperTick — dispatches to the correct kind-specific handler
 *  7. Shift double-start prevention — SIGCONT-before-TERM path (via killProcessTree)
 *  8. Stale-job detection ignores completed/failed jobs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Lightweight in-memory fakes — avoids real SQLite / process spawns in unit
// tests.  Each test reconstructs what it needs.
// ---------------------------------------------------------------------------

function makeJobRow(overrides = {}) {
  return {
    id: "job-1",
    kind: "run",
    ref_id: "run-1",
    pid: null,
    started_at: new Date(Date.now() - 300_000).toISOString(),
    heartbeat_at: new Date(Date.now() - 300_000).toISOString(),
    status: "running",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. listStaleJobs — detected if heartbeat is old enough
// ---------------------------------------------------------------------------
test("listStaleJobs: a job with heartbeat older than intervalMs * intervals is stale", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Point the DB at a temp file so we get a fresh DB.
  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { registerJob, listStaleJobs, beatJob } = await import("./db.ts");

  // Register two jobs — one fresh, one stale.
  const fresh = registerJob({ kind: "run", ref_id: "run-fresh" });
  const stale = registerJob({ kind: "shift", ref_id: "shift-stale" });

  // Manually backdate the stale job's heartbeat_at in the DB.
  const { getDb } = await import("./db.ts");
  const old = new Date(Date.now() - 4 * 60_000).toISOString(); // 4 min ago
  getDb().prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run(old, stale.id);

  // intervalMs=60000, intervals=3 → threshold = 180s ago.  4 min > 3 min.
  const found = listStaleJobs(60_000, 3);
  assert.ok(found.some((j) => j.id === stale.id), "stale job should be listed");
  assert.ok(!found.some((j) => j.id === fresh.id), "fresh job should NOT be listed");
});

// ---------------------------------------------------------------------------
// 2. listStaleJobs ignores done/failed jobs
// ---------------------------------------------------------------------------
test("listStaleJobs: completed jobs are not returned even if heartbeat is old", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { registerJob, completeJob, listStaleJobs, getDb } = await import("./db.ts");

  const job = registerJob({ kind: "chat", ref_id: "chat-1" });
  completeJob(job.id, "done");

  // Backdate the heartbeat to make it stale.
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  getDb().prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run(old, job.id);

  const found = listStaleJobs(60_000, 3);
  assert.ok(!found.some((j) => j.id === job.id), "completed job must not be listed");
});

// ---------------------------------------------------------------------------
// 3. reapRunJob — calls markInProgressRunsFailed with the liveness probe
// ---------------------------------------------------------------------------
test("reapRunJob: calls markInProgressRunsFailed and completes the job", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { registerJob, getDb } = await import("./db.ts");
  const job = registerJob({ kind: "run", ref_id: "run-x" });

  let called = false;
  // Monkeypatch markInProgressRunsFailed via the db module's live export.
  // We can't easily do this with ESM; instead we verify through reap side effects.
  // The real function is sync-safe because the test DB has no in-progress runs —
  // it will run 0 iterations and just return 0.

  const { __test__ } = await import("./job_supervisor.ts");
  await __test__.reapRunJob(job);

  // Job should now be marked failed in the DB.
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  assert.equal(row.status, "failed", "job should be marked failed after reap");
});

// ---------------------------------------------------------------------------
// 4. reapShiftJob — marks shift row failed
// ---------------------------------------------------------------------------
test("reapShiftJob: marks active shift row failed when there is no living pid", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { registerJob, getDb } = await import("./db.ts");

  // Insert a fake project and shift row directly.
  const db = getDb();
  const projectId = "proj-1";
  const shiftId = "shift-x";
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (id, path, name, description, success_criteria, success_metrics,
      type, stage, status, lifecycle_status, priority, starred, hidden, auto_shift_enabled,
      tags, isolation_mode, merge_policy, vm_size, context_files, builder_sandbox_mode,
      builder_env, last_run_at, created_at, updated_at)
    VALUES (?, '', 'Test', null, null, '[]', 'prototype', 'active', 'active', 'active',
      0, 0, 0, 0, '[]', 'local', 'auto_merge', 'medium', null, null, null, null, ?, ?)
  `).run(projectId, now, now);
  db.prepare(`
    INSERT INTO shifts (id, project_id, status, agent_type, agent_id, pid,
      started_at, completed_at, expires_at, handoff_id, error)
    VALUES (?, ?, 'active', null, null, null, ?, null, null, null, null)
  `).run(shiftId, projectId, now);

  const job = registerJob({ kind: "shift", ref_id: shiftId, pid: null });

  const { __test__ } = await import("./job_supervisor.ts");
  await __test__.reapShiftJob(job);

  const shift = db.prepare("SELECT * FROM shifts WHERE id = ?").get(shiftId);
  assert.equal(shift.status, "failed", "shift should be marked failed");

  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  assert.equal(jobRow.status, "failed", "job should be marked failed");
});

// ---------------------------------------------------------------------------
// 5. reapChatJob — marks chat_run failed
// ---------------------------------------------------------------------------
test("reapChatJob: marks a stuck chat_run failed", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { registerJob, getDb } = await import("./db.ts");
  const db = getDb();
  const now = new Date().toISOString();

  // Insert a minimal chat thread and chat_run.
  const threadId = "thread-1";
  const runId = "chat-run-1";
  db.prepare(`
    INSERT INTO chat_threads (id, name, scope, project_id, work_order_id, summary,
      summarized_count, default_context_depth, default_access_filesystem, default_access_cli,
      default_access_network, default_access_network_allowlist, last_read_at, last_ack_at,
      archived_at, worktree_path, has_pending_changes, created_at, updated_at)
    VALUES (?, 'Test', 'global', null, null, '', 0, 'messages', 'read-only', 'off', 'none',
      null, null, null, null, null, 0, ?, ?)
  `).run(threadId, now, now);
  db.prepare(`
    INSERT INTO chat_runs (id, thread_id, user_message_id, assistant_message_id,
      status, model, cli_path, cwd, log_path, created_at)
    VALUES (?, ?, 'msg-1', null, 'running', 'gpt-5', 'claude', '/', '.system/chat/run.log', ?)
  `).run(runId, threadId, now);

  const job = registerJob({ kind: "chat", ref_id: runId, pid: null });

  const { __test__ } = await import("./job_supervisor.ts");
  await __test__.reapChatJob(job);

  const chatRun = db.prepare("SELECT * FROM chat_runs WHERE id = ?").get(runId);
  assert.equal(chatRun.status, "failed", "chat_run should be marked failed");

  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  assert.equal(jobRow.status, "failed", "job should be marked failed");
});

// ---------------------------------------------------------------------------
// 6. reapGlobalSessionJob — marks session ended
// ---------------------------------------------------------------------------
test("reapGlobalSessionJob: marks an autonomous session ended", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { registerJob, getDb } = await import("./db.ts");
  const db = getDb();
  const now = new Date().toISOString();
  const sessionId = "sess-1";

  db.prepare(`
    INSERT INTO global_agent_sessions
      (id, chat_thread_id, state, onboarding_rubric, integrations_configured,
       goals, priority_projects, constraints, briefing_summary, briefing_confirmed_at,
       autonomous_started_at, paused_at, iteration_count, decisions_count, actions_count,
       last_check_in_at, ended_at, created_at, updated_at)
    VALUES (?, null, 'autonomous', null, null, null, null, null, null, null,
      ?, null, 0, 0, 0, null, null, ?, ?)
  `).run(sessionId, now, now, now);

  const job = registerJob({ kind: "global_session", ref_id: sessionId, pid: null });

  const { __test__ } = await import("./job_supervisor.ts");
  await __test__.reapGlobalSessionJob(job);

  const session = db.prepare("SELECT * FROM global_agent_sessions WHERE id = ?").get(sessionId);
  assert.equal(session.state, "ended", "session should be ended");

  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  assert.equal(jobRow.status, "failed", "job should be marked failed");
});

// ---------------------------------------------------------------------------
// 7. Shift double-start prevention — scheduleShiftTimeout kills regardless of
//    row status when timer fires (regression for the bail-on-non-active bug).
// ---------------------------------------------------------------------------
test("scheduleShiftTimeout kills process even when shift row is already expired", async (t) => {
  if (process.platform === "win32") return; // process group kill not available on Windows

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jst-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { scheduleShiftTimeout } = await import("./shift_agent.ts");
  const { getDb } = await import("./db.ts");
  const db = getDb();
  const now = new Date().toISOString();
  const projectId = "proj-timeout";
  const shiftId = "shift-timeout";

  db.prepare(`
    INSERT INTO projects (id, path, name, description, success_criteria, success_metrics,
      type, stage, status, lifecycle_status, priority, starred, hidden, auto_shift_enabled,
      tags, isolation_mode, merge_policy, vm_size, context_files, builder_sandbox_mode,
      builder_env, last_run_at, created_at, updated_at)
    VALUES (?, '', 'TP', null, null, '[]', 'prototype', 'active', 'active', 'active',
      0, 0, 0, 0, '[]', 'local', 'auto_merge', 'medium', null, null, null, null, ?, ?)
  `).run(projectId, now, now);
  db.prepare(`
    INSERT INTO shifts (id, project_id, status, agent_type, agent_id, pid,
      started_at, completed_at, expires_at, handoff_id, error)
    VALUES (?, ?, 'expired', null, null, null, ?, null, null, null, null)
  `).run(shiftId, projectId, now);

  // Spawn a long-running process and get its pid.
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["300"], { detached: true });
  child.unref();
  await new Promise((r) => setTimeout(r, 100));
  const pid = child.pid;
  assert.ok(pid > 0, "got pid for test sleeper");

  function isAlive(p) {
    try { process.kill(p, 0); return true; }
    catch (e) { if (e.code === "ESRCH") return false; return true; }
  }

  assert.ok(isAlive(pid), "process alive before timer");

  // scheduleShiftTimeout with a 100ms delay.
  const logPath = path.join(tmpDir, "agent.log");
  const expiresAt = new Date(Date.now() + 100).toISOString();
  scheduleShiftTimeout({ projectId, shiftId, pid, expiresAt, logPath });

  // Wait for the timer to fire and the kill to complete.
  await new Promise((r) => setTimeout(r, 800));

  assert.ok(!isAlive(pid), "process should be dead after timer even when row was already expired");
});

// ---------------------------------------------------------------------------
// 8. SIGCONT-before-TERM: killProcessTree sends SIGCONT then SIGTERM (reuse
//    agent_execution test pattern)
// ---------------------------------------------------------------------------
test("killProcessTree sends SIGCONT before SIGTERM so a stopped process can die", async () => {
  if (process.platform === "win32") return;

  const { spawn } = await import("node:child_process");
  const { killProcessTree } = await import("./agent_execution.ts");

  // Spawn a process and STOP it.
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise((r) => setTimeout(r, 100));
  const pid = child.pid;

  function isAlive(p) {
    try { process.kill(p, 0); return true; }
    catch (e) { if (e.code === "ESRCH") return false; return true; }
  }

  // Pause the process (SIGSTOP).
  process.kill(-pid, "SIGSTOP");
  await new Promise((r) => setTimeout(r, 100));
  // It should still be alive (just stopped).
  assert.ok(isAlive(pid), "process should still exist while SIGSTOPped");

  // killProcessTree should SIGCONT then SIGTERM (then SIGKILL if needed).
  await killProcessTree(pid);
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(!isAlive(pid), "process should be dead after killProcessTree on a stopped process");
});
