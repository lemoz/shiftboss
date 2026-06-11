---
id: WO-2026-285
title: Slack Operator V1 emoji-based high-risk approvals
goal: Enforce high-risk-only approval gating with emoji approval/deny in Slack threads by authorized approvers.
context:
  - "Risk policy: high-risk actions require explicit approval; low-risk actions can proceed"
  - Slack event handler must process reaction_added for white_check_mark and x
acceptance_criteria:
  - DB table slack_action_requests exists with status lifecycle pending_approval/approved/denied/expired/executing/completed
  - High-risk requests generate approval message in-thread with expiration based on CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES
  - Only configured approvers can approve/deny via reactions
  - Unauthorized reactions are ignored and logged
  - Expired approvals cannot execute and are marked expired
non_goals:
  - UI approval dashboard in web app
  - Multi-step human workflow beyond approve/deny
stop_conditions:
  - If approval record and Slack message cannot be correlated deterministically, stop execution and mark request failed safely
priority: 1
tags:
  - slack
  - approvals
  - risk-controls
  - operator-v1
estimate_hours: 5
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on:
  - WO-2026-282
  - WO-2026-284
era: v2
---
## Notes
- 
