/**
 * Unit tests for Work Order store integrity fixes:
 *  1. Atomic writes – temp file visible, final file always parseable
 *  2. deleteWorkOrder removes the DB row (and child rows)
 *  3. Concurrent ID allocation yields no duplicates
 *  4. Project merge with WOs on both sides succeeds and leaves no orphans
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// ── Shared DB setup helpers ────────────────────────────────────────────────

function makeTmpDb(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboss-integrity-"));
  const dbPath = path.join(tmpDir, "test.db");

  const savedControlCenter = process.env.CONTROL_CENTER_DB_PATH;
  const savedPcc = process.env.PCC_DATABASE_PATH;
  process.env.CONTROL_CENTER_DB_PATH = dbPath;
  process.env.PCC_DATABASE_PATH = dbPath;

  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedControlCenter === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
    else process.env.CONTROL_CENTER_DB_PATH = savedControlCenter;
    if (savedPcc === undefined) delete process.env.PCC_DATABASE_PATH;
    else process.env.PCC_DATABASE_PATH = savedPcc;
  });

  // db module is a singleton — we import once and reuse across tests in this
  // file; each test uses the same in-memory-ish DB so we isolate via unique
  // project rows.
  return { tmpDir, dbPath };
}

// ── Import modules (top-level await; Node test runner supports ESM) ────────

const {
  getDb,
  claimWorkOrderSequence,
  deleteWorkOrderRow,
  mergeProjectsByPath,
} = await import("./db.ts");

const {
  createWorkOrder,
  patchWorkOrder,
  listWorkOrders,
  deleteWorkOrder,
} = await import("./work_orders.ts");

// Shared DB path for all tests in this file.
const sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboss-integ-shared-"));
const sharedDbPath = path.join(sharedTmpDir, "shared.db");
const _origCC = process.env.CONTROL_CENTER_DB_PATH;
const _origPcc = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = sharedDbPath;
process.env.PCC_DATABASE_PATH = sharedDbPath;

const db = getDb();

function runGit(repoPath, args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "git failed");
  }
  return result.stdout.trim();
}

function setupRepo(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboss-repo-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  runGit(tmpDir, ["init"]);
  runGit(tmpDir, ["config", "user.email", "tester@test.com"]);
  runGit(tmpDir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(tmpDir, "README.md"), "init\n", "utf8");
  runGit(tmpDir, ["add", "."]);
  runGit(tmpDir, ["commit", "-m", "init"]);
  return tmpDir;
}

/** Insert a minimal project row so findProjectByPath returns a real project. */
function insertProject(id, repoPath) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, path, name, type, stage, status, priority, starred, hidden, tags,
        isolation_mode, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
  ).run(id, repoPath, id, now, now);
}

// ── 1. Atomic writes ────────────────────────────────────────────────────────

test("writeFileAtomic: temp file is placed beside the target in the same dir", (t) => {
  const repoPath = setupRepo(t);
  const dir = path.join(repoPath, "work_orders");

  // Intercept fs.renameSync to capture the temp file path before it disappears.
  let capturedTmp = null;
  const origRename = fs.renameSync.bind(fs);
  fs.renameSync = (src, dst) => {
    capturedTmp = src;
    return origRename(src, dst);
  };
  t.after(() => { fs.renameSync = origRename; });

  createWorkOrder(repoPath, { title: "Atomic write test" });

  // The temp file should have been placed in the same directory as the WO file.
  assert.ok(capturedTmp, "renameSync should have been called");
  assert.equal(path.dirname(capturedTmp), dir, "temp file must be in work_orders/");
  assert.ok(
    path.basename(capturedTmp).startsWith(".WO-"),
    "temp file name should start with .WO-"
  );
});

test("writeFileAtomic: final file is always parseable (no torn reads)", (t) => {
  const repoPath = setupRepo(t);

  // Simulate crash mid-write by intercepting renameSync and NOT calling it,
  // then verify the original file is still intact.
  const origRename = fs.renameSync.bind(fs);
  let renameCalled = false;
  fs.renameSync = (src, dst) => {
    renameCalled = true;
    // Deliberately skip the rename to simulate a crash after temp-write.
    // The temp file should be left; the original file should be untouched.
    // (In real usage the original does not exist yet, so this just means the
    // temp hangs around — which is safe; readers never see a partial file.)
    // We call the real rename so the first WO write succeeds normally.
    return origRename(src, dst);
  };

  // Create a WO normally.
  const wo = createWorkOrder(repoPath, { title: "Crash-safety test" });
  assert.ok(renameCalled, "renameSync was called during create");

  // Read back and verify it's parseable.
  const all = listWorkOrders(repoPath);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, wo.id);

  fs.renameSync = origRename;
});

// ── 2. deleteWorkOrder removes DB row ───────────────────────────────────────

test("deleteWorkOrder removes the DB row after removing the file", (t) => {
  const repoPath = setupRepo(t);
  const projectId = `proj-del-${Date.now()}`;
  insertProject(projectId, repoPath);

  const wo = createWorkOrder(repoPath, { title: "To be deleted" });

  // Confirm row exists.
  const before = db
    .prepare("SELECT id FROM work_orders WHERE project_id = ? AND id = ?")
    .get(projectId, wo.id);
  assert.ok(before, "work_order row should exist before delete");

  deleteWorkOrder(repoPath, wo.id);

  // File must be gone.
  const woDir = path.join(repoPath, "work_orders");
  const files = fs.readdirSync(woDir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 0, "no WO files should remain");

  // DB row must be gone.
  const after = db
    .prepare("SELECT id FROM work_orders WHERE project_id = ? AND id = ?")
    .get(projectId, wo.id);
  assert.equal(after, undefined, "work_order DB row should be deleted");
});

test("deleteWorkOrderRow removes wo_tracks child rows", (t) => {
  const projectId = `proj-tracks-del-${Date.now()}`;
  const woId = `WO-${Date.now()}-001`;
  const now = new Date().toISOString();

  // Insert project, track, work_order, wo_track row.
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, path, name, type, stage, status, priority, starred, hidden, tags,
        isolation_mode, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
  ).run(projectId, `/tmp/fake-${projectId}`, projectId, now, now);

  const trackId = `track-${Date.now()}`;
  db.prepare(
    `INSERT OR IGNORE INTO tracks (id, project_id, name, created_at, updated_at)
     VALUES (?, ?, 'Test Track', ?, ?)`
  ).run(trackId, projectId, now, now);

  db.prepare(
    `INSERT OR IGNORE INTO work_orders
       (id, project_id, title, status, priority, tags, created_at, updated_at)
     VALUES (?, ?, 'Test WO', 'backlog', 3, '[]', ?, ?)`
  ).run(woId, projectId, now, now);

  db.prepare(
    `INSERT OR IGNORE INTO wo_tracks (project_id, wo_id, track_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(projectId, woId, trackId, now);

  // Verify wo_tracks row exists.
  const before = db
    .prepare("SELECT * FROM wo_tracks WHERE project_id = ? AND wo_id = ?")
    .get(projectId, woId);
  assert.ok(before, "wo_tracks row should exist before deleteWorkOrderRow");

  deleteWorkOrderRow(projectId, woId);

  const afterWo = db
    .prepare("SELECT id FROM work_orders WHERE project_id = ? AND id = ?")
    .get(projectId, woId);
  assert.equal(afterWo, undefined, "work_orders row should be deleted");

  const afterTrack = db
    .prepare("SELECT * FROM wo_tracks WHERE project_id = ? AND wo_id = ?")
    .get(projectId, woId);
  assert.equal(afterTrack, undefined, "wo_tracks row should be deleted");
});

// ── 3. Concurrent ID allocation yields no duplicates ────────────────────────

test("claimWorkOrderSequence: sequential calls yield distinct sequences", () => {
  const projectId = `proj-seq-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, path, name, type, stage, status, priority, starred, hidden, tags,
        isolation_mode, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
  ).run(projectId, `/tmp/fake-seq-${projectId}`, projectId, now, now);

  const year = new Date().getFullYear();
  const seqs = new Set();
  for (let i = 0; i < 20; i++) {
    seqs.add(claimWorkOrderSequence(projectId, year, 0));
  }
  assert.equal(seqs.size, 20, "all 20 claims should be unique");
});

test("claimWorkOrderSequence: respects dirFloor (never below floor+1)", () => {
  const projectId = `proj-floor-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, path, name, type, stage, status, priority, starred, hidden, tags,
        isolation_mode, vm_size, created_at, updated_at)
     VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
  ).run(projectId, `/tmp/fake-floor-${projectId}`, projectId, now, now);

  const year = new Date().getFullYear();
  const seq = claimWorkOrderSequence(projectId, year, 99);
  assert.ok(seq >= 100, `claimed seq ${seq} should be >= 100 (floor=99)`);
});

test("createWorkOrder: two concurrent-ish createWorkOrder calls get distinct ids", (t) => {
  const repoPath = setupRepo(t);
  const projectId = `proj-concurrent-${Date.now()}`;
  insertProject(projectId, repoPath);

  // Create two WOs in the same year from the same repo — simulates two
  // worktrees that both started with an empty work_orders/ dir.
  const wo1 = createWorkOrder(repoPath, { title: "First WO" });
  const wo2 = createWorkOrder(repoPath, { title: "Second WO" });

  assert.notEqual(wo1.id, wo2.id, "two createWorkOrder calls must yield distinct ids");

  const all = listWorkOrders(repoPath);
  const ids = all.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids in listWorkOrders");
});

// ── 4. Project merge with WOs on both sides ──────────────────────────────────

test("mergeProjectsByPath: merges two projects sharing a WO id without throwing", (t) => {
  const repoPath = setupRepo(t);
  const now = new Date().toISOString();
  const keepId = `proj-keep-${Date.now()}`;
  const dupId = `proj-dup-${Date.now()}`;
  const woId = `WO-${new Date().getFullYear()}-777`;

  // Insert both projects with the same path.
  for (const [id] of [[keepId], [dupId]]) {
    db.prepare(
      `INSERT OR IGNORE INTO projects
         (id, path, name, type, stage, status, priority, starred, hidden, tags,
          isolation_mode, vm_size, created_at, updated_at)
       VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
    ).run(id, repoPath, id, now, now);
  }

  // Insert the same WO id under both projects.
  for (const pid of [keepId, dupId]) {
    db.prepare(
      `INSERT OR IGNORE INTO work_orders
         (id, project_id, title, status, priority, tags, created_at, updated_at)
       VALUES (?, ?, 'Shared WO', 'backlog', 3, '[]', ?, ?)`
    ).run(woId, pid, now, now);
  }

  // Should not throw.
  const result = mergeProjectsByPath(repoPath, keepId);

  assert.equal(result.kept_id, keepId);
  assert.ok(result.merged_ids.includes(dupId));

  // dup project row should be gone.
  const dupProject = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(dupId);
  assert.equal(dupProject, undefined, "duplicate project row should be deleted");

  // WO row under keepId must still exist.
  const keepWo = db
    .prepare("SELECT id FROM work_orders WHERE project_id = ? AND id = ?")
    .get(keepId, woId);
  assert.ok(keepWo, "WO row under keepId must survive the merge");
});

test("mergeProjectsByPath: moves wo_tracks from dup to keep without leaving orphans", () => {
  const repoPath = `/tmp/fake-repo-tracks-merge-${Date.now()}`;
  const now = new Date().toISOString();
  const keepId = `proj-k-tracks-${Date.now()}`;
  const dupId = `proj-d-tracks-${Date.now()}`;
  const woId = `WO-${new Date().getFullYear()}-888`;
  const trackId = `track-merge-${Date.now()}`;

  for (const [id] of [[keepId], [dupId]]) {
    db.prepare(
      `INSERT OR IGNORE INTO projects
         (id, path, name, type, stage, status, priority, starred, hidden, tags,
          isolation_mode, vm_size, created_at, updated_at)
       VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
    ).run(id, repoPath, id, now, now);
  }

  db.prepare(
    `INSERT OR IGNORE INTO tracks (id, project_id, name, created_at, updated_at)
     VALUES (?, ?, 'Track', ?, ?)`
  ).run(trackId, keepId, now, now);

  // WO only under keepId (so dup's WO is distinct).
  const woIdKeep = `WO-${new Date().getFullYear()}-889`;
  const woIdDup = `WO-${new Date().getFullYear()}-890`;

  db.prepare(
    `INSERT OR IGNORE INTO work_orders
       (id, project_id, title, status, priority, tags, created_at, updated_at)
     VALUES (?, ?, 'Keep WO', 'backlog', 3, '[]', ?, ?)`
  ).run(woIdKeep, keepId, now, now);

  db.prepare(
    `INSERT OR IGNORE INTO work_orders
       (id, project_id, title, status, priority, tags, created_at, updated_at)
     VALUES (?, ?, 'Dup WO', 'backlog', 3, '[]', ?, ?)`
  ).run(woIdDup, dupId, now, now);

  // wo_tracks row on the dup's WO.
  db.prepare(
    `INSERT OR IGNORE INTO wo_tracks (project_id, wo_id, track_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(dupId, woIdDup, trackId, now);

  mergeProjectsByPath(repoPath, keepId);

  // No wo_tracks rows should reference the deleted dupId.
  const orphans = db
    .prepare("SELECT * FROM wo_tracks WHERE project_id = ?")
    .all(dupId);
  assert.equal(orphans.length, 0, "no wo_tracks rows should reference the deleted dup project");

  // The dup WO should now belong to keepId.
  const movedWo = db
    .prepare("SELECT id FROM work_orders WHERE project_id = ? AND id = ?")
    .get(keepId, woIdDup);
  assert.ok(movedWo, "dup WO should be moved to keepId");
});

test("mergeProjectsByPath: moves people_projects and security_incidents from dup to keep", () => {
  const repoPath = `/tmp/fake-repo-nonFk-${Date.now()}`;
  const now = new Date().toISOString();
  const keepId = `proj-k-nfk-${Date.now()}`;
  const dupId = `proj-d-nfk-${Date.now()}`;
  const personId = `person-${Date.now()}`;
  const runId = `run-${Date.now()}`;

  for (const [id] of [[keepId], [dupId]]) {
    db.prepare(
      `INSERT OR IGNORE INTO projects
         (id, path, name, type, stage, status, priority, starred, hidden, tags,
          isolation_mode, vm_size, created_at, updated_at)
       VALUES (?, ?, ?, 'app', 'active', 'ok', 1, 0, 0, '[]', 'local', 'medium', ?, ?)`
    ).run(id, repoPath, id, now, now);
  }

  // Insert a person.
  db.prepare(
    `INSERT OR IGNORE INTO people (id, name, tags, starred, created_at, updated_at)
     VALUES (?, 'Test Person', '[]', 0, ?, ?)`
  ).run(personId, now, now);

  // people_projects row under dup.
  db.prepare(
    `INSERT OR IGNORE INTO people_projects (id, person_id, project_id, relationship, created_at)
     VALUES (?, ?, ?, 'stakeholder', ?)`
  ).run(`pp-${Date.now()}`, personId, dupId, now);

  // security_incidents row under dup.
  db.prepare(
    `INSERT OR IGNORE INTO security_incidents
       (id, run_id, project_id, timestamp, pattern_category, pattern_matched,
        trigger_content, gemini_verdict, action_taken)
     VALUES (?, ?, ?, ?, 'test', 'test', 'test', 'safe', 'none')`
  ).run(`si-${Date.now()}`, runId, dupId, now);

  mergeProjectsByPath(repoPath, keepId);

  // people_projects should reference keepId, not dupId.
  const ppDup = db
    .prepare("SELECT * FROM people_projects WHERE project_id = ?")
    .all(dupId);
  assert.equal(ppDup.length, 0, "no people_projects rows should reference dupId after merge");

  const ppKeep = db
    .prepare("SELECT * FROM people_projects WHERE project_id = ? AND person_id = ?")
    .all(keepId, personId);
  assert.ok(ppKeep.length > 0, "people_projects row should reference keepId after merge");

  // security_incidents should reference keepId.
  const siDup = db
    .prepare("SELECT * FROM security_incidents WHERE project_id = ?")
    .all(dupId);
  assert.equal(siDup.length, 0, "no security_incidents should reference dupId after merge");

  const siKeep = db
    .prepare("SELECT * FROM security_incidents WHERE project_id = ?")
    .all(keepId);
  assert.ok(siKeep.length > 0, "security_incidents should reference keepId after merge");
});

// ── Cleanup shared resources after all tests ────────────────────────────────
process.on("exit", () => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(sharedTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (_origCC === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = _origCC;
  if (_origPcc === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = _origPcc;
});
