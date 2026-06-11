/**
 * Unit tests for autopilot rejection / failure-counter fixes.
 *
 * Coverage:
 *  1. rejected/superseded runs count toward consecutive failures
 *  2. autopilot candidates exclude WOs with needs_human=1
 *  3. markRejectedWorkOrderPaused sets needs_human=1 on the DB row
 *  4. clearWorkOrderNeedsHuman resets the flag
 *  5. failure counter resets after a merged run follows rejections
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-autopilot-"));
const dbPath = path.join(tmpDir, "autopilot.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const {
  getDb,
  setWorkOrderNeedsHuman,
  clearWorkOrderNeedsHuman,
  getWorkOrderNeedsHuman,
  updateAutopilotPolicy,
} = await import("./db.ts");

const {
  markRejectedWorkOrderPaused,
  getAutopilotSnapshot,
  getAutopilotCandidates,
} = await import("./autopilot.ts");

const db = getDb();
const now = new Date().toISOString();

// ── helpers ───────────────────────────────────────────────────────────────────

function insertProject(id, dirOverride) {
  const projPath = dirOverride ?? `/tmp/${id}`;
  db.prepare(
    `INSERT OR IGNORE INTO projects (
      id, path, name, description, type, stage, status, priority, starred, hidden,
      tags, isolation_mode, vm_size, last_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projPath, id, null, "app", "active", "ok", 1, 0, 0, "[]", "local", "medium", null, now, now);
  return projPath;
}

function insertWorkOrder(projectId, id, status = "ready", needsHuman = 0) {
  db.prepare(
    `INSERT OR IGNORE INTO work_orders (id, project_id, title, status, priority, tags, created_at, updated_at, needs_human)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, `Title ${id}`, status, 1, "[]", now, now, needsHuman);
}

function insertRunAt(projectId, workOrderId, runId, status, triggeredBy, ts) {
  db.prepare(
    `INSERT OR IGNORE INTO runs (
      id, project_id, work_order_id, provider, triggered_by, status,
      iteration, builder_iteration, run_dir, log_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, projectId, workOrderId, "codex", triggeredBy, status, 1, 1,
    tmpDir, path.join(tmpDir, `${runId}.log`), ts);
}

// ── cleanup ───────────────────────────────────────────────────────────────────

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  if (originalPccDbPath === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = originalPccDbPath;
});

// ── Test 1: rejected runs count toward consecutive failures ────────────────────

test("failure counter counts 3 consecutive rejected runs and triggers paused state", () => {
  insertProject("proj-rej");
  insertWorkOrder("proj-rej", "wo-rej-a");
  const t = (offset) => new Date(Date.now() - offset).toISOString();
  insertRunAt("proj-rej", "wo-rej-a", "run-rej-1", "rejected", "autopilot", t(3000));
  insertRunAt("proj-rej", "wo-rej-a", "run-rej-2", "rejected", "autopilot", t(2000));
  insertRunAt("proj-rej", "wo-rej-a", "run-rej-3", "rejected", "autopilot", t(1000));

  updateAutopilotPolicy("proj-rej", { enabled: true, stop_on_failure_count: 3 });

  const snapshot = getAutopilotSnapshot("proj-rej");
  assert.ok(snapshot, "snapshot should exist");
  assert.equal(snapshot.status.failure_count, 3, "3 rejected runs → failure_count=3");
  assert.equal(snapshot.status.state, "paused", "state should be paused after 3 rejections");
});

// ── Test 2: superseded runs count toward consecutive failures ─────────────────

test("failure counter counts superseded runs as failures", () => {
  insertProject("proj-sup");
  insertWorkOrder("proj-sup", "wo-sup-a");
  const t = (offset) => new Date(Date.now() - offset).toISOString();
  insertRunAt("proj-sup", "wo-sup-a", "run-sup-1", "superseded", "autopilot", t(2000));
  insertRunAt("proj-sup", "wo-sup-a", "run-sup-2", "superseded", "autopilot", t(1000));

  updateAutopilotPolicy("proj-sup", { enabled: true, stop_on_failure_count: 5 });

  const snapshot = getAutopilotSnapshot("proj-sup");
  assert.ok(snapshot);
  assert.equal(snapshot.status.failure_count, 2, "2 superseded runs → failure_count=2");
});

// ── Test 3: needs_human=1 WOs excluded from autopilot candidates ───────────────

test("autopilot candidates exclude WOs with needs_human=1", () => {
  // Set up a directory with WO markdown files so readWorkOrderDependsOn works
  const projDir = path.join(tmpDir, "proj-nh");
  const woDir = path.join(projDir, "work_orders");
  fs.mkdirSync(woDir, { recursive: true });
  fs.writeFileSync(path.join(woDir, "wo-nh-ok.md"), "---\nid: wo-nh-ok\ntitle: OK\n---\n");
  fs.writeFileSync(path.join(woDir, "wo-nh-paused.md"), "---\nid: wo-nh-paused\ntitle: Paused\n---\n");

  insertProject("proj-nh", projDir);
  insertWorkOrder("proj-nh", "wo-nh-ok", "ready", 0);
  insertWorkOrder("proj-nh", "wo-nh-paused", "ready", 1);

  updateAutopilotPolicy("proj-nh", { enabled: true, stop_on_failure_count: 5 });

  const result = getAutopilotCandidates("proj-nh");
  assert.ok(result, "result should exist");
  const ids = result.candidates.map((c) => c.id);
  assert.ok(ids.includes("wo-nh-ok"), "normal WO should be a candidate");
  assert.ok(!ids.includes("wo-nh-paused"), "needs_human WO must NOT be a candidate");
});

// ── Test 4: markRejectedWorkOrderPaused sets needs_human ──────────────────────

test("markRejectedWorkOrderPaused sets needs_human=1 on the DB row", () => {
  insertProject("proj-pause");
  insertWorkOrder("proj-pause", "wo-pause-a", "ready", 0);

  assert.equal(getWorkOrderNeedsHuman("proj-pause", "wo-pause-a"), false, "flag starts clear");

  markRejectedWorkOrderPaused("proj-pause", "wo-pause-a");

  assert.equal(getWorkOrderNeedsHuman("proj-pause", "wo-pause-a"), true, "flag should be set after pause");
});

// ── Test 5: clearWorkOrderNeedsHuman resets the flag ─────────────────────────

test("clearWorkOrderNeedsHuman resets needs_human to 0", () => {
  insertProject("proj-clear");
  insertWorkOrder("proj-clear", "wo-clear-a", "ready", 1);

  assert.equal(getWorkOrderNeedsHuman("proj-clear", "wo-clear-a"), true, "flag starts set");

  clearWorkOrderNeedsHuman("proj-clear", "wo-clear-a");

  assert.equal(getWorkOrderNeedsHuman("proj-clear", "wo-clear-a"), false, "flag should be cleared");
});

// ── Test 6: failure counter resets after a merged run ─────────────────────────

test("failure counter resets to 0 when newest run is merged (overrides prior rejections)", () => {
  insertProject("proj-mixed");
  insertWorkOrder("proj-mixed", "wo-mixed-a");
  const t = (offset) => new Date(Date.now() - offset).toISOString();

  // Ordered by created_at DESC: newest = merged, older = two rejects
  insertRunAt("proj-mixed", "wo-mixed-a", "run-mixed-rej1", "rejected", "autopilot", t(3000));
  insertRunAt("proj-mixed", "wo-mixed-a", "run-mixed-rej2", "rejected", "autopilot", t(2000));
  insertRunAt("proj-mixed", "wo-mixed-a", "run-mixed-merged", "merged", "autopilot", t(1000));

  updateAutopilotPolicy("proj-mixed", { enabled: true, stop_on_failure_count: 3 });

  const snapshot = getAutopilotSnapshot("proj-mixed");
  assert.ok(snapshot);
  // Newest run is merged (PASSED_STATUSES) → counter should stop at 0
  assert.equal(snapshot.status.failure_count, 0, "merged run should reset failure counter to 0");
  assert.equal(snapshot.status.state, "idle", "state should be idle (not paused) after a merged run");
});
