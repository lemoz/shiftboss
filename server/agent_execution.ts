/**
 * agent_execution.ts — ONE supervised spawn path for every agent CLI invocation.
 *
 * Provides executeAgentCli() which wraps a spawned CLI with:
 *  - configurable timeout (SIGTERM → SIGKILL after grace period, whole process group)
 *  - process-group kill so shell children die too (SIGCONT first if SIGSTOPped)
 *  - optional StreamMonitor attachment with verdict-race fix
 *  - optional per-line callback
 *  - cost metadata capture via optional onCost hook
 *
 * See findings brief agent-execution.md for the bugs this fixes.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import fs from "fs";
import path from "path";
import { StreamMonitor, type StreamMonitorContext } from "./stream_monitor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentExecCostInfo = {
  /** Raw stdout emitted by the CLI — callers parse what they need. */
  stdout: string;
  /** Raw stderr emitted by the CLI. */
  stderr: string;
};

export type ExecuteAgentCliResult = {
  exitCode: number;
  timedOut: boolean;
  killed: boolean;
  /** Captured stdout + stderr available to cost hooks. */
  cost: AgentExecCostInfo;
};

export type ExecuteAgentCliOptions = {
  /** Executable and arguments. args[0] is the command. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** If supplied, stdin is written then closed. */
  stdinInput?: string;
  /** Timeout in milliseconds. Undefined = no timeout. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (default 4 s). */
  killGraceMs?: number;
  /** If supplied, the child's stdout/stderr are both piped through this monitor. */
  streamMonitor?: StreamMonitor;
  streamContext?: StreamMonitorContext;
  /** Called with each line emitted to stdout or stderr. */
  onLine?: (line: string) => void;
  /** Called after the process exits and monitor verdicts have been awaited. */
  onCost?: (info: AgentExecCostInfo) => void;
  /** Human-readable label for logging. */
  label?: string;
  /** Optional log callback. */
  log?: (line: string) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KILL_POLL_MS = 200;
const DEFAULT_KILL_GRACE_MS = 4_000;
const KILL_WAIT_TIMEOUT_MS = 2_000;

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

async function waitForExit(target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(target)) return true;
    await new Promise<void>((r) => setTimeout(r, KILL_POLL_MS));
  }
  return !isAlive(target);
}

/**
 * Kill the process tree rooted at `pid`.
 *
 * On POSIX the child MUST have been spawned with detached:true so it is its own
 * process-group leader.  We send signals to -pid (the group) so that shell
 * children die too.  If the leader is currently SIGSTOPped, SIGCONT is sent first
 * so that the subsequent SIGTERM/SIGKILL is actually delivered.
 *
 * On Windows we fall back to signalling the single pid.
 */
export async function killProcessTree(
  pid: number,
  log?: (line: string) => void
): Promise<void> {
  if (process.platform === "win32") {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    await waitForExit(pid, DEFAULT_KILL_GRACE_MS);
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    return;
  }

  const pgid = -pid; // negative = process group

  // SIGCONT first in case the leader is SIGSTOPped (signals don't deliver to stopped processes)
  try { process.kill(pgid, "SIGCONT"); } catch { /* group may already be gone */ }

  try { process.kill(pgid, "SIGTERM"); } catch { /* group may already be gone */ }
  if (await waitForExit(pgid, DEFAULT_KILL_GRACE_MS)) return;

  log?.(`[agent-exec] process group ${pid} still alive after SIGTERM; sending SIGKILL`);
  try { process.kill(pgid, "SIGKILL"); } catch { /* already gone */ }
  await waitForExit(pgid, KILL_WAIT_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Execute an agent CLI with full supervision:
 *  - process-group kill on timeout (SIGTERM → SIGKILL, SIGCONT-first)
 *  - StreamMonitor verdict race resolved before deciding success
 *  - cost hook called after monitor drains
 */
export async function executeAgentCli(
  opts: ExecuteAgentCliOptions
): Promise<ExecuteAgentCliResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    stdinInput,
    timeoutMs,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    streamMonitor,
    streamContext,
    onLine,
    onCost,
    label = command,
    log,
  } = opts;

  const spawnOpts: SpawnOptions = {
    cwd: cwd ?? process.cwd(),
    stdio: stdinInput !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
    // detached so the child becomes its own process-group leader and we can
    // kill the whole tree via -pid.
    detached: process.platform !== "win32",
  };

  const child: ChildProcess = spawn(command, args, spawnOpts);
  const pid = child.pid;

  if (!pid) {
    throw new Error(`[agent-exec] failed to spawn ${label}: no pid assigned`);
  }

  log?.(`[agent-exec] spawned ${label} pid=${pid}`);

  // Attach stream monitor before any data arrives
  if (streamMonitor && streamContext) {
    streamMonitor.attach(child, streamContext);
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let lineBuf = "";

  const handleData = (buf: Buffer) => {
    stdoutChunks.push(buf);
    if (onLine) {
      lineBuf += buf.toString("utf8");
      const parts = lineBuf.split("\n");
      lineBuf = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    }
  };

  child.stdout?.on("data", handleData);
  child.stderr?.on("data", (buf: Buffer) => {
    stderrChunks.push(buf);
    if (onLine) {
      const text = buf.toString("utf8");
      for (const line of text.split("\n").filter(Boolean)) onLine(line);
    }
  });

  if (stdinInput !== undefined) {
    child.stdin?.write(stdinInput);
    child.stdin?.end();
  }

  let timedOut = false;
  let killed = false;

  // Timeout machinery.
  //
  // DEADLOCK FIX: we must be able to resolve the kill-promise from OUTSIDE the
  // setTimeout callback (i.e. when the process exits before the timer fires and
  // we call clearTimeout).  If we only called resolve() inside the callback,
  // clearTimeout() would cancel it and the promise would never settle, causing
  // `await killPromise` to hang forever on the normal (non-timeout) path.
  //
  // We use a ref object (not a plain `let` variable) so TypeScript does not
  // narrow away the assignment that happens inside the Promise executor.
  const killRef: { settle: (() => void) | null; handle: ReturnType<typeof setTimeout> | null } =
    { settle: null, handle: null };
  const killPromise = (async () => {
    if (!timeoutMs) return;
    await new Promise<void>((r) => {
      killRef.settle = r;
      killRef.handle = setTimeout(async () => {
        if (child.exitCode !== null) { r(); return; } // already exited naturally
        timedOut = true;
        killed = true;
        log?.(`[agent-exec] ${label} timed out after ${timeoutMs}ms; killing process group`);
        await killProcessTree(pid, log);
        r();
      }, timeoutMs);
    });
  })();

  // Wait for process close
  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

  // Cancel the timer and unblock killPromise so it settles immediately on the
  // normal (non-timeout) path.  Without this the await below would hang forever
  // because resolve() inside the setTimeout callback would never be called.
  if (killRef.handle) clearTimeout(killRef.handle);
  killRef.settle?.();
  await killPromise;

  // Detach monitor from the child (stops listening to its events)
  if (streamMonitor) {
    streamMonitor.detach();
  }

  // Flush pending line buffer
  if (onLine && lineBuf) {
    onLine(lineBuf);
    lineBuf = "";
  }

  // MONITOR VERDICT RACE FIX: await in-flight Gemini verdicts before deciding
  // success.  A KILL verdict that resolves after process exit must still fail
  // the run, not be silently downgraded to 'allowed'.
  if (streamMonitor) {
    await streamMonitor.flush();
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const costInfo: AgentExecCostInfo = { stdout, stderr };

  onCost?.(costInfo);

  return { exitCode, timedOut, killed, cost: costInfo };
}
