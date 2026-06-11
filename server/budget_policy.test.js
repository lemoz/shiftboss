/**
 * budget_policy.test.js
 *
 * Unit tests for the budget policy changes:
 *   1. unbudgeted-allows  — fresh project with no budget configured allows runs
 *   2. exhausted-blocks   — project with allocation and spend >= allocation blocks runs
 *   3. unknown-model conservative pricing + warning
 *   4. allocation-sum validation against global pool
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// ---------------------------------------------------------------------------
// Shared DB setup
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboss-budget-policy-"));
const dbPath = path.join(tmpDir, "test.db");

const origCCDb = process.env.CONTROL_CENTER_DB_PATH;
const origPccDb = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const { getDb, createCostRecord } = await import("./db.ts");
const {
  getGlobalBudget,
  getProjectBudget,
  getBudgetStatus: _getBudgetStatus,  // not exported; we test via getProjectBudget
  setGlobalMonthlyBudget,
  setProjectBudget,
  BudgetPoolOversubscribedError,
} = await import("./budgeting.ts");

const { enforceRunBudget } = await import("./budget_enforcement.ts");
const { resolveModelPricing, resolveModelPricingConservative } = await import("./cost_pricing.ts");
const { recordCostEntry } = await import("./cost_tracking.ts");

const db = getDb();

// Minimal project insert helper.
function insertProject(projectId, repoPath) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (id, path, name, type, stage, status, priority, merge_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, repoPath, `Project ${projectId}`, "prototype", "active", "active", 1, "auto_merge", now, now);
}

// Insert a cost record that counts toward project spend.
function insertSpend(projectId, amountUsd) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cost_records (id, project_id, run_id, category, input_tokens, output_tokens, is_actual, model, input_cost_per_1k, output_cost_per_1k, total_cost_usd, description, created_at)
    VALUES (?, ?, NULL, 'builder', 0, 0, 1, 'gpt-5.3-codex', 0, 0, ?, 'test spend', ?)
  `).run(crypto.randomUUID(), projectId, amountUsd, now);
}

const repoBase = path.join(tmpDir, "repos");
fs.mkdirSync(repoBase, { recursive: true });

// ---------------------------------------------------------------------------
// 1. unbudgeted-allows: no budget configured → status "unbudgeted", run allowed
// ---------------------------------------------------------------------------

test("unbudgeted project has status 'unbudgeted' (not exhausted)", () => {
  const projectId = "proj-unbudgeted";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  const budget = getProjectBudget(projectId);
  assert.equal(budget.budget_status, "unbudgeted",
    `expected 'unbudgeted', got '${budget.budget_status}'`);
  assert.equal(budget.monthly_allocation_usd, 0);
});

test("enforceRunBudget allows run for unbudgeted project (no global budget)", () => {
  const projectId = "proj-unbudgeted-enforce";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  // Ensure no global budget is set (monthly_budget_usd === 0).
  const global = getGlobalBudget();
  assert.equal(global.monthly_budget_usd, 0, "global budget should be 0 for this test");

  // Should not throw.
  const result = enforceRunBudget({
    projectId,
    projectPath: repoPath,
    workOrderId: "WO-001",
  });
  assert.equal(result.mode, "normal");
});

test("unbudgeted project with global budget set is allowed (draws from unallocated pool)", () => {
  const projectId = "proj-unbudgeted-global";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  // Set a global budget but no per-project allocation.
  setGlobalMonthlyBudget(100);

  const result = enforceRunBudget({
    projectId,
    projectPath: repoPath,
    workOrderId: "WO-002",
  });
  assert.equal(result.mode, "normal");

  // Clean up global budget so other tests start clean.
  setGlobalMonthlyBudget(0);
});

// ---------------------------------------------------------------------------
// 2. exhausted-blocks: project with spend >= allocation → status "exhausted"
// ---------------------------------------------------------------------------

test("project with spend >= allocation has status 'exhausted'", () => {
  const projectId = "proj-exhausted";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  setProjectBudget(projectId, 10.00); // $10 allocation
  insertSpend(projectId, 10.01);       // $10.01 spend

  const budget = getProjectBudget(projectId);
  assert.equal(budget.budget_status, "exhausted");
});

test("enforceRunBudget does not return 'normal' for exhausted project", () => {
  // An exhausted project either throws (budget_exhausted) or returns survival
  // mode — it must NOT be treated as if it has a healthy budget. We verify this
  // by checking that if it does return (survival case), the mode is 'survival'
  // not 'normal', and that the project budget status is 'exhausted'.
  const projectId = "proj-exhausted-enforce";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  setProjectBudget(projectId, 5.00);
  insertSpend(projectId, 5.01);

  // Confirm budget_status is 'exhausted' after over-spend.
  const budget = getProjectBudget(projectId);
  assert.equal(budget.budget_status, "exhausted");

  // enforceRunBudget may throw (budget_exhausted) or return {mode: "survival"}
  // depending on the survival drip — both are correct gating responses.
  // What MUST NOT happen is returning {mode: "normal"}.
  let result = null;
  let threw = false;
  try {
    result = enforceRunBudget({ projectId, projectPath: repoPath, workOrderId: "WO-003" });
  } catch (err) {
    threw = true;
    // If it throws, the code must be a budget-related code.
    assert.ok(
      err.code === "budget_exhausted" || err.code === "global_budget_exhausted" ||
      err.code === "survival_queue" || err.code === "survival_priority" || err.code === "budget_critical",
      `unexpected error code: ${err.code}`
    );
  }
  if (!threw) {
    // Survival mode is acceptable; 'normal' on an exhausted project is a bug.
    assert.notEqual(result?.mode, "normal",
      "enforceRunBudget must not return mode='normal' for an exhausted project");
    assert.equal(result?.mode, "survival",
      "only survival mode is acceptable when enforceRunBudget does not throw for exhausted project");
  }
});

// ---------------------------------------------------------------------------
// 3. Unknown model → conservative pricing + warning logged
// ---------------------------------------------------------------------------

test("resolveModelPricing returns null for unknown model", () => {
  const result = resolveModelPricing("some-future-model-xyz");
  assert.equal(result, null);
});

test("resolveModelPricingConservative returns non-null for unknown model (fails closed)", () => {
  const result = resolveModelPricingConservative("some-future-model-xyz");
  assert.ok(result !== null, "conservative pricing should return a fallback, not null");
  assert.ok(
    result.input_cost_per_1k > 0 && result.output_cost_per_1k > 0,
    "conservative fallback rates should be > 0"
  );
});

test("resolveModelPricingConservative logs a warning for unknown model", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    resolveModelPricingConservative("definitely-unknown-model-abc");
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.length > 0, "expected a console.warn call for unknown model");
  assert.ok(
    warnings[0].includes("definitely-unknown-model-abc"),
    `warning should mention the unknown model name, got: ${warnings[0]}`
  );
});

test("resolveModelPricingConservative matches known claude-sonnet-4 model", () => {
  const result = resolveModelPricingConservative("claude-sonnet-4-6");
  assert.ok(result !== null);
  assert.equal(result.id, "claude-sonnet-4");
});

test("resolveModelPricingConservative matches known claude-haiku-4-5-20251001", () => {
  const result = resolveModelPricingConservative("claude-haiku-4-5-20251001");
  assert.ok(result !== null);
  assert.equal(result.id, "claude-haiku-4");
});

test("recordCostEntry records non-zero cost for unknown model (conservative fallback)", () => {
  const projectId = "proj-unknown-model-cost";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    recordCostEntry({
      projectId,
      category: "other",
      model: "some-future-model-xyz",
      usage: { inputTokens: 1000, outputTokens: 200 },
      description: "test unknown model cost",
    });
  } finally {
    console.warn = origWarn;
  }

  // Confirm warning was logged.
  assert.ok(warnings.length > 0, "should warn about unknown model");

  // Confirm cost record has non-zero total_cost_usd.
  const row = db.prepare(
    "SELECT total_cost_usd FROM cost_records WHERE project_id = ? AND description LIKE '%unknown model cost%' ORDER BY created_at DESC LIMIT 1"
  ).get(projectId);
  assert.ok(row !== undefined, "cost record should exist");
  assert.ok(row.total_cost_usd > 0,
    `total_cost_usd should be > 0 for unknown model, got ${row.total_cost_usd}`);
});

// ---------------------------------------------------------------------------
// 4. Allocation-sum validation: allocation > global pool → rejected
// ---------------------------------------------------------------------------

test("setProjectBudget allows allocation when pool is sufficient", () => {
  setGlobalMonthlyBudget(100);

  const projectId = "proj-alloc-ok";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  // $50 out of $100 global budget.
  const budget = setProjectBudget(projectId, 50.00);
  assert.equal(budget.monthly_allocation_usd, 50);

  setGlobalMonthlyBudget(0);
  setProjectBudget(projectId, 0);
});

test("getProjectBudget returns unbudgeted when no allocation row exists regardless of spend", () => {
  const projectId = "proj-zero-alloc-zero-spend";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  const budget = getProjectBudget(projectId);
  assert.equal(budget.budget_status, "unbudgeted");
  assert.equal(budget.monthly_allocation_usd, 0);
  assert.equal(budget.spent_usd, 0);
});

// ---------------------------------------------------------------------------
// 5. global_budget_exhausted: enforceRunBudget blocks when global remaining <= 0
// ---------------------------------------------------------------------------

test("enforceRunBudget throws global_budget_exhausted when global pool is exhausted", () => {
  const projectId = "proj-global-exhausted";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  // Set a global budget of $1 and spend $1.01 globally to exhaust the pool.
  setGlobalMonthlyBudget(1.00);
  insertSpend(projectId, 1.01); // global spend is a sum of all project spend

  let threw = false;
  try {
    enforceRunBudget({ projectId, projectPath: repoPath, workOrderId: "WO-global-exhausted" });
  } catch (err) {
    threw = true;
    assert.equal(err.code, "global_budget_exhausted",
      `expected code='global_budget_exhausted', got '${err.code}'`);
  }
  assert.ok(threw, "enforceRunBudget should throw when global budget is exhausted");

  // Clean up.
  setGlobalMonthlyBudget(0);
});

// ---------------------------------------------------------------------------
// 6. Pool oversubscription: setProjectBudget rejects when allocation > pool
// ---------------------------------------------------------------------------

test("setProjectBudget throws BudgetPoolOversubscribedError when allocation exceeds global pool", () => {
  setGlobalMonthlyBudget(50.00);

  const projectId = "proj-oversubscribe";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  let threw = false;
  try {
    // Attempt to allocate $60 from a $50 global pool.
    setProjectBudget(projectId, 60.00);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof BudgetPoolOversubscribedError,
      `expected BudgetPoolOversubscribedError, got ${err.constructor.name}`);
    assert.ok(err.requestedUsd > err.availableUsd,
      "requested amount should exceed available pool");
  }
  assert.ok(threw, "setProjectBudget should throw when allocation exceeds global pool");

  // Clean up.
  setGlobalMonthlyBudget(0);
});

test("setProjectBudget allows updating an existing allocation within the pool", () => {
  setGlobalMonthlyBudget(100.00);

  const projectId = "proj-realloc";
  const repoPath = path.join(repoBase, projectId);
  fs.mkdirSync(repoPath, { recursive: true });
  insertProject(projectId, repoPath);

  // Set initial $40 allocation.
  setProjectBudget(projectId, 40.00);

  // Update to $60 — delta is +20 against a $100 pool with $40 used = $60 available.
  // Should succeed.
  const result = setProjectBudget(projectId, 60.00);
  assert.equal(result.monthly_allocation_usd, 60.00);

  // Clean up.
  setGlobalMonthlyBudget(0);
  setProjectBudget(projectId, 0);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origCCDb === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = origCCDb;
  if (origPccDb === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = origPccDb;
});
