# Work Orders

Work Orders are the unit of work and Kanban cards in Shiftboss. They are Markdown files with YAML frontmatter.

## Location
Each repo stores its Work Orders in `work_orders/`.

## Frontmatter contract

Required fields for a card to be **Ready**:

```yaml
---
id: WO-YYYY-NNN
title: "Short name"
goal: "What changes when done"
context:
  - "Links/notes to relevant files or docs"
acceptance_criteria:
  - "Observable, testable outcomes"
non_goals:
  - "Explicit exclusions"
stop_conditions:
  - "When to halt and report instead of guessing"
priority: 1-5
tags: ["theme", "area"]
estimate_hours: 0.5
status: backlog|ready|building|ai_review|you_review|done|blocked|parked
created_at: "YYYY-MM-DD"
updated_at: "YYYY-MM-DD"
depends_on: []
era: v1
---
```

Metadata requirements:
- `depends_on`: required array (use `[]` for root work orders).
- `era`: required, one of `v0`, `v1`, or `v2`.

Optional fields (can be added to the frontmatter as needed):
- `base_branch`: default base branch for runs when no run-level override is provided.
- `reviewer_snapshot`: reviewer repo snapshot mode. Use `full` to include gitignored assets; default is `tracked` (git-tracked files only).
- `context_files`: external files to mount into the builder sandbox (see [Context Files](#context-files) below).

### Context Files

Some work orders need external context (session logs, config files, production data) that lives outside the repo. The `context_files` field copies external files into a gitignored `.context/` directory in the worktree before the builder starts. The builder can read these files but should not modify or commit them.

Context files can be set at two levels:
1. **Project-level** via `PATCH /repos/:id` with a `context_files` JSON array (persisted in the DB).
2. **Work-order-level** via the `context_files` frontmatter field.

WO-level entries override project-level entries with the same `dest` key. Both levels are merged before copying.

#### Frontmatter example

```yaml
context_files:
  - source: "~/.config/myapp/config.toml"
    dest: "config.toml"
  - source: "/var/log/app/recent.log"
    dest: "logs/recent.log"
```

#### Project-level API example

```bash
curl -X PATCH http://localhost:4010/repos/{id} \
  -H 'Content-Type: application/json' \
  -d '{"context_files": [{"source": "~/.config/myapp/config.toml", "dest": "config.toml"}]}'
```

Pass `"context_files": null` to clear project-level context files.

#### Rules and limits
- `source` must be an absolute path (after `~` expansion). Relative sources are skipped.
- `dest` must be a relative path with no `..` segments. Path traversal is rejected.
- Individual files (or directory totals) exceeding 50 MB are skipped.
- Symlinks that escape the source directory are rejected.
- Files land in `{worktree}/.context/{dest}` which is automatically added to `.gitignore`.
- Skipped entries emit a warning in the run log but do not fail the run.

### Per-Project Builder Sandbox

By default, builders run in Codex CLI's `workspace-write` sandbox with network access controlled by the global monitoring settings. Some projects need elevated permissions — for example, running tests that bind loopback sockets or reaching a host daemon.

Two project-level fields control this:

#### `builder_sandbox_mode`

Overrides the global sandbox mode (`SHIFTBOSS_BUILDER_SANDBOX` env var) for this project only.

| Value | Effect |
|-------|--------|
| `null` | Use global default (typically `workspace-write`) |
| `"read-only"` | Filesystem read-only |
| `"workspace-write"` | Can write to worktree only |
| `"workspace-write-whitelist"` | Write + network domain whitelist |
| `"danger-full-access"` | Full filesystem and loopback network access |

When set to `danger-full-access`, the builder also gets `network-full-access` automatically.

#### `builder_env`

Injects custom environment variables into the builder's Codex process. Useful for API keys needed during tests or eval verification.

Blocked keys: `PATH`, `HOME`, `USER`, `SHELL`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`.

#### API example

```bash
curl -X PATCH http://localhost:4010/repos/{id} \
  -H 'Content-Type: application/json' \
  -d '{
    "builder_sandbox_mode": "danger-full-access",
    "builder_env": {"ANTHROPIC_API_KEY": "sk-ant-..."}
  }'
```

Pass `null` for either field to clear and revert to defaults.

### Dependencies
Example:
```yaml
depends_on:
  - "WO-2026-050"
  - "acme-api:WO-2026-001"
```

Everything below the frontmatter is free-form detail/spec.

## Status semantics
- `backlog`: idea exists but not specified.
- `ready`: contract complete; safe to run.
- `building`: builder agent in progress.
- `ai_review`: reviewer agent evaluating builder output.
- `you_review`: approved by reviewer; awaiting your accept/follow-up.
- `done`: accepted by you.
- `blocked`: needs input or external dependency.
- `parked`: intentionally paused; may include a parked-until date in body.

## Run flow
1. Builder agent runs against a single Ready Work Order.
2. Builder produces: git diff, summary, tests status, risks.
3. Fresh reviewer agent reviews Work Order + diff, and may run read-only inspection commands against a sanitized repo snapshot (e.g., excludes `.env*`, private keys). Set `reviewer_snapshot: full` when the reviewer must inspect gitignored local assets.
4. If reviewer requests changes, builder loops until approval.
5. Tester gate runs automated checks (browser E2E smoke at minimum).
6. Only after Reviewer + Tester pass, an approved summary is surfaced to you in `you_review`.

### Tester gate (v0)
- Runs against a production-like build, not `next dev`.
- For this repo: `npm run test:e2e` (Playwright) includes desktop + mobile viewport smoke.
- On failure, the tester output should include a concise report plus artifacts (trace/video/screenshot).
