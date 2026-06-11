---
id: WO-2026-283
title: Slack Operator V1 stale debrief rollover for global session
goal: When a new actionable Slack request arrives and active session is stale in debrief, debrief in Slack then auto-start a fresh session.
context:
  - Current global session APIs are in server/index.ts and server/global_agent_sessions.ts
  - Current stale state can block new work when session remains in debrief
acceptance_criteria:
  - Stale debrief detection uses configurable threshold CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES
  - On actionable request, stale debrief summary is posted to last Slack thread and requester DM when possible
  - Old session is transitioned to ended and a new session is created/started automatically
  - Rollover is idempotent for repeated webhook deliveries
non_goals:
  - Changing non-slack global session lifecycle semantics
  - Reworking debrief content generation logic
stop_conditions:
  - If active session state is ambiguous or corrupt, stop and emit structured diagnostic to logs instead of forcing transitions
priority: 1
tags:
  - slack
  - global-session
  - lifecycle
  - operator-v1
estimate_hours: 3
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on:
  - WO-2026-281
era: v2
---
## Notes
- 
