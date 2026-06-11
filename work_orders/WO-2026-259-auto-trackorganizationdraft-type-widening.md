---
id: WO-2026-259
title: "[Auto] TrackOrganizationDraft type widening"
goal: "Evaluate and implement if appropriate: TrackOrganizationDraft type widening"
context:
  - Surfaced during WO-2026-217 review
  - "File: server/track_organization.ts (69)"
  - "Change: TrackOrganizationDraft type widening"
  - "Rationale: Schema/type change is unrelated to network whitelist scope; handle in track-organization work."
acceptance_criteria:
  - TrackOrganizationDraft type in server/track_organization.ts:69 is widened to accept the required shape.
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
