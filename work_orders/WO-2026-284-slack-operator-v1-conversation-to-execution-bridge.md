---
id: WO-2026-284
title: Slack Operator V1 conversation-to-execution bridge
goal: Convert Slack conversations from passive intake into operational requests that create communications and trigger global-session execution.
context:
  - Current finalizeConversation writes project communication and starts a global shift directly
  - v1 requires one shared global session as orchestration surface
  - Need traceability across slack_conversations, project communications, and session events
acceptance_criteria:
  - Actionable Slack conversations create project communications with source=slack payload metadata
  - Actionable requests auto-start or resume global session (single shared session model)
  - Non-actionable chatter remains conversation-only and does not trigger execution
  - Logs include correlation identifiers for Slack conversation id, communication id, and global session id
non_goals:
  - Replacing global agent decision loop
  - Adding external queue infrastructure
stop_conditions:
  - If communication creation fails, stop execution path and notify Slack thread with failure context
priority: 1
tags:
  - slack
  - communications
  - global-session
  - operator-v1
estimate_hours: 5
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on:
  - WO-2026-282
  - WO-2026-283
era: v2
---
## Notes
- 
