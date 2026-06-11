---
id: WO-2026-282
title: Slack Operator V1 people-first identity gate and authorization
goal: Enforce people-table-first actionability using Slack user identifiers and operator/approver allowlists from config.
context:
  - People API exists under /people and /people/resolve
  - Slack actor identity arrives via team_id + user_id in event envelope
  - v1 mapping format is people_identifiers.type=other, normalized value slack:{team_id}:{user_id}
acceptance_criteria:
  - GET /people/resolve/slack?team_id={teamId}&user_id={userId} resolves mapped person or returns 404
  - Mapped operator can submit actionable Slack requests
  - Mapped non-operator is blocked for actionability with clear response
  - Unmapped user is blocked and approver(s) are auto-mentioned for unblock
  - Config keys CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS and CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS are enforced
non_goals:
  - Email-based Slack identity resolution
  - Dynamic UI-managed role assignment
stop_conditions:
  - If mapping format ambiguity appears, stop and standardize one canonical normalized format before adding callers
priority: 1
tags:
  - slack
  - people
  - authz
  - operator-v1
estimate_hours: 4
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on:
  - WO-2026-281
era: v2
---
## Notes
- 
