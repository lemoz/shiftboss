import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-estimation-"));
const dbPath = path.join(tmpRoot, "control-center.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const { createRun, getDb } = await import("./db.ts");
const { buildEstimationContext } = await import("./estimation.ts");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  if (originalPccDbPath === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = originalPccDbPath;
});

function insertProject(projectId, repoPath, now) {
  db.prepare(
    `INSERT INTO projects (
      id, path, name, type, stage, status, priority, merge_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, repoPath, "Estimation Project", "prototype", "active", "active", 1, "auto_merge", now, now);
}

test("buildEstimationContext maps rejected runs to failed even when reviewer approved", () => {
  const now = new Date().toISOString();
  const projectId = "project-estimation";
  const runId = "run-rejected";
  const repoPath = path.join(tmpRoot, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath, now);

  const runDir = path.join(tmpRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, "run.log");
  fs.writeFileSync(logPath, "", "utf8");

  createRun({
    id: runId,
    project_id: projectId,
    work_order_id: "WO-REJECTED",
    provider: "codex",
    triggered_by: "manual",
    status: "rejected",
    iteration: 1,
    builder_iteration: 1,
    reviewer_verdict: "approved",
    reviewer_notes: null,
    summary: "rejected manually",
    estimated_iterations: null,
    estimated_minutes: null,
    estimate_confidence: null,
    estimate_reasoning: null,
    current_eta_minutes: null,
    estimated_completion_at: null,
    eta_history: null,
    branch_name: "run/WO-REJECTED",
    source_branch: "main",
    pr_url: null,
    merge_status: null,
    conflict_with_run_id: null,
    run_dir: runDir,
    log_path: logPath,
    created_at: now,
    started_at: now,
    finished_at: now,
    error: "rejected by user",
    failure_category: null,
    failure_reason: null,
    failure_detail: null,
    escalation: null,
    last_completed_phase: null,
  });

  const context = buildEstimationContext({
    projectId,
    workOrderTags: [],
    limit: 5,
  });

  assert.equal(context.sample_size, 1);
  assert.equal(context.recent_runs.length, 1);
  assert.equal(context.recent_runs[0]?.outcome, "failed");
});
