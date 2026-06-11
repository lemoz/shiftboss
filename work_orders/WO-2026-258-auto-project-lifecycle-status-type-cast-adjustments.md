---
id: WO-2026-258
title: "[Auto] Project lifecycle status type cast adjustments"
goal: "Evaluate and implement if appropriate: Project lifecycle status type cast adjustments"
context:
  - Surfaced during WO-2026-217 review
  - "File: server/index.ts (1773, 2779)"
  - "Change: Project lifecycle status type cast adjustments"
  - "Rationale: Type cast edits are unrelated to builder network whitelist mode; move to a dedicated WO."
acceptance_criteria:
  - Project lifecycle status type casts in server/index.ts at lines 1773 and 2779 are corrected or removed.
  - No runtime behavior change — type-only fix.
  - TypeScript compilation passes with no new errors.
non_goals: []
stop_conditions:
  - If the type change causes cascading errors in other files, stop and document the scope.
priority: 3
tags:
  - auto-generated
  - from-scope-creep
estimate_hours: 0.5
status: backlog
created_at: 2026-01-30
updated_at: 2026-02-10
depends_on: []
era: v2
---
## Notes
- 
