---
id: WO-2026-281
title: Slack Operator V1 baseline reconciliation and feature flag
goal: Audit current PCC Slack channel behavior against the v1 operator target and gate all new operator logic behind CONTROL_CENTER_SLACK_OPERATOR_V1.
context:
  - Existing implementation in server/slack.ts and server/slack_db.ts
  - Existing WO-2026-156 is in you_review and must be superseded cleanly
  - Need a gap matrix documenting current vs target behavior
acceptance_criteria:
  - Gap matrix exists in repo docs mapping current behavior to v1 target
  - New config flag CONTROL_CENTER_SLACK_OPERATOR_V1 is read by server config
  - Legacy Slack OAuth and webhook paths remain functional when flag is off
  - Slack unit tests cover url_verification and baseline message flow without regressions
non_goals:
  - Implementing full people-gated operator behavior
  - Implementing approval workflows
stop_conditions:
  - If baseline behavior cannot be reproduced locally, stop and capture failing endpoint plus evidence before changing logic
priority: 2
tags:
  - slack
  - global-session
  - operator-v1
  - reconciliation
estimate_hours: 2
status: done
created_at: 2026-02-10
updated_at: 2026-02-10
depends_on: []
era: v2
---
## Notes
- 
