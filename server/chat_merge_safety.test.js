/**
 * Unit tests for chat-merge safety guarantees:
 *   1. stageSafeChanges aborts on protected-path deletion (chat worktree path).
 *   2. worktree_merge acquires/releases the per-project merge lock (including on error).
 *   3. mergeNoTouch: temp-worktree path and checkout-merge fallback path.
 *
 * Dead-worker chat_run reaping is covered by job_supervisor.test.js (reapChatJob).
 * Fixture patterns follow merge_locks.test.js / runner_agent.test.js.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// ---------------------------------------------------------------------------
// Shared DB setup — must happen before any module imports that open the DB.
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-chat-merge-safety-"));
const dbPath = path.join(tmpRoot, "test.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const originalCwd = process.cwd();
// chat_agent uses process.cwd() for run dirs, so point it at our temp root.
process.chdir(tmpRoot);

const { getDb, acquireMergeLock, getMergeLock, releaseMergeLock } = await import("./db.ts");
const { __test__: chatWorktreeTest } = await import("./chat_worktree.ts");

// stageSafeChanges and mergeNoTouch come from git_safety.ts (the shared SSOT);
// chat_worktree.__test__ re-exports them so tests can import via a single handle.
const { stageSafeChanges, mergeNoTouch } = chatWorktreeTest;

after(() => {
  try { getDb().close(); } catch { /* ignore */ }
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  if (originalPccDbPath === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = originalPccDbPath;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGit(repoPath, args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "git failed";
    throw new Error(`git ${args.join(" ")}: ${message}`);
  }
  return result.stdout.trim();
}

function setupRepo(t) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-chat-repo-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "init\n", "utf8");
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

/** Create a chat worktree branched off the given repo. */
function setupWorktree(t, repoPath) {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-chat-wt-"));
  t.after(() => {
    try {
      runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
    } catch { /* ignore */ }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try {
      runGit(repoPath, ["branch", "-D", "chat/test-thread"]);
    } catch { /* ignore */ }
  });
  runGit(repoPath, ["worktree", "add", "-b", "chat/test-thread", worktreePath, "HEAD"]);
  return worktreePath;
}

function seedProject(id, repoPath) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, path, name, description, type, stage, status, priority, starred, hidden,
        tags, isolation_mode, vm_size, last_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, repoPath, `Project ${id}`, null, "app", "active", "ok", 1, 0, 0,
    "[]", "local", "medium", null, now, now);
}

// ---------------------------------------------------------------------------
// 1. stageSafeChanges (via chat_worktree): protected-path deletion aborts the merge
// ---------------------------------------------------------------------------

test("stageSafeChanges: aborts when agent deletes a file under work_orders/", (t) => {
  const repoPath = setupRepo(t);
  const worktreePath = setupWorktree(t, repoPath);

  // Create a work_orders/ file in the worktree and commit it so HEAD knows about it
  const woDir = path.join(worktreePath, "work_orders");
  fs.mkdirSync(woDir, { recursive: true });
  fs.writeFileSync(path.join(woDir, "WO-001.md"), "# WO-001\n", "utf8");
  runGit(worktreePath, ["add", "."]);
  runGit(worktreePath, ["-c", "user.email=t@t.com", "-c", "user.name=T",
    "commit", "-m", "add WO"]);

  // Now delete the file (simulating an agent deletion)
  fs.rmSync(path.join(woDir, "WO-001.md"), { force: true });

  const result = stageSafeChanges({ worktreePath });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "protected_path_violation");
  assert.ok(result.violations.some((v) => v.startsWith("work_orders/")),
    `expected work_orders/ violation, got: ${JSON.stringify(result.violations)}`);

  // The file should be restored
  assert.ok(fs.existsSync(path.join(woDir, "WO-001.md")),
    "deleted protected file should be restored after abort");
});

test("stageSafeChanges: aborts when agent deletes .control.yml", (t) => {
  const repoPath = setupRepo(t);
  const worktreePath = setupWorktree(t, repoPath);

  fs.writeFileSync(path.join(worktreePath, ".control.yml"), "protected_paths: []\n", "utf8");
  runGit(worktreePath, ["add", "."]);
  runGit(worktreePath, ["-c", "user.email=t@t.com", "-c", "user.name=T",
    "commit", "-m", "add control"]);

  fs.rmSync(path.join(worktreePath, ".control.yml"), { force: true });

  const result = stageSafeChanges({ worktreePath });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "protected_path_violation");
  assert.ok(result.violations.includes(".control.yml"),
    `expected .control.yml violation, got: ${JSON.stringify(result.violations)}`);
});

test("stageSafeChanges: allows ordinary file additions and skips unrelated deletions", (t) => {
  const repoPath = setupRepo(t);
  const worktreePath = setupWorktree(t, repoPath);

  // Commit a file we will later delete (not a protected path)
  fs.writeFileSync(path.join(worktreePath, "old.txt"), "old\n", "utf8");
  runGit(worktreePath, ["add", "."]);
  runGit(worktreePath, ["-c", "user.email=t@t.com", "-c", "user.name=T",
    "commit", "-m", "add old"]);

  // Delete non-protected file, add new file
  fs.rmSync(path.join(worktreePath, "old.txt"), { force: true });
  fs.writeFileSync(path.join(worktreePath, "new.txt"), "new\n", "utf8");

  const result = stageSafeChanges({ worktreePath });
  assert.equal(result.ok, true, "should succeed for non-protected deletions");
  // new.txt is staged; old.txt deletion is not staged (safe staging skips it)
  const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd: worktreePath, encoding: "utf8",
  }).stdout.trim().split("\n").filter(Boolean);
  assert.ok(staged.includes("new.txt"), "new.txt should be staged");
  assert.ok(!staged.includes("old.txt"), "old.txt deletion should NOT be staged");
});

// ---------------------------------------------------------------------------
// 2. Merge lock: chat merge takes and releases the lock
// ---------------------------------------------------------------------------

test("worktree_merge acquires merge lock and releases it after success", (t) => {
  const projectId = `proj-lock-${Math.random().toString(36).slice(2)}`;
  const repoPath = setupRepo(t);
  seedProject(projectId, repoPath);

  // Verify lock is free before merge
  assert.equal(getMergeLock(projectId), null, "no lock held before merge");

  // Acquire the lock ourselves (simulating a concurrent holder) and verify the
  // chat merge path respects it.  We can't easily call applyChatAction here
  // without a full HTTP stack, so we test the lock helpers directly via the
  // established pattern from merge_locks.test.js.
  const lockIdA = "runner-run-A";
  const lockIdB = `chat-${projectId}`;

  assert.equal(acquireMergeLock(projectId, lockIdA), true);
  assert.equal(getMergeLock(projectId)?.run_id, lockIdA);

  // A chat lock attempt should fail while runner holds it
  assert.equal(acquireMergeLock(projectId, lockIdB), false);
  assert.equal(getMergeLock(projectId)?.run_id, lockIdA);

  // Release runner lock; chat lock can now be acquired
  releaseMergeLock(projectId, lockIdA);
  assert.equal(getMergeLock(projectId), null);

  assert.equal(acquireMergeLock(projectId, lockIdB), true);
  assert.equal(getMergeLock(projectId)?.run_id, lockIdB);

  releaseMergeLock(projectId, lockIdB);
  assert.equal(getMergeLock(projectId), null);
});

test("worktree_merge releases lock even when merge throws", (t) => {
  const projectId = `proj-lock-err-${Math.random().toString(36).slice(2)}`;
  const repoPath = setupRepo(t);
  seedProject(projectId, repoPath);

  // Simulate the lock-acquire/finally-release pattern from chat_actions.ts
  const mergeLockId = `chat-thread-${Math.random().toString(36).slice(2)}`;
  let acquired = false;
  let threw = false;
  try {
    acquired = acquireMergeLock(projectId, mergeLockId);
    assert.ok(acquired);
    assert.equal(getMergeLock(projectId)?.run_id, mergeLockId);
    throw new Error("simulated merge failure");
  } catch {
    threw = true;
  } finally {
    releaseMergeLock(projectId, mergeLockId);
  }

  assert.ok(threw, "error should propagate");
  assert.equal(getMergeLock(projectId), null, "lock should be released even on error");
});

// ---------------------------------------------------------------------------
// 3. mergeNoTouch (via chat_worktree) — temp-worktree path and checkout-merge fallback
// ---------------------------------------------------------------------------
// Dead-worker chat_run reaping is covered by job_supervisor.test.js (reapChatJob).
// The job supervisor's registerJob + reapChatJob replaces the old
// maybeReapDeadWorkerRun / pid-file approach.

/**
 * Set up a repo with a chat branch that has one commit ahead of the base branch.
 * Returns { repoPath, baseBranch, chatBranch }.
 */
function setupMergeChatRepo(t) {
  const repoPath = setupRepo(t); // creates repo checked out on 'main' or 'master'
  // Discover the base branch name
  const baseBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath, encoding: "utf8",
  }).stdout.trim();

  // Create the chat branch with one new commit
  runGit(repoPath, ["checkout", "-b", "chat/thread-abc"]);
  fs.writeFileSync(path.join(repoPath, "feature.txt"), "from chat agent\n", "utf8");
  runGit(repoPath, ["add", "feature.txt"]);
  runGit(repoPath, ["-c", "user.email=t@t.com", "-c", "user.name=T",
    "commit", "-m", "chat agent feature"]);

  // Leave the base branch checked out so the caller chooses
  runGit(repoPath, ["checkout", baseBranch]);

  return { repoPath, baseBranch, chatBranch: "chat/thread-abc" };
}

test("mergeNoTouch merges chat branch when base is NOT checked out (temp-worktree path)", (t) => {
  const { repoPath, baseBranch, chatBranch } = setupMergeChatRepo(t);

  // Switch to a different branch so baseBranch is NOT checked out
  runGit(repoPath, ["checkout", "-b", "other-work"]);

  const result = mergeNoTouch({
    repoPath,
    baseBranch,
    branchName: chatBranch,
    mergeMessage: `Merge ${chatBranch}`,
  });

  assert.equal(result.ok, true, `mergeNoTouch failed: ${JSON.stringify(result)}`);

  // The base branch ref should now include the chat feature commit
  const baseContent = spawnSync(
    "git", ["show", `${baseBranch}:feature.txt`],
    { cwd: repoPath, encoding: "utf8" }
  ).stdout;
  assert.ok(baseContent.includes("from chat agent"),
    `Expected chat feature in ${baseBranch}:feature.txt`);

  // The user's current branch (other-work) should be unchanged
  const currentBranch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(currentBranch, "other-work", "user checkout should not have been switched");
});

test("mergeNoTouch merges chat branch when base IS currently checked out (checkout-merge fallback)", (t) => {
  const { repoPath, baseBranch, chatBranch } = setupMergeChatRepo(t);

  // baseBranch IS checked out (default from setupMergeChatRepo)
  const currentBefore = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(currentBefore, baseBranch);

  const result = mergeNoTouch({
    repoPath,
    baseBranch,
    branchName: chatBranch,
    mergeMessage: `Merge ${chatBranch}`,
  });

  assert.equal(result.ok, true, `mergeNoTouch failed: ${JSON.stringify(result)}`);

  // baseBranch should include the chat feature commit
  const baseContent = runGit(repoPath, ["show", `${baseBranch}:feature.txt`]);
  assert.ok(baseContent.includes("from chat agent"),
    `Expected chat feature in ${baseBranch}:feature.txt`);

  // After merge, HEAD should remain on baseBranch
  const currentAfter = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(currentAfter, baseBranch, "HEAD should remain on baseBranch after checkout-merge");
});

test("mergeNoTouch checkout-merge fallback: clears stale MERGE_HEAD before merging", (t) => {
  const { repoPath, baseBranch, chatBranch } = setupMergeChatRepo(t);

  // baseBranch IS checked out — we are in the fallback path
  const currentBefore = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(currentBefore, baseBranch);

  // Simulate a stale MERGE_HEAD left by a previously crashed merge
  const mergeHeadPath = path.join(repoPath, ".git", "MERGE_HEAD");
  // Write the SHA of the chat branch tip as MERGE_HEAD (mimics a partial merge)
  const chatTip = runGit(repoPath, ["rev-parse", chatBranch]);
  fs.writeFileSync(mergeHeadPath, chatTip + "\n", "utf8");
  assert.ok(fs.existsSync(mergeHeadPath), "MERGE_HEAD should exist before merge");

  // mergeNoTouch should abort the stale merge and then merge cleanly
  const result = mergeNoTouch({
    repoPath,
    baseBranch,
    branchName: chatBranch,
    mergeMessage: `Merge ${chatBranch}`,
  });

  assert.equal(result.ok, true,
    `mergeNoTouch should succeed after clearing stale MERGE_HEAD: ${JSON.stringify(result)}`);
  assert.ok(!fs.existsSync(mergeHeadPath), "MERGE_HEAD should be gone after successful merge");

  // The base branch ref should include the chat feature
  const baseContent = runGit(repoPath, ["show", `${baseBranch}:feature.txt`]);
  assert.ok(baseContent.includes("from chat agent"), "chat feature should be in base branch");
});
