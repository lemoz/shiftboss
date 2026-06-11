---
id: WO-2026-286
title: Slack Operator V1 milestone status updates
goal: Post concise milestone updates in Slack threads (accepted, running, blocked, done) with DM fallback where applicable.
context:
  - Global session events include check_in, guidance, alert, completion
  - Need milestone-only verbosity, not per-decision chatter
acceptance_criteria:
  - Milestone mapper translates session events to accepted/running/blocked/done messages
  - Messages are posted to originating Slack thread, with DM fallback when thread context missing
  - Each actionable request produces a coherent lifecycle trail in Slack
  - No duplicate milestone spam for replayed events
non_goals:
  - Realtime streaming token updates
  - Granular per-action logs in Slack
stop_conditions:
  - If origin thread cannot be resolved, stop posting thread updates and fall back to DM with explicit notice
priority: 2
tags:
  - slack
  - observability
  - milestones
  - operator-v1
estimate_hours: 4
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on:
  - WO-2026-284
  - WO-2026-285
era: v2
---
## Notes
- 
