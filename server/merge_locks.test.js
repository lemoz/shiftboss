import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-merge-locks-"));
const dbPath = path.join(tmpDir, "merge-locks.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const {
  acquireMergeLock,
  getDb,
  getMergeLock,
  releaseMergeLock,
} = await import("./db.ts");

function seedProject() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO projects (
      id,
      path,
      name,
      description,
      type,
      stage,
      status,
      priority,
      starred,
      hidden,
      tags,
      isolation_mode,
      vm_size,
      last_run_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "project-1",
    "/tmp/project-1",
    "Project 1",
    null,
    "app",
    "active",
    "ok",
    1,
    0,
    0,
    "[]",
    "local",
    "medium",
    null,
    now,
    now
  );
}

after(() => {
  const db = getDb();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalDbPath === undefined) {
    delete process.env.CONTROL_CENTER_DB_PATH;
  } else {
    process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  }
  if (originalPccDbPath === undefined) {
    delete process.env.PCC_DATABASE_PATH;
  } else {
    process.env.PCC_DATABASE_PATH = originalPccDbPath;
  }
});

test("merge locks serialize acquisition across runs", () => {
  seedProject();
  const projectId = "project-1";
  const runA = "run-a";
  const runB = "run-b";

  assert.equal(acquireMergeLock(projectId, runA), true);
  assert.equal(getMergeLock(projectId)?.run_id, runA);

  assert.equal(acquireMergeLock(projectId, runB), false);
  assert.equal(getMergeLock(projectId)?.run_id, runA);

  releaseMergeLock(projectId, runB);
  assert.equal(getMergeLock(projectId)?.run_id, runA);

  releaseMergeLock(projectId, runA);
  assert.equal(getMergeLock(projectId), null);

  assert.equal(acquireMergeLock(projectId, runB), true);
  assert.equal(getMergeLock(projectId)?.run_id, runB);

  releaseMergeLock(projectId, runB);
  assert.equal(getMergeLock(projectId), null);
});

test("acquireMergeLock clears stale locks (no heartbeat fallback to acquired_at TTL)", () => {
  seedProject();
  const projectId = "project-1";
  const db = getDb();
  // Insert a lock with no heartbeat_at that is older than the TTL
  const staleAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO merge_locks (project_id, run_id, acquired_at) VALUES (?, ?, ?)"
  ).run(projectId, "run-stale", staleAt);

  assert.equal(getMergeLock(projectId)?.run_id, "run-stale");
  assert.equal(acquireMergeLock(projectId, "run-fresh"), true);
  assert.equal(getMergeLock(projectId)?.run_id, "run-fresh");

  releaseMergeLock(projectId, "run-fresh");
  assert.equal(getMergeLock(projectId), null);
});

test("acquireMergeLock does NOT steal a lock whose heartbeat is recent (legitimate hold)", async () => {
  const { MERGE_LOCK_HEARTBEAT_INTERVAL_MS, refreshMergeLockHeartbeat } =
    await import("./db.ts");
  seedProject();
  const projectId = "project-1";

  // run-A acquires the lock
  assert.equal(acquireMergeLock(projectId, "run-a"), true);

  // Immediately refresh heartbeat so it is fresh
  refreshMergeLockHeartbeat(projectId, "run-a");

  // run-B should NOT be able to steal (heartbeat is fresh)
  assert.equal(acquireMergeLock(projectId, "run-b"), false);
  assert.equal(getMergeLock(projectId)?.run_id, "run-a");

  releaseMergeLock(projectId, "run-a");
  assert.equal(getMergeLock(projectId), null);
});

test("acquireMergeLock steals a lock whose heartbeat is stale (3+ missed beats)", async () => {
  const { MERGE_LOCK_HEARTBEAT_INTERVAL_MS, refreshMergeLockHeartbeat } =
    await import("./db.ts");
  seedProject();
  const projectId = "project-1";
  const db = getDb();

  // Insert a lock directly with a stale heartbeat (> 3× heartbeat interval ago)
  const staleHeartbeat = new Date(
    Date.now() - 4 * MERGE_LOCK_HEARTBEAT_INTERVAL_MS
  ).toISOString();
  const acquiredAt = new Date(Date.now() - 5 * MERGE_LOCK_HEARTBEAT_INTERVAL_MS).toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO merge_locks (project_id, run_id, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)"
  ).run(projectId, "run-dead", acquiredAt, staleHeartbeat);

  assert.equal(getMergeLock(projectId)?.run_id, "run-dead");

  // run-b should steal the stale lock
  assert.equal(acquireMergeLock(projectId, "run-b"), true);
  assert.equal(getMergeLock(projectId)?.run_id, "run-b");

  releaseMergeLock(projectId, "run-b");
  assert.equal(getMergeLock(projectId), null);
});
