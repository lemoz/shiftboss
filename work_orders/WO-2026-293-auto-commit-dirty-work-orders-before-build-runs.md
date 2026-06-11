---
id: WO-2026-293
title: Auto-commit dirty work_orders before build runs
goal: Prevent merge conflicts caused by uncommitted work order files on main. Before starting any build run, PCC should auto-commit any dirty or untracked files in the work_orders/ directory on the source branch.
context: []
acceptance_criteria:
  - Before branching for a new run, check if work_orders/ has uncommitted changes (modified or untracked)
  - "If dirty, auto-commit with message: Auto-commit: work order metadata updates"
  - Run proceeds from the clean commit as its base
  - If git commit fails (e.g. merge in progress), log a warning and proceed anyway — do not block the build
  - Existing builds that start from a clean work_orders/ dir are unaffected
non_goals: []
stop_conditions:
  - Do not auto-commit files outside work_orders/ — only WO metadata
  - Do not force-push or rewrite history
priority: 2
tags:
  - dx
  - reliability
estimate_hours: 2
status: ready
created_at: 2026-02-18
updated_at: 2026-02-18
depends_on: []
era: v1
---
## Notes
- 
