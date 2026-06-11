import assert from "node:assert/strict";
import { test } from "node:test";

// Helper: set an env var for the duration of a callback, then restore.
function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, orig] of Object.entries(saved)) {
      if (orig === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = orig;
      }
    }
  }
}

// config.ts is a module-level singleton, but readEnv / the individual getters
// read process.env on every call, so we can test them without re-importing.
const {
  readEnv,
  getAllowLan,
  getAllowRemoteHealth,
  getCorsAllowAllRequested,
  getFailRunsOnRestart,
  getUseTsWorker,
  getScanTtlMs,
  getDatabasePath,
} = await import("./config.ts");

// ---------------------------------------------------------------------------
// Boolean env getters — must accept "1", "true", "yes", "on" (case-insensitive)
// and treat absent / "false" / "0" / anything else as false.
// ---------------------------------------------------------------------------

test("getAllowLan: absent → false", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: undefined, CONTROL_CENTER_ALLOW_LAN: undefined, PCC_ALLOW_LAN: undefined }, () => {
    assert.equal(getAllowLan(), false);
  });
});

test("getAllowLan: '1' → true", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "1" }, () => assert.equal(getAllowLan(), true));
});

test("getAllowLan: 'true' → true", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "true" }, () => assert.equal(getAllowLan(), true));
});

test("getAllowLan: 'TRUE' → true (case-insensitive)", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "TRUE" }, () => assert.equal(getAllowLan(), true));
});

test("getAllowLan: 'yes' → true", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "yes" }, () => assert.equal(getAllowLan(), true));
});

test("getAllowLan: 'on' → true", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "on" }, () => assert.equal(getAllowLan(), true));
});

test("getAllowLan: 'false' → false", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "false" }, () => assert.equal(getAllowLan(), false));
});

test("getAllowLan: '0' → false", () => {
  withEnv({ SHIFTBOSS_ALLOW_LAN: "0" }, () => assert.equal(getAllowLan(), false));
});

test("getAllowRemoteHealth: 'true' → true", () => {
  withEnv({ SHIFTBOSS_ALLOW_REMOTE_HEALTH: "true" }, () =>
    assert.equal(getAllowRemoteHealth(), true)
  );
});

test("getAllowRemoteHealth: absent → false", () => {
  withEnv(
    {
      SHIFTBOSS_ALLOW_REMOTE_HEALTH: undefined,
      CONTROL_CENTER_ALLOW_REMOTE_HEALTH: undefined,
      PCC_ALLOW_REMOTE_HEALTH: undefined,
    },
    () => assert.equal(getAllowRemoteHealth(), false)
  );
});

test("getCorsAllowAllRequested: 'true' → true", () => {
  withEnv({ SHIFTBOSS_CORS_ALLOW_ALL: "true" }, () =>
    assert.equal(getCorsAllowAllRequested(), true)
  );
});

test("getCorsAllowAllRequested: '1' → true", () => {
  withEnv({ SHIFTBOSS_CORS_ALLOW_ALL: "1" }, () =>
    assert.equal(getCorsAllowAllRequested(), true)
  );
});

test("getCorsAllowAllRequested: absent → false", () => {
  withEnv(
    {
      SHIFTBOSS_CORS_ALLOW_ALL: undefined,
      CONTROL_CENTER_CORS_ALLOW_ALL: undefined,
      PCC_CORS_ALLOW_ALL: undefined,
    },
    () => assert.equal(getCorsAllowAllRequested(), false)
  );
});

test("getFailRunsOnRestart: 'true' → true", () => {
  withEnv({ SHIFTBOSS_FAIL_IN_PROGRESS_ON_RESTART: "true" }, () =>
    assert.equal(getFailRunsOnRestart(), true)
  );
});

test("getFailRunsOnRestart: '1' → true", () => {
  withEnv({ SHIFTBOSS_FAIL_IN_PROGRESS_ON_RESTART: "1" }, () =>
    assert.equal(getFailRunsOnRestart(), true)
  );
});

test("getFailRunsOnRestart: absent → false (real default is false)", () => {
  withEnv(
    {
      SHIFTBOSS_FAIL_IN_PROGRESS_ON_RESTART: undefined,
      CONTROL_CENTER_FAIL_IN_PROGRESS_ON_RESTART: undefined,
      PCC_FAIL_IN_PROGRESS_ON_RESTART: undefined,
    },
    () => assert.equal(getFailRunsOnRestart(), false)
  );
});

test("getFailRunsOnRestart: 'false' → false", () => {
  withEnv({ SHIFTBOSS_FAIL_IN_PROGRESS_ON_RESTART: "false" }, () =>
    assert.equal(getFailRunsOnRestart(), false)
  );
});

test("getUseTsWorker: 'true' → true", () => {
  withEnv({ SHIFTBOSS_USE_TS_WORKER: "true" }, () =>
    assert.equal(getUseTsWorker(), true)
  );
});

test("getUseTsWorker: '1' → true", () => {
  withEnv({ SHIFTBOSS_USE_TS_WORKER: "1" }, () =>
    assert.equal(getUseTsWorker(), true)
  );
});

test("getUseTsWorker: 'false' → false", () => {
  withEnv({ SHIFTBOSS_USE_TS_WORKER: "false" }, () =>
    assert.equal(getUseTsWorker(), false)
  );
});

test("getUseTsWorker: absent → false", () => {
  withEnv(
    {
      SHIFTBOSS_USE_TS_WORKER: undefined,
      CONTROL_CENTER_USE_TS_WORKER: undefined,
      PCC_USE_TS_WORKER: undefined,
    },
    () => assert.equal(getUseTsWorker(), false)
  );
});

// ---------------------------------------------------------------------------
// getScanTtlMs — NaN / negative guard must fall back to 60_000
// ---------------------------------------------------------------------------

test("getScanTtlMs: absent → 60000", () => {
  withEnv(
    {
      SHIFTBOSS_SCAN_TTL_MS: undefined,
      CONTROL_CENTER_SCAN_TTL_MS: undefined,
      PCC_SCAN_TTL_MS: undefined,
    },
    () => assert.equal(getScanTtlMs(), 60_000)
  );
});

test("getScanTtlMs: valid positive number → parsed value", () => {
  withEnv({ SHIFTBOSS_SCAN_TTL_MS: "30000" }, () =>
    assert.equal(getScanTtlMs(), 30_000)
  );
});

test("getScanTtlMs: 0 → 0 (intentional cache-off)", () => {
  withEnv({ SHIFTBOSS_SCAN_TTL_MS: "0" }, () =>
    assert.equal(getScanTtlMs(), 0)
  );
});

test("getScanTtlMs: non-numeric string → 60000 (NaN guard)", () => {
  withEnv({ SHIFTBOSS_SCAN_TTL_MS: "abc" }, () =>
    assert.equal(getScanTtlMs(), 60_000)
  );
});

test("getScanTtlMs: negative value → 60000 (negative guard)", () => {
  withEnv({ SHIFTBOSS_SCAN_TTL_MS: "-1" }, () =>
    assert.equal(getScanTtlMs(), 60_000)
  );
});

test("getScanTtlMs: Infinity string → 60000", () => {
  withEnv({ SHIFTBOSS_SCAN_TTL_MS: "Infinity" }, () =>
    assert.equal(getScanTtlMs(), 60_000)
  );
});

// ---------------------------------------------------------------------------
// DB path precedence: SHIFTBOSS_DB_PATH > PCC_DATABASE_PATH >
// CONTROL_CENTER_DB_PATH (pre-rename legacy order must be preserved)
// ---------------------------------------------------------------------------

test("resolveDatabasePath: SHIFTBOSS_DB_PATH wins over PCC_DATABASE_PATH", () => {
  withEnv(
    {
      SHIFTBOSS_DB_PATH: "/canonical/shiftboss.db",
      PCC_DATABASE_PATH: "/legacy/pcc.db",
      CONTROL_CENTER_DB_PATH: "/legacy/cc.db",
    },
    () => assert.equal(getDatabasePath(), "/canonical/shiftboss.db")
  );
});

test("resolveDatabasePath: PCC_DATABASE_PATH wins over CONTROL_CENTER_DB_PATH", () => {
  withEnv(
    {
      SHIFTBOSS_DB_PATH: undefined,
      PCC_DATABASE_PATH: "/legacy/pcc.db",
      CONTROL_CENTER_DB_PATH: "/legacy/cc.db",
    },
    () => assert.equal(getDatabasePath(), "/legacy/pcc.db")
  );
});

test("resolveDatabasePath: CONTROL_CENTER_DB_PATH used when others absent", () => {
  withEnv(
    {
      SHIFTBOSS_DB_PATH: undefined,
      PCC_DATABASE_PATH: undefined,
      CONTROL_CENTER_DB_PATH: "/legacy/cc.db",
    },
    () => assert.equal(getDatabasePath(), "/legacy/cc.db")
  );
});
