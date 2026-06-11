import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-health-"));
const dbPath = path.join(tmpDir, "health.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;

const { getDb } = await import("./db.ts");
const { getHealthResponse, isValidHealthToken } = await import("./health.ts");
const { getHeartbeatResponse } = await import("./observability.ts");

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

test("health response includes core metadata", () => {
  const response = getHealthResponse();
  assert.equal(response.ok, true);
  assert.equal(response.status, "ok");
  assert.equal(typeof response.version, "string");
  assert.equal(typeof response.uptime_seconds, "number");
  assert.ok(Number.isFinite(response.uptime_seconds));
  assert.ok(Date.parse(response.started_at) > 0);
  assert.ok(response.mode === "local" || response.mode === "cloud");
  assert.ok(Date.parse(response.ts) > 0);
});

test("heartbeat response returns activity fields", () => {
  const response = getHeartbeatResponse(5);
  assert.ok(Array.isArray(response.active_runs));
  assert.equal(
    response.last_activity_at === null || typeof response.last_activity_at === "string",
    true
  );
  assert.equal(
    response.last_activity === null || typeof response.last_activity === "string",
    true
  );
});

// --- isValidHealthToken: fail-closed security matrix ---

test("isValidHealthToken: no configured token → always denies (fail closed)", () => {
  // Even if a caller provides a token, no configured token means deny.
  // This ensures SHIFTBOSS_ALLOW_REMOTE_HEALTH=1 without SHIFTBOSS_HEALTH_TOKEN
  // does not silently expose operational data.
  assert.equal(isValidHealthToken("", "", ""), false);
  assert.equal(isValidHealthToken("", "sometoken", ""), false);
  assert.equal(isValidHealthToken("", "", "sometoken"), false);
  assert.equal(isValidHealthToken("", "secret", "secret"), false);
});

test("isValidHealthToken: correct query token → admits", () => {
  assert.equal(isValidHealthToken("mysecret", "mysecret", ""), true);
});

test("isValidHealthToken: correct header token → admits", () => {
  assert.equal(isValidHealthToken("mysecret", "", "mysecret"), true);
});

test("isValidHealthToken: wrong token → denies", () => {
  assert.equal(isValidHealthToken("mysecret", "wrong", ""), false);
  assert.equal(isValidHealthToken("mysecret", "", "wrong"), false);
  assert.equal(isValidHealthToken("mysecret", "wrong", "wrong"), false);
});

test("isValidHealthToken: empty caller tokens with configured token → denies", () => {
  assert.equal(isValidHealthToken("mysecret", "", ""), false);
});
