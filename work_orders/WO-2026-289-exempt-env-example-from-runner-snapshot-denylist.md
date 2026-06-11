---
id: WO-2026-289
title: Exempt .env.example from runner snapshot denylist
goal: Exempt .env.example from the runner snapshot/diff denylist so that repos requiring .env.example pass review without manual intervention.
context:
  - 'File: server/runner_agent.ts line 142: DENY_BASENAME_PREFIXES = [".env"]'
  - "isDeniedRelPath() at line 433 uses startsWith check: DENY_BASENAME_PREFIXES.some(p => base.startsWith(p))"
  - This blocks .env.example which is safe (template vars, not secrets)
  - 'Fix approach: add DENY_BASENAME_EXCEPTIONS = [".env.example"] allowlist checked before prefix deny'
  - "Cross-project request from acme-marketing: their WO-2026-001 repeatedly fails review because .env.example is required but runner filters it"
acceptance_criteria:
  - .env.example is NOT filtered by isDeniedRelPath() — it appears in diff.patch and reviewer snapshot
  - .env, .env.local, .env.production, .env.development etc. remain denied
  - DENY_BASENAME_PREFIXES logic updated to allow exactly .env.example (not .env.example.local or similar)
  - Existing test coverage passes
  - At least one new test in runner_agent.test verifies .env.example is allowed while .env and .env.local are denied
non_goals: []
stop_conditions:
  - .env.example passes isDeniedRelPath() check (returns false)
  - .env, .env.local, .env.production remain denied
  - All existing runner_agent tests pass
  - New test confirms .env.example allowed and .env denied
priority: 1
tags:
  - runner
  - bugfix
estimate_hours: 0.5
status: done
created_at: 2026-02-10
updated_at: 2026-02-12
depends_on: []
era: v0
---
## Notes
- 
