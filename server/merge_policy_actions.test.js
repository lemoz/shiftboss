import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-merge-policy-"));
const dbPath = path.join(tmpRoot, "control-center.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const { getDb } = await import("./db.ts");
const { approveRunMerge, rejectRun } = await import("./runner_agent.ts");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  if (originalPccDbPath === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = originalPccDbPath;
});

function runGit(repoPath, args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "git failed";
    throw new Error(message);
  }
  return result.stdout.trim();
}

function gitBranchExists(repoPath, branchName) {
  const result = spawnSync("git", ["show-ref", "--verify", `refs/heads/${branchName}`], {
    cwd: repoPath,
    encoding: "utf8",
  });
  return result.status === 0;
}

function createApprovedRunFixture(nameSuffix) {
  const projectId = `project-${nameSuffix}`;
  const runId = `run-${nameSuffix}`;
  const repoPath = path.join(tmpRoot, `repo-${nameSuffix}`);
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(repoPath, "app.txt"), "base\n", "utf8");
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".system/\n", "utf8");
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "base"]);

  const baseBranch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchName = `run/WO-123-${nameSuffix}`;
  runGit(repoPath, ["checkout", "-b", branchName]);
  fs.appendFileSync(path.join(repoPath, "app.txt"), `change-${nameSuffix}\n`, "utf8");
  runGit(repoPath, ["add", "app.txt"]);
  runGit(repoPath, ["commit", "-m", "change"]);
  runGit(repoPath, ["checkout", baseBranch]);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (
      id, path, name, type, stage, status, priority, merge_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    repoPath,
    `Project ${nameSuffix}`,
    "prototype",
    "active",
    "active",
    1,
    "human_approve",
    now,
    now
  );

  const runDir = path.join(repoPath, ".system", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, "run.log");
  fs.writeFileSync(logPath, "", "utf8");
  db.prepare(
    `INSERT INTO runs (
      id,
      project_id,
      work_order_id,
      provider,
      status,
      branch_name,
      source_branch,
      reviewer_verdict,
      summary,
      run_dir,
      log_path,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    projectId,
    "WO-123",
    "codex",
    "approved",
    branchName,
    baseBranch,
    "approved",
    `summary-${nameSuffix}`,
    runDir,
    logPath,
    now
  );

  return { projectId, runId, repoPath, baseBranch, branchName, runDir };
}

test("approveRunMerge merges human-approved runs into base branch", () => {
  const fixture = createApprovedRunFixture("approve");
  const result = approveRunMerge(fixture.runId);
  assert.equal(result.ok, true);

  const runRow = db
    .prepare("SELECT status, merge_status FROM runs WHERE id = ?")
    .get(fixture.runId);
  assert.equal(runRow.status, "you_review");
  assert.equal(runRow.merge_status, "merged");

  const baseContent = runGit(fixture.repoPath, ["show", `${fixture.baseBranch}:app.txt`]);
  assert.match(baseContent, /change-approve/);
});

// Regression test for: commit block must run before applyMergePolicyAfterApproval so that
// approveRunMerge finds a real commit on the branch, not an empty branch-at-base-tip.
// The fixture simulates what runRun now produces: a git worktree where the builder made
// uncommitted changes and the runner's commit block staged+committed them onto the branch
// before setting status=approved (i.e., before the policy gate fires).
test("approveRunMerge lands builder changes committed via worktree before policy gate", () => {
  const projectId = "project-wtcommit";
  const runId = "run-wtcommit";
  const repoPath = path.join(tmpRoot, "repo-wtcommit");
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(repoPath, "app.txt"), "base\n", "utf8");
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".system/\n", "utf8");
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "base"]);

  const baseBranch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchName = "run/WO-200-wtcommit";
  const runDir = path.join(repoPath, ".system", "runs", runId);
  const worktreePath = path.join(runDir, "worktree");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Simulate ensureWorktree: create run branch in a git worktree at runDir/worktree
  runGit(repoPath, ["worktree", "add", "-b", branchName, worktreePath, baseBranch]);

  // Simulate builder writing a file (uncommitted, as providers are instructed to do)
  fs.appendFileSync(path.join(worktreePath, "app.txt"), "builder-change\n", "utf8");

  // Simulate the commit block that now runs before the policy gate
  runGit(worktreePath, ["config", "user.email", "runner@local"]);
  runGit(worktreePath, ["config", "user.name", "Shiftboss Runner"]);
  runGit(worktreePath, ["add", "app.txt"]);
  runGit(worktreePath, ["commit", "-m", "WO-200: worktree commit"]);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (
      id, path, name, type, stage, status, priority, merge_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    repoPath,
    "Project WtCommit",
    "prototype",
    "active",
    "active",
    1,
    "human_approve",
    now,
    now
  );

  const logPath = path.join(runDir, "run.log");
  fs.writeFileSync(logPath, "", "utf8");
  db.prepare(
    `INSERT INTO runs (
      id,
      project_id,
      work_order_id,
      provider,
      status,
      branch_name,
      source_branch,
      reviewer_verdict,
      summary,
      run_dir,
      log_path,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    projectId,
    "WO-200",
    "codex",
    "approved",
    branchName,
    baseBranch,
    "approved",
    "summary-wtcommit",
    runDir,
    logPath,
    now
  );

  const result = approveRunMerge(runId);
  assert.equal(result.ok, true, `approveRunMerge failed: ${result.error ?? ""}`);

  const runRow = db
    .prepare("SELECT status, merge_status FROM runs WHERE id = ?")
    .get(runId);
  assert.equal(runRow.status, "you_review");
  assert.equal(runRow.merge_status, "merged");

  // The builder's change must be present in the base branch after merge
  const baseContent = runGit(repoPath, ["show", `${baseBranch}:app.txt`]);
  assert.match(baseContent, /builder-change/);
});

test("rejectRun abandons approved runs and cleans local worktree artifacts", () => {
  const fixture = createApprovedRunFixture("reject");
  const worktreePath = path.join(fixture.runDir, "worktree");
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "temp\n", "utf8");
  assert.equal(gitBranchExists(fixture.repoPath, fixture.branchName), true);

  const result = rejectRun(fixture.runId);
  assert.equal(result.ok, true);

  const runRow = db
    .prepare("SELECT status, merge_status FROM runs WHERE id = ?")
    .get(fixture.runId);
  assert.equal(runRow.status, "rejected");
  assert.equal(runRow.merge_status, null);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(gitBranchExists(fixture.repoPath, fixture.branchName), false);
});
