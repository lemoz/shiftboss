/**
 * git_safety.ts — shared safe-staging and safe-merge primitives.
 *
 * Single source of truth for:
 *   - stageSafeChanges   — safe index staging (skips deletions, enforces protected paths)
 *   - mergeNoTouch       — merge without switching the user's working copy
 *   - abortStaleMergeHead — clear a MERGE_HEAD left by a crashed merge
 *
 * Both runner_agent.ts and chat_worktree.ts import from here.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// Internal git helpers
// ---------------------------------------------------------------------------

type GitResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function spawnSyncResult(
  command: string,
  args: string[],
  opts: { cwd: string }
): GitResult {
  const res = spawnSync(command, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function runGit(
  args: string[],
  opts: { cwd: string; allowFailure?: boolean; log?: (line: string) => void }
): GitResult {
  opts.log?.(`git ${args.join(" ")}`);
  const result = spawnSyncResult("git", args, { cwd: opts.cwd });
  if (!opts.allowFailure && result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "git failed";
    throw new Error(message);
  }
  return result;
}

// ---------------------------------------------------------------------------
// abortStaleMergeHead
// ---------------------------------------------------------------------------

/**
 * Detect whether the repo has a MERGE_HEAD (left by a killed/crashed merge) and
 * abort it.  Returns true if an in-progress merge was found and aborted.
 * Used both at lock acquisition time (H) and on server startup.
 *
 * `log` is optional — when omitted the function operates silently.
 */
export function abortStaleMergeHead(
  repoPath: string,
  log?: (line: string) => void
): boolean {
  const mergeHeadPath = path.join(repoPath, ".git", "MERGE_HEAD");
  if (!fs.existsSync(mergeHeadPath)) return false;
  log?.(`[merge-recovery] Detected stale MERGE_HEAD in ${repoPath}; aborting.`);
  const result = runGit(["merge", "--abort"], {
    cwd: repoPath,
    allowFailure: true,
    log,
  });
  if (result.status !== 0) {
    log?.(
      `[merge-recovery] git merge --abort failed: ${result.stderr || result.stdout}`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// stageSafeChanges
// ---------------------------------------------------------------------------

const DEFAULT_PROTECTED_PATHS = ["work_orders/", ".control.yml", ".control.yaml"];

export type StageSafeResult =
  | { ok: true; staged: number }
  | { ok: false; reason: "protected_path_violation"; violations: string[] };

/**
 * Safe staging: reset the index, parse `git status --porcelain -z` (NUL-separated,
 * never C-quoted), skip deletions, check for protected-path violations, stage
 * non-deletions in batches, and restore work_orders/ + .control.yml from HEAD.
 *
 * Options:
 *   worktreePath  — path to the git worktree to stage in.
 *   log           — optional line logger; omit for silent operation.
 */
export function stageSafeChanges(opts: {
  worktreePath: string;
  log?: (line: string) => void;
}): StageSafeResult {
  const { worktreePath, log } = opts;

  // Reset the index (builder or provider may have staged things already)
  runGit(["reset", "HEAD"], { cwd: worktreePath, allowFailure: true, log });

  // Use --porcelain -z so paths are NUL-separated and never C-quoted
  const statusResult = runGit(["status", "--porcelain", "-z"], {
    cwd: worktreePath,
    allowFailure: true,
  });
  const filesToStage: string[] = [];
  const deletedFiles: string[] = [];

  // -z output: each entry is "<XY> <path>" terminated by NUL; for renames it is
  // "<XY> <new>\0<old>" — we only need the first path per entry.
  const raw = statusResult.stdout;
  let i = 0;
  while (i < raw.length) {
    const nul = raw.indexOf("\0", i);
    const entry = nul === -1 ? raw.slice(i) : raw.slice(i, nul);
    i = nul === -1 ? raw.length : nul + 1;
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    // Skip the second half of a rename pair (the old name)
    if (xy[0] === "R" || xy[1] === "R" || xy[0] === "C" || xy[1] === "C") {
      // consume the old-name NUL entry that follows
      const nul2 = raw.indexOf("\0", i);
      i = nul2 === -1 ? raw.length : nul2 + 1;
    }
    if (xy.includes("D")) {
      deletedFiles.push(filePath);
    } else {
      filesToStage.push(filePath);
    }
  }

  // Read protected_paths from HEAD version of .control.yml to prevent a
  // builder-modified file from shrinking the protection set.
  let projectProtectedPaths: string[] = [];
  try {
    for (const f of [".control.yml", ".control.yaml"]) {
      const showResult = runGit(["show", `HEAD:${f}`], {
        cwd: worktreePath,
        allowFailure: true,
      });
      if (showResult.status === 0 && showResult.stdout) {
        const parsed = YAML.parse(showResult.stdout);
        if (Array.isArray(parsed?.protected_paths)) {
          projectProtectedPaths = parsed.protected_paths;
        }
        break;
      }
    }
  } catch { /* ignore parse errors */ }
  const allProtectedPaths = [
    ...new Set([...DEFAULT_PROTECTED_PATHS, ...projectProtectedPaths]),
  ];

  const protectedViolations: string[] = [];
  for (const deleted of deletedFiles) {
    for (const pp of allProtectedPaths) {
      if (deleted === pp || deleted.startsWith(pp)) {
        protectedViolations.push(deleted);
        break;
      }
    }
  }
  if (protectedViolations.length > 0) {
    // Attempt to restore the violated paths before returning
    runGit(["checkout", "HEAD", "--", ...protectedViolations], {
      cwd: worktreePath,
      allowFailure: true,
      log,
    });
    return { ok: false, reason: "protected_path_violation", violations: protectedViolations };
  }

  // Stage only modified/new files (skip deletions entirely)
  const BATCH_SIZE = 50;
  if (filesToStage.length > 0) {
    for (let b = 0; b < filesToStage.length; b += BATCH_SIZE) {
      const batch = filesToStage.slice(b, b + BATCH_SIZE);
      runGit(["add", "--", ...batch], { cwd: worktreePath, log });
    }
  }

  // Restore modified/deleted work_orders/ and .control.yml/.control.yaml from HEAD —
  // builders keep changing these despite prompt instructions.
  runGit(["checkout", "HEAD", "--", "work_orders/"], {
    cwd: worktreePath,
    allowFailure: true,
    log,
  });
  runGit(["checkout", "HEAD", "--", ".control.yml", ".control.yaml"], {
    cwd: worktreePath,
    allowFailure: true,
    // allowFailure: one or both of these files may not exist in HEAD
  });

  return { ok: true, staged: filesToStage.length };
}

// ---------------------------------------------------------------------------
// mergeNoTouch
// ---------------------------------------------------------------------------

export type MergeNoTouchResult =
  | { ok: true }
  | { ok: false; error: string; isConflict: boolean; conflictFiles: string[] };

function listUnmergedFiles(repoPath: string): string[] {
  const result = runGit(
    ["diff", "--name-only", "--diff-filter=U"],
    { cwd: repoPath, allowFailure: true }
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Merge `branchName` into `baseBranch` WITHOUT switching branches in the user's
 * main working copy.
 *
 * Strategy:
 *   - If `baseBranch` is NOT currently checked out → create a temporary detached
 *     worktree at `baseBranch`, merge there, remove the worktree.
 *   - If `baseBranch` IS currently checked out → require a clean tree, hold the
 *     lock, do the checkout-merge-restore dance, and restore in a finally block.
 *
 * Options:
 *   repoPath     — path to the main git repo.
 *   baseBranch   — the branch to merge into.
 *   branchName   — the branch to merge from.
 *   mergeMessage — the merge commit message.
 *   log          — optional line logger; omit for silent operation.
 *   gitName      — git user.name for the merge commit (default "Shiftboss").
 *   gitEmail     — git user.email for the merge commit (default "shiftboss@local").
 *
 * Caller must already hold the merge lock (when using the runner path).
 */
export function mergeNoTouch(opts: {
  repoPath: string;
  baseBranch: string;
  branchName: string;
  mergeMessage: string;
  log?: (line: string) => void;
  gitName?: string;
  gitEmail?: string;
}): MergeNoTouchResult {
  const {
    repoPath,
    baseBranch,
    branchName,
    mergeMessage,
    log,
    gitName = "Shiftboss",
    gitEmail = "shiftboss@local",
  } = opts;

  // Abort any stale MERGE_HEAD before proceeding (H)
  abortStaleMergeHead(repoPath, log);

  const currentBranchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    allowFailure: true,
  });
  const currentBranch = currentBranchResult.stdout.trim();
  const baseCheckedOut = currentBranch === baseBranch;

  const mergeArgs = [
    "-c",
    `user.name=${gitName}`,
    "-c",
    `user.email=${gitEmail}`,
    "merge",
    branchName,
    "--no-ff",
    "-m",
    mergeMessage,
  ];

  if (!baseCheckedOut) {
    // Preferred path: merge in a fresh detached worktree — user's checkout untouched.
    // Capture the base SHA now so the final ref update can be a compare-and-swap:
    // if anything else moves the base ref while we merge (e.g. a stolen lock),
    // update-ref fails instead of silently clobbering the other merge.
    const baseShaBefore = runGit(["rev-parse", `refs/heads/${baseBranch}`], {
      cwd: repoPath,
      allowFailure: true,
    }).stdout.trim();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboss-merge-"));
    const tmpWtPath = path.join(tmpDir, "wt");
    try {
      const addWt = runGit(
        ["worktree", "add", "--detach", tmpWtPath, baseBranch],
        { cwd: repoPath, allowFailure: true, log }
      );
      if (addWt.status !== 0) {
        // Fall through to checkout dance below if worktree add fails; clean up tmpDir first.
        log?.(
          `Warning: temp worktree add failed (${addWt.stderr.trim()}); falling back to checkout merge.`
        );
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        try {
          const mergeResult = runGit(mergeArgs, { cwd: tmpWtPath, allowFailure: true, log });
          if (mergeResult.status !== 0) {
            const conflictFiles = listUnmergedFiles(tmpWtPath);
            runGit(["merge", "--abort"], { cwd: tmpWtPath, allowFailure: true, log });
            return {
              ok: false,
              error:
                mergeResult.stderr.trim() ||
                mergeResult.stdout.trim() ||
                `merge into ${baseBranch} failed`,
              isConflict: conflictFiles.length > 0,
              conflictFiles,
            };
          }
          // Push the merge commit from the temp worktree's HEAD back to the branch ref.
          // git update-ref is the safest: no checkout required in the main repo.
          const newSha = runGit(["rev-parse", "HEAD"], {
            cwd: tmpWtPath,
            allowFailure: true,
          }).stdout.trim();
          if (!newSha) {
            return {
              ok: false,
              error: "failed to read merge commit SHA from temp worktree",
              isConflict: false,
              conflictFiles: [],
            };
          }
          const updateRef = runGit(
            baseShaBefore
              ? ["update-ref", `refs/heads/${baseBranch}`, newSha, baseShaBefore]
              : ["update-ref", `refs/heads/${baseBranch}`, newSha],
            { cwd: repoPath, allowFailure: true, log }
          );
          if (updateRef.status !== 0) {
            return {
              ok: false,
              error: updateRef.stderr.trim() || "git update-ref failed",
              isConflict: false,
              conflictFiles: [],
            };
          }
          return { ok: true };
        } finally {
          runGit(["worktree", "remove", "--force", tmpWtPath], {
            cwd: repoPath,
            allowFailure: true,
          });
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      log?.(
        `Warning: temp worktree approach failed: ${String(err)}; falling back to checkout merge.`
      );
    }
  }

  // Fallback / base-is-checked-out path: explicit checkout-merge-restore.
  // Main repo must be clean before we switch branches.
  const statusResult = runGit(["status", "--porcelain"], { cwd: repoPath, allowFailure: true });
  if (statusResult.stdout.trim()) {
    return {
      ok: false,
      error: "main repo has uncommitted changes; cannot merge",
      isConflict: false,
      conflictFiles: [],
    };
  }

  const priorBranch = currentBranch && currentBranch !== "HEAD" ? currentBranch : null;
  let checkedOut = false;
  try {
    runGit(["checkout", baseBranch], { cwd: repoPath, log });
    checkedOut = true;

    const mergeResult = runGit(mergeArgs, { cwd: repoPath, allowFailure: true, log });
    if (mergeResult.status !== 0) {
      const conflictFiles = listUnmergedFiles(repoPath);
      runGit(["merge", "--abort"], { cwd: repoPath, allowFailure: true, log });
      return {
        ok: false,
        error:
          mergeResult.stderr.trim() ||
          mergeResult.stdout.trim() ||
          `merge into ${baseBranch} failed`,
        isConflict: conflictFiles.length > 0,
        conflictFiles,
      };
    }
    return { ok: true };
  } finally {
    if (checkedOut && priorBranch && priorBranch !== baseBranch) {
      runGit(["checkout", priorBranch], { cwd: repoPath, allowFailure: true, log });
    }
  }
}
