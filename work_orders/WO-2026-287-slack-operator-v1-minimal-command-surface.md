---
id: WO-2026-287
title: Slack Operator V1 minimal command surface
goal: "Add minimal command-style controls alongside NL interaction: pcc help/status/pause/resume/end."
context:
  - Primary mode remains NL; commands are operational shortcuts
  - Commands must respect the same people/authorization gates as normal requests
acceptance_criteria:
  - Parser recognizes pcc help/status/pause/resume/end in DM and mention-thread contexts
  - Command handlers execute safely against global session APIs
  - Unauthorized command attempts return clear denial with unblock guidance
  - Command execution emits milestone-consistent Slack responses
non_goals:
  - Large slash-command framework
  - Project-specific command grammar expansion
stop_conditions:
  - If command parsing is ambiguous with NL intent, prefer safe no-op and ask for clarification in-thread
priority: 2
tags:
  - slack
  - commands
  - operator-v1
estimate_hours: 3
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on:
  - WO-2026-282
  - WO-2026-286
era: v2
---
## Notes
- 
