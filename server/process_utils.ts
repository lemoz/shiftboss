/**
 * process_utils.ts — shared low-level process helpers.
 *
 * Extracted here so that runner_agent.ts and job_supervisor.ts (and any future
 * module) can import the same signal-0 probe rather than maintaining separate
 * copies that can silently diverge.
 */

/**
 * Returns true if the process identified by `target` is alive.
 *
 * `target` may be a positive pid or a negative process-group id (−pid).
 * Handles EPERM (process exists but we lack permission to signal it) as alive,
 * and ESRCH (no such process) as dead.  Any other error is re-thrown.
 */
export function isProcessAlive(target: number): boolean {
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
