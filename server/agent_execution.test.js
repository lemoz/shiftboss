/**
 * Unit tests for server/agent_execution.ts
 *
 * Covers:
 *  1. kill-tree: spawn a shell that spawns a sleeper; assert both die
 *  2. timeout fires and sets timedOut/killed flags
 *  3. monitor-verdict-race: flush() awaits in-flight verdicts before resolving
 *  4. onCost hook is invoked with stdout/stderr
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { test } from "node:test";

const { executeAgentCli, killProcessTree } = await import("./agent_execution.ts");

// ---------------------------------------------------------------------------
// Helper: is a pid still alive?
// ---------------------------------------------------------------------------
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. kill-tree test
// ---------------------------------------------------------------------------
test("killProcessTree terminates shell and its sleeper child", async () => {
  if (process.platform === "win32") return; // group kill not available on Windows

  // Spawn a shell that itself spawns a long sleep.
  const { spawn } = await import("node:child_process");
  const shell = spawn(
    "sh",
    ["-c", "sleep 300 & echo $! ; wait"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );

  // Read the sleeper pid from the shell's stdout
  const sleeperPid = await new Promise((resolve, reject) => {
    let buf = "";
    shell.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const line = buf.trim();
      if (line) resolve(Number(line));
    });
    shell.on("error", reject);
    setTimeout(() => reject(new Error("timeout waiting for sleeper pid")), 3000);
  });

  assert.ok(Number.isFinite(sleeperPid) && sleeperPid > 0, "got sleeper pid");
  assert.ok(isAlive(shell.pid), "shell alive before kill");
  assert.ok(isAlive(sleeperPid), "sleeper alive before kill");

  await killProcessTree(shell.pid);

  // Allow a brief settle
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!isAlive(shell.pid), "shell dead after killProcessTree");
  assert.ok(!isAlive(sleeperPid), "sleeper dead after killProcessTree");
});

// ---------------------------------------------------------------------------
// 2. timeout fires and reports
// ---------------------------------------------------------------------------
test("executeAgentCli sets timedOut=true and killed=true when timeout expires", async () => {
  if (process.platform === "win32") return;

  const result = await executeAgentCli({
    command: "sh",
    args: ["-c", "sleep 60"],
    timeoutMs: 300,
    killGraceMs: 200,
    label: "sleepy-test",
  });

  assert.equal(result.timedOut, true, "timedOut should be true");
  assert.equal(result.killed, true, "killed should be true");
  // exit code will be non-zero (killed)
  assert.ok(result.exitCode !== 0, "exit code should be non-zero after kill");
});

// ---------------------------------------------------------------------------
// 3. monitor-verdict-race: flush() waits for an in-flight verdict
//
// This tests the actual race from the brief: enqueueIncident() fires while
// flush() is already polling.  We simulate an in-flight verdict by directly
// forcing StreamMonitor.processing = true (private field, reachable via []
// in JS) before calling flush(), then clearing it after a delay.  flush()
// must NOT resolve until processing becomes false.
// ---------------------------------------------------------------------------
test("StreamMonitor.flush() waits for a delayed in-flight verdict", async () => {
  const { StreamMonitor } = await import("./stream_monitor.ts");

  const monitor = new StreamMonitor({ autoKillOnThreat: false });

  // Simulate an in-flight Gemini call by forcing the private processing flag
  // to true before flush() is called.
  monitor["processing"] = true;

  let flushResolved = false;
  const flushPromise = monitor.flush().then(() => {
    flushResolved = true;
  });

  // flush() should NOT have resolved yet — processing is still true.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(flushResolved, false, "flush must not resolve while processing=true");

  // Release the in-flight verdict: set processing = false (what processQueue
  // does when the queue drains).
  monitor["processing"] = false;

  // Now flush() should poll and see processing=false, then resolve.
  await Promise.race([
    flushPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("flush() did not resolve after processing cleared")), 500)
    ),
  ]);
  assert.equal(flushResolved, true, "flush resolves after processing becomes false");
});

// ---------------------------------------------------------------------------
// 4. normal exit with timeoutMs configured does NOT hang (deadlock regression)
//
// Before the DEADLOCK FIX, clearTimeout() cancelled the timer but the
// Promise wrapping it never resolved, so `await killPromise` hung forever.
// This test verifies the common case: process exits before the timeout fires.
// ---------------------------------------------------------------------------
test("executeAgentCli completes without hanging when process exits before timeout", async () => {
  // Use a generous timeout (10 s) with a command that exits immediately.
  // If the deadlock regresses this test will hang (the test runner will
  // eventually kill it; the assertion below won't fire).
  const done = await Promise.race([
    executeAgentCli({
      command: "sh",
      args: ["-c", "echo done"],
      timeoutMs: 10_000,
      label: "no-deadlock-test",
    }).then((r) => ({ result: r, timedOut: false })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ result: null, timedOut: true }), 3_000)
    ),
  ]);

  assert.equal(done.timedOut, false, "executeAgentCli must not hang when process exits before timeout");
  assert.equal(done.result.exitCode, 0, "exit code should be 0");
  assert.equal(done.result.timedOut, false, "timedOut flag should be false");
  assert.equal(done.result.killed, false, "killed flag should be false");
});

// ---------------------------------------------------------------------------
// 5. onCost hook is invoked
// ---------------------------------------------------------------------------
test("executeAgentCli calls onCost with captured stdout", async () => {
  let costInfo = null;

  const result = await executeAgentCli({
    command: "sh",
    args: ["-c", 'echo "hello from agent"'],
    onCost: (info) => { costInfo = info; },
    label: "cost-test",
  });

  assert.equal(result.exitCode, 0, "process should exit 0");
  assert.ok(costInfo !== null, "onCost should be called");
  assert.ok(costInfo.stdout.includes("hello from agent"), "stdout captured");
});

// ---------------------------------------------------------------------------
// 6. onLine callback receives lines
// ---------------------------------------------------------------------------
test("executeAgentCli calls onLine for each output line", async () => {
  const lines = [];

  await executeAgentCli({
    command: "sh",
    args: ["-c", "printf 'line1\\nline2\\nline3'"],
    onLine: (line) => lines.push(line),
    label: "line-test",
  });

  assert.ok(lines.includes("line1"), "line1 captured");
  assert.ok(lines.includes("line2"), "line2 captured");
  assert.ok(lines.includes("line3"), "line3 captured");
});
