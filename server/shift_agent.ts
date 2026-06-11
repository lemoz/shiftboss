import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  getControlCenterApiUrl,
  getProcessEnv,
  getServerPort,
  getShiftAllowedToolsOverride,
  getShiftClaudePath,
  getShiftModelOverride,
  getShiftPromptPathOverride,
} from "./config.js";
import { getShiftByProjectId, registerJob, updateShift, type ShiftRow } from "./db.js";
import { killProcessTree } from "./agent_execution.js";

type ShiftLogTail = { lines: string[]; has_more: boolean; log_path: string };

const DEFAULT_ALLOWED_TOOLS =
  "Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch";
const DEFAULT_SHIFT_TIMEOUT_MINUTES = 120;

function resolveApiBaseUrl(): string {
  const baseUrl = getControlCenterApiUrl();
  if (baseUrl) return baseUrl;
  const port = getServerPort();
  return `http://localhost:${port}`;
}

function resolveClaudePath(): string {
  return getShiftClaudePath();
}

function resolveAllowedTools(): string {
  return getShiftAllowedToolsOverride() || DEFAULT_ALLOWED_TOOLS;
}

function resolveModel(): string | null {
  return getShiftModelOverride();
}

function resolvePromptPath(projectPath: string): string {
  const override = getShiftPromptPathOverride();
  if (override) return override;
  const projectPrompt = path.join(projectPath, "prompts", "shift_agent.md");
  if (fs.existsSync(projectPrompt)) return projectPrompt;
  return path.join(process.cwd(), "prompts", "shift_agent.md");
}

function renderShiftPrompt(params: {
  projectId: string;
  baseUrl: string;
  timeoutMinutes: number;
  promptPath: string;
}): string {
  const template = fs.readFileSync(params.promptPath, "utf8");
  return template
    .replaceAll("{project_id}", params.projectId)
    .replaceAll("{base_url}", params.baseUrl)
    .replaceAll("{shift_timeout_minutes}", String(params.timeoutMinutes));
}

function resolveShiftTimeoutMinutes(shift: ShiftRow): number {
  if (!shift.expires_at) return DEFAULT_SHIFT_TIMEOUT_MINUTES;
  const startedAt = Date.parse(shift.started_at);
  const expiresAt = Date.parse(shift.expires_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) {
    return DEFAULT_SHIFT_TIMEOUT_MINUTES;
  }
  const minutes = Math.round((expiresAt - startedAt) / 60_000);
  return minutes > 0 ? minutes : DEFAULT_SHIFT_TIMEOUT_MINUTES;
}

export function resolveShiftLogPaths(projectPath: string, shiftId: string): {
  absolutePath: string;
  relativePath: string;
} {
  const relativePath = path.join(".system", "shifts", shiftId, "agent.log");
  return {
    relativePath,
    absolutePath: path.join(projectPath, relativePath),
  };
}

function appendShiftLog(logPath: string, message: string): void {
  try {
    fs.appendFileSync(logPath, `${message}\n`);
  } catch {
    // Best-effort logging only.
  }
}

function recordSpawnFailure(params: {
  projectId: string;
  shiftId: string;
  logPath: string;
  error: unknown;
}): void {
  const message =
    params.error instanceof Error ? params.error.message : String(params.error);
  appendShiftLog(params.logPath, `[spawn-error] ${message}`);
  const shift = getShiftByProjectId(params.projectId, params.shiftId);
  if (!shift || shift.status !== "active") return;
  updateShift(shift.id, {
    status: "failed",
    completed_at: new Date().toISOString(),
    error: message,
  });
}

/**
 * Terminate the shift agent's process group unconditionally.
 * Uses killProcessTree (SIGCONT+SIGTERM+SIGKILL) so a SIGSTOP'd process
 * actually receives and acts on the signal.
 */
export async function terminateShiftProcess(pid: number, logPath?: string): Promise<void> {
  try {
    await killProcessTree(pid);
  } catch (err) {
    if (logPath) {
      appendShiftLog(logPath, `[terminate] killProcessTree pid=${pid} error: ${String(err)}`);
    }
  }
}

export function scheduleShiftTimeout(params: {
  projectId: string;
  shiftId: string;
  pid: number;
  expiresAt: string | null;
  logPath: string;
}): void {
  if (!params.expiresAt) return;
  const expiresAtMs = Date.parse(params.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return;
  const delayMs = Math.max(0, expiresAtMs - Date.now());
  const timer = setTimeout(() => {
    // Kill the process regardless of current row status.  The original check
    // `shift.status !== "active"` caused the timer to bail when the row had
    // already been marked expired/failed by another path (sweep race), leaving
    // the claude process running unbounded.
    appendShiftLog(
      params.logPath,
      `[timeout] Shift timer fired; terminating pid ${params.pid}`
    );
    // Update the DB row only if the shift is still active.  Another path (sweep
    // race, abandon, reaper) may have already transitioned the row — we must
    // not overwrite that state.  The process kill below is unconditional: even
    // if the row has already been marked expired/failed, the process might still
    // be running.
    const shift = getShiftByProjectId(params.projectId, params.shiftId);
    if (shift?.status === "active") {
      updateShift(shift.id, {
        status: "expired",
        completed_at: new Date().toISOString(),
        error: "Shift expired",
      });
    }
    void terminateShiftProcess(params.pid, params.logPath);
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

export function spawnShiftAgent(params: {
  projectId: string;
  projectPath: string;
  shift: ShiftRow;
}): { pid: number; log_path: string } {
  const { absolutePath, relativePath } = resolveShiftLogPaths(
    params.projectPath,
    params.shift.id
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const promptPath = resolvePromptPath(params.projectPath);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Shift prompt not found at ${promptPath}`);
  }
  const baseUrl = resolveApiBaseUrl();
  const prompt = renderShiftPrompt({
    projectId: params.projectId,
    baseUrl,
    timeoutMinutes: resolveShiftTimeoutMinutes(params.shift),
    promptPath,
  });
  const logFd = fs.openSync(absolutePath, "a");
  const model = resolveModel();
  const args = [
    "--dangerously-skip-permissions",
    "--allowedTools",
    resolveAllowedTools(),
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (model) {
    args.push("--model", model);
  }
  args.push("-p", prompt);
  const child = spawn(
    resolveClaudePath(),
    args,
    {
      cwd: params.projectPath,
      env: {
        ...getProcessEnv(),
        SHIFTBOSS_API_URL: baseUrl,
        SHIFTBOSS_SHIFT_ID: params.shift.id,
        // Legacy names kept for prompts/scripts that still reference them.
        CONTROL_CENTER_API_URL: baseUrl,
        PCC_SHIFT_ID: params.shift.id,
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    }
  );
  fs.closeSync(logFd);

  // NOTE: Do NOT call recordSpawnFailure (which sets status='failed') from
  // here.  That would cause spawnShiftAgentWithRetry's retry attempt to run
  // against a shift row already marked failed, breaking the scheduler's
  // single-active-shift invariant.  The caller (spawnShiftAgentWithRetry or
  // the HTTP route) is responsible for marking the shift failed only after all
  // retry attempts are exhausted.
  child.once("error", (error) => {
    // Log the spawn error but do NOT touch the DB row — caller handles it.
    appendShiftLog(absolutePath, `[spawn-error] ${error.message}`);
  });

  if (!child.pid) {
    throw new Error("Shift agent failed to start");
  }

  const pid = child.pid;

  // Persist the pid so the reaper and startup recovery can kill orphans.
  updateShift(params.shift.id, { pid });

  // Register in the jobs table so the reaper covers every spawn path (HTTP
  // route, scheduler, and global-agent inline spawn) — no call site can forget
  // this because it lives here at the single spawn point.
  registerJob({ kind: "shift", ref_id: params.shift.id, pid });

  // Attach exit listener (works even after unref while the server lives).
  // If the agent exits without having completed or handed off the shift, mark
  // it failed immediately rather than waiting the full 120-minute timeout.
  child.once("exit", (code, signal) => {
    const shift = getShiftByProjectId(params.projectId, params.shift.id);
    if (!shift || shift.status !== "active") return; // already completed/expired
    const reason = signal
      ? `Shift agent exited with signal ${signal}`
      : `Shift agent exited with code ${code ?? "unknown"}`;
    appendShiftLog(absolutePath, `[exit] ${reason}`);
    updateShift(params.shift.id, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error: reason,
    });
  });

  scheduleShiftTimeout({
    projectId: params.projectId,
    shiftId: params.shift.id,
    pid,
    expiresAt: params.shift.expires_at,
    logPath: absolutePath,
  });
  child.unref();
  return { pid, log_path: relativePath };
}

function tailLines(
  filePath: string,
  maxLines: number,
  maxBytes = 24_000
): { lines: string[]; has_more: boolean } {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    let lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    const hasMore = stat.size > maxBytes || lines.length > maxLines;
    return { lines: lines.slice(-maxLines), has_more: hasMore };
  } catch {
    return { lines: [], has_more: false };
  }
}

export function tailShiftLog(
  projectPath: string,
  shiftId: string,
  lineCount: number
): ShiftLogTail {
  const { absolutePath, relativePath } = resolveShiftLogPaths(projectPath, shiftId);
  const safeLines = Math.max(1, Math.min(500, Math.trunc(lineCount)));
  const tail = tailLines(absolutePath, safeLines);
  return { ...tail, log_path: relativePath };
}
