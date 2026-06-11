import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const { patchWorkOrder, createWorkOrder } = await import("./work_orders.ts");

function runGit(repoPath, args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "git failed";
    throw new Error(message);
  }
  return result.stdout.trim();
}

function setupRepo(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboss-wo-sec-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  runGit(tmpDir, ["init"]);
  runGit(tmpDir, ["config", "user.email", "tester@example.com"]);
  runGit(tmpDir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(tmpDir, "README.md"), "init\n", "utf8");
  runGit(tmpDir, ["add", "."]);
  runGit(tmpDir, ["commit", "-m", "init"]);
  return tmpDir;
}

// Writes a WO file whose *frontmatter id* is the supplied (possibly hostile) value,
// but whose *filename* is a safe slug — mirroring how findWorkOrderFileById falls
// back to scanning frontmatter when no filename match is found.
function writeRawWorkOrder(repoPath, id, fileSlug) {
  const dir = path.join(repoPath, "work_orders");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${fileSlug}.md`);
  // Use single-quoted YAML scalar to avoid the hostile id breaking the YAML parse.
  const escaped = id.replace(/'/g, "''");
  const content = `---
id: '${escaped}'
title: "Hostile WO"
goal: "test"
context: []
acceptance_criteria: []
non_goals: []
stop_conditions: []
priority: 3
tags: []
estimate_hours: 1
status: "backlog"
created_at: "2026-01-01"
updated_at: "2026-01-01"
depends_on: []
era: null
---

## Notes
-
`;
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("patchWorkOrder with a shell-injection WO id does not execute injected command", (t) => {
  const repoPath = setupRepo(t);
  const sentinelPath = path.join(os.tmpdir(), `pwned-${Date.now()}`);
  t.after(() => {
    try { fs.unlinkSync(sentinelPath); } catch { /* already absent */ }
  });

  // Craft a WO id that would break out of a shell-quoted commit message and
  // create a sentinel file.  With execSync string interpolation this would run:
  //   git commit -m "chore(wo): update x"; touch <sentinelPath>; #"
  const hostileId = `x"; touch ${sentinelPath}; #`;

  writeRawWorkOrder(repoPath, hostileId, "hostile-double-quote");

  // patchWorkOrder should complete without throwing (best-effort git is caught).
  patchWorkOrder(repoPath, hostileId, { status: "backlog" });

  // The sentinel must NOT exist — the shell payload must not have executed.
  assert.ok(
    !fs.existsSync(sentinelPath),
    `sentinel file ${sentinelPath} was created — shell injection succeeded`
  );
});

test("createWorkOrder with a hostile title slug does not execute injected command", (t) => {
  const repoPath = setupRepo(t);
  const sentinelPath = path.join(os.tmpdir(), `pwned-create-${Date.now()}`);
  t.after(() => {
    try { fs.unlinkSync(sentinelPath); } catch { /* already absent */ }
  });

  // The filePath passed to git add is derived from the title slug.  A title
  // with shell metacharacters that end up in a shell string would be dangerous.
  // With spawnSync arg arrays the path is passed as a literal argv entry.
  const hostileTitle = `Normal Title"; touch ${sentinelPath}; #`;

  createWorkOrder(repoPath, { title: hostileTitle });

  assert.ok(
    !fs.existsSync(sentinelPath),
    `sentinel file ${sentinelPath} was created — shell injection succeeded`
  );
});

test("patchWorkOrder with a backtick payload WO id does not execute injected command", (t) => {
  const repoPath = setupRepo(t);
  const sentinelPath = path.join(os.tmpdir(), `pwned-bt-${Date.now()}`);
  t.after(() => {
    try { fs.unlinkSync(sentinelPath); } catch { /* already absent */ }
  });

  // Backtick command substitution in a shell string.
  const hostileId = "WO-`touch " + sentinelPath + "`";

  writeRawWorkOrder(repoPath, hostileId, "hostile-backtick");
  patchWorkOrder(repoPath, hostileId, { status: "backlog" });

  assert.ok(
    !fs.existsSync(sentinelPath),
    `sentinel file ${sentinelPath} was created — backtick injection succeeded`
  );
});
