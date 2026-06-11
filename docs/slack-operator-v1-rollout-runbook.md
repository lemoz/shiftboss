# Slack Operator V1 Rollout Runbook

Use this runbook to enable, verify, and roll back Slack Operator V1 safely.

## Required Configuration

Set these environment variables before enabling V1:

```bash
SHIFTBOSS_SLACK_CLIENT_ID=...
SHIFTBOSS_SLACK_CLIENT_SECRET=...
SHIFTBOSS_SLACK_SIGNING_SECRET=...
SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS=person-id-1,person-id-2
SHIFTBOSS_SLACK_APPROVER_PERSON_IDS=person-id-3,person-id-4
```

Optional but recommended:

```bash
SHIFTBOSS_SLACK_REDIRECT_URI=https://your-host/slack/oauth/callback
SHIFTBOSS_SLACK_SCOPES=chat:write,im:history,im:write,app_mentions:read,channels:history
SHIFTBOSS_SLACK_STALE_DEBRIEF_MINUTES=30
SHIFTBOSS_SLACK_APPROVAL_TTL_MINUTES=30
```

## Rollout Gate

`SHIFTBOSS_SLACK_OPERATOR_V1` is the rollout switch.

- `false`: legacy/baseline Slack behavior (rollback mode).
- `true`: V1 operator behavior (identity gate, approvals, milestones, commands).

## Pre-Enable Validation

Run Slack regression tests with the flag off:

```bash
SHIFTBOSS_SLACK_OPERATOR_V1=false node --import tsx/esm --test server/slack.test.js
```

Do not enable V1 if any core regression fails.

## Enable Procedure

1. Set the flag:
   ```bash
   SHIFTBOSS_SLACK_OPERATOR_V1=true
   ```
2. Restart the API server:
   ```bash
   npm run server:dev
   ```
3. Verify OAuth install URL is available:
   ```bash
   curl -s http://localhost:4010/slack/install | jq .
   ```
4. Re-run Slack tests in V1 mode:
   ```bash
   SHIFTBOSS_SLACK_OPERATOR_V1=true node --import tsx/esm --test server/slack.test.js
   ```

## Rollback Procedure

1. Disable V1 immediately:
   ```bash
   SHIFTBOSS_SLACK_OPERATOR_V1=false
   ```
2. Restart the API server.
3. Validate rollback behavior:
   ```bash
   SHIFTBOSS_SLACK_OPERATOR_V1=false node --import tsx/esm --test server/slack.test.js
   ```
4. Confirm no active incidents in Slack and that new traffic follows baseline behavior.

## Failure Triage

### OAuth install/callback failures

- Symptom: `/slack/install` returns error or callback fails.
- Checks:
  - `SHIFTBOSS_SLACK_CLIENT_ID` and `SHIFTBOSS_SLACK_CLIENT_SECRET` are set.
  - Redirect URI in Slack app settings matches `SHIFTBOSS_SLACK_REDIRECT_URI` (if set).
  - Slack API response error from `oauth.v2.access`.

### Event webhook challenge/signature failures

- Symptom: Slack cannot verify Events endpoint.
- Checks:
  - `SHIFTBOSS_SLACK_SIGNING_SECRET` matches Slack app configuration.
  - Incoming request timestamp/signature headers are present.
  - `url_verification` challenge is echoed successfully.

### Authorization/approval failures

- Symptom: mapped users blocked unexpectedly, or approvals not executing.
- Checks:
  - Slack identity mapping exists (`slack:{team}:{user}` identifiers).
  - `SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS` and `SHIFTBOSS_SLACK_APPROVER_PERSON_IDS` are correct.
  - Approval reaction is `:white_check_mark:` (approve) or `:x:` (deny), and request is not expired.

### Milestone/command issues

- Symptom: accepted/running/blocked/done trail missing or `pcc` commands not acting.
- Checks:
  - V1 flag is enabled.
  - Command sent in supported context (DM or mention-thread).
  - Thread context availability; if missing, confirm DM fallback messages.

## Stop Condition

If any core Slack regression fails during rollout, stop and keep:

```bash
SHIFTBOSS_SLACK_OPERATOR_V1=false
```
