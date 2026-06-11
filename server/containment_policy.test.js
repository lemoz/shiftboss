/**
 * Unit tests for Q1 (builder-grade containment to all agent surfaces) and
 * Q6 (Docker sandbox plumbing removed, firewall fail-closed).
 *
 * Covers:
 *  1. chat_agent monitoring settings default to monitorEnabled=true
 *  2. StreamMonitor is constructed and attached when chat_agent monitor is enabled
 *  3. StreamMonitor is skipped when chat_agent monitor is disabled
 *  4. global_agent monitoring settings round-trip correctly
 *  5. Firewall fails closed in proxy-only mode without UID restriction (Q6)
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// 1+4. Agent monitoring settings — chat_agent and global_agent default wiring
// ---------------------------------------------------------------------------

test("chat_agent monitoring settings default to monitorEnabled=true, autoKillOnThreat=true", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mon-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { getMonitoringSettings } = await import("./settings.ts");
  const chatSettings = getMonitoringSettings("chat_agent");

  assert.equal(chatSettings.monitorEnabled, true);
  assert.equal(chatSettings.autoKillOnThreat, true);
});

test("global_agent monitoring settings default to monitorEnabled=true, autoKillOnThreat=true", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ga-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { getMonitoringSettings } = await import("./settings.ts");
  const settings = getMonitoringSettings("global_agent");

  assert.equal(settings.monitorEnabled, true);
  assert.equal(settings.autoKillOnThreat, true);
  assert.equal(settings.networkAccess, "full");
});

test("patchAgentMonitoringSettings persists chat_agent settings", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-patch-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { patchAgentMonitoringSettings, getMonitoringSettings } = await import("./settings.ts");

  patchAgentMonitoringSettings({ chat_agent: { monitorEnabled: false, autoKillOnThreat: false } });
  const updated = getMonitoringSettings("chat_agent");

  assert.equal(updated.monitorEnabled, false);
  assert.equal(updated.autoKillOnThreat, false);
});

// ---------------------------------------------------------------------------
// 2+3. StreamMonitor is constructed and attached based on chat_agent setting
// ---------------------------------------------------------------------------

test("StreamMonitor attaches to a child process when chat_agent monitorEnabled=true", async (t) => {
  const { StreamMonitor } = await import("./stream_monitor.ts");

  const monitor = new StreamMonitor({ autoKillOnThreat: false });
  // Create a minimal fake child process (EventEmitter with stdout/stderr).
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();

  const context = { goal: "test chat run", acceptanceCriteria: [] };
  monitor.attach(fakeChild, context);

  // After attach, emit a benign line — no incidents should fire.
  fakeChild.stdout.emit("data", Buffer.from("All good, updating README."));
  assert.deepEqual(monitor.getIncidents(), []);

  monitor.detach();
});

test("when chat_agent monitorEnabled setting is false, no StreamMonitor is created", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-nm-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.SHIFTBOSS_DB_PATH = path.join(tmpDir, "test.db");
  t.after(() => { delete process.env.SHIFTBOSS_DB_PATH; });

  const { patchAgentMonitoringSettings, getMonitoringSettings } = await import("./settings.ts");
  const { StreamMonitor } = await import("./stream_monitor.ts");

  patchAgentMonitoringSettings({ chat_agent: { monitorEnabled: false } });
  const settings = getMonitoringSettings("chat_agent");

  // Mimic the conditional in runChatRun:
  // const chatMonitor = chatMonitoring?.monitorEnabled ? new StreamMonitor(...) : undefined;
  const chatMonitor = settings.monitorEnabled
    ? new StreamMonitor({ autoKillOnThreat: settings.autoKillOnThreat })
    : undefined;

  assert.equal(chatMonitor, undefined, "expected no monitor when setting is disabled");
});

// ---------------------------------------------------------------------------
// 5. Firewall fails closed (Q6)
// ---------------------------------------------------------------------------

function withEnv(key, value) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return () => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
}

test("firewall fails closed (returns null) in proxy-only mode without UID restriction", async (t) => {
  const { __test__, startNetworkWhitelistFirewall } = await import("./network_firewall.ts");

  const restoreBackend = withEnv("PCC_NETWORK_FIREWALL_BACKEND", "stub");
  const restoreMode = withEnv("PCC_NETWORK_FIREWALL", "enabled");
  __test__.resetStubFirewallState();
  t.after(() => {
    restoreBackend();
    restoreMode();
    __test__.resetStubFirewallState();
  });

  const logs = [];
  const handle = await startNetworkWhitelistFirewall({
    whitelist: ["example.com"],
    runId: "run-fc-test",
    proxyOnly: true,
    // Intentionally omitting restrictUid to exercise the fail-closed path.
    log: (line) => logs.push(line),
  });

  assert.equal(handle, null, "proxy-only without UID restriction must return null (fail closed)");
  assert.ok(
    logs.some((m) => m.includes("UID restriction")),
    `expected a log message about UID restriction, got: ${logs.join("; ")}`
  );
});
