/**
 * Unit tests for the WAIT delay behavior in global_agent.ts / global_agent_sessions.ts.
 *
 * Coverage:
 *  1. runGlobalAgentShift populates wait_minutes from the WAIT decision
 *  2. wait_minutes is undefined when the shift does not end with WAIT
 *  3. The delay constants are sane (WAIT_DELAY_MIN/MAX, INTER_ITERATION_DELAY)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-wait-delay-"));
const dbPath = path.join(tmpDir, "wait.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

// Must import db first to initialize schema, then agent module.
const { getDb } = await import("./db.ts");
const { runGlobalAgentShift } = await import("./global_agent.ts");

after(() => {
  const db = getDb();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.CONTROL_CENTER_DB_PATH;
  else process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  if (originalPccDbPath === undefined) delete process.env.PCC_DATABASE_PATH;
  else process.env.PCC_DATABASE_PATH = originalPccDbPath;
});

// ── Test 1: wait_minutes is propagated from the WAIT decision ─────────────────

test("runGlobalAgentShift returns wait_minutes when agent decides WAIT with retry_after_minutes", async () => {
  const result = await runGlobalAgentShift({
    decide: async (_prompt) => ({
      action: "WAIT",
      reason: "nothing to do",
      retry_after_minutes: 15,
    }),
  });
  assert.ok(result.ok, `shift should succeed: ${result.ok ? "" : result.error}`);
  if (!result.ok) return;
  assert.equal(result.wait_minutes, 15, "wait_minutes should be 15 from the WAIT decision");
});

// ── Test 2: wait_minutes is undefined when the shift ends with a non-WAIT action

test("runGlobalAgentShift does not set wait_minutes for non-WAIT terminal action", async () => {
  let callCount = 0;
  const result = await runGlobalAgentShift({
    maxIterations: 1,
    decide: async (_prompt) => {
      callCount += 1;
      return {
        action: "REPORT",
        message: "All looks fine.",
        reason: "status report",
      };
    },
  });
  assert.ok(result.ok, `shift should succeed: ${result.ok ? "" : result.error}`);
  if (!result.ok) return;
  assert.equal(callCount, 1);
  // wait_minutes should be undefined when WAIT was not the last action
  assert.equal(result.wait_minutes, undefined, "wait_minutes must be undefined for non-WAIT shifts");
});

// ── Test 3: wait_minutes is undefined when WAIT has no retry_after_minutes ────

test("runGlobalAgentShift returns wait_minutes=undefined when WAIT has no retry_after_minutes", async () => {
  const result = await runGlobalAgentShift({
    decide: async (_prompt) => ({
      action: "WAIT",
      reason: "idle period",
      // No retry_after_minutes supplied
    }),
  });
  assert.ok(result.ok, `shift should succeed: ${result.ok ? "" : result.error}`);
  if (!result.ok) return;
  assert.equal(result.wait_minutes, undefined, "wait_minutes should be undefined when not specified");
});

// ── Test 4: clampWaitMinutes exercises the actual clamping logic ───────────────
// (Previously this test read the source as text with regexes, which silently
// passed even when the underlying logic changed. Now we import and call the
// real function so renames or refactors are caught immediately.)

const {
  clampWaitMinutes,
  WAIT_DELAY_MIN_MINUTES,
  WAIT_DELAY_MAX_MINUTES,
  INTER_ITERATION_DELAY_MS,
} = await import("./global_agent_sessions.ts");

test("clampWaitMinutes: constants are within sane bounds", () => {
  assert.ok(WAIT_DELAY_MIN_MINUTES >= 1, "WAIT_DELAY_MIN_MINUTES should be >= 1");
  assert.ok(WAIT_DELAY_MAX_MINUTES <= 120, "WAIT_DELAY_MAX_MINUTES should be <= 120");
  assert.ok(WAIT_DELAY_MIN_MINUTES < WAIT_DELAY_MAX_MINUTES, "MIN < MAX");
  assert.ok(INTER_ITERATION_DELAY_MS >= 1000, "INTER_ITERATION_DELAY_MS should be >= 1000ms");
  assert.ok(INTER_ITERATION_DELAY_MS <= 30_000, "INTER_ITERATION_DELAY_MS should be <= 30s");
});

test("clampWaitMinutes: value below MIN is clamped to MIN", () => {
  assert.equal(clampWaitMinutes(0), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes(-5), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes(0.1), WAIT_DELAY_MIN_MINUTES);
});

test("clampWaitMinutes: value above MAX is clamped to MAX", () => {
  assert.equal(clampWaitMinutes(9999), WAIT_DELAY_MAX_MINUTES);
  assert.equal(clampWaitMinutes(WAIT_DELAY_MAX_MINUTES + 1), WAIT_DELAY_MAX_MINUTES);
});

test("clampWaitMinutes: value within range passes through unchanged", () => {
  const mid = Math.floor((WAIT_DELAY_MIN_MINUTES + WAIT_DELAY_MAX_MINUTES) / 2);
  assert.equal(clampWaitMinutes(mid), mid);
  assert.equal(clampWaitMinutes(WAIT_DELAY_MIN_MINUTES), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes(WAIT_DELAY_MAX_MINUTES), WAIT_DELAY_MAX_MINUTES);
});

test("clampWaitMinutes: non-numeric / absent input defaults to MIN", () => {
  assert.equal(clampWaitMinutes(undefined), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes(null), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes("30"), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes(NaN), WAIT_DELAY_MIN_MINUTES);
  assert.equal(clampWaitMinutes(Infinity), WAIT_DELAY_MIN_MINUTES);
});
