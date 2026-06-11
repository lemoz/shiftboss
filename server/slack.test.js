import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-slack-"));
const dbPath = path.join(tmpDir, "slack.db");
const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
const originalPccDbPath = process.env.PCC_DATABASE_PATH;
const originalSlackClientId = process.env.CONTROL_CENTER_SLACK_CLIENT_ID;
const originalSlackClientSecret = process.env.CONTROL_CENTER_SLACK_CLIENT_SECRET;
const originalSlackOperatorV1Flag = process.env.CONTROL_CENTER_SLACK_OPERATOR_V1;
const originalSlackOperatorPersonIds =
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS;
const originalSlackApproverPersonIds =
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS;
const originalSlackStaleDebriefMinutes =
  process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES;
const originalSlackApprovalTtlMinutes =
  process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES;

process.env.CONTROL_CENTER_DB_PATH = dbPath;
process.env.PCC_DATABASE_PATH = dbPath;
process.env.CONTROL_CENTER_SLACK_CLIENT_ID = "test-client";
process.env.CONTROL_CENTER_SLACK_CLIENT_SECRET = "test-secret";
process.env.CONTROL_CENTER_SLACK_OPERATOR_V1 = "false";
process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = "";
process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES = "30";
process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES = "30";

const { getDb } = await import("./db.ts");
const {
  createProjectCommunication,
  createPerson,
  createPersonIdentifier,
  listProjectCommunications,
  upsertProject,
} = await import("./db.ts");
const {
  buildSlackInstallUrl,
  exchangeSlackOAuthCode,
  handleSlackEventEnvelope,
  notifySlackMilestoneForSessionEvent,
} = await import("./slack.ts");
const { getSlackOperatorV1Enabled } = await import("./config.ts");
const {
  consumeSlackOAuthState,
  createSlackConversation,
  getSlackInstallationByTeam,
  getSlackConversationById,
  listSlackActionRequestsByConversation,
  listSlackConversationMessages,
  updateSlackConversation,
  upsertSlackInstallation,
} = await import("./slack_db.ts");

upsertProject({
  id: "project-control-center",
  path: process.cwd(),
  name: "Project Control Center",
  description: null,
  success_criteria: null,
  success_metrics: "[]",
  type: "long_term",
  stage: "building",
  status: "active",
  lifecycle_status: "active",
  priority: 1,
  starred: 0,
  hidden: 0,
  auto_shift_enabled: 0,
  tags: "[]",
  isolation_mode: "local",
  vm_size: "medium",
  last_run_at: null,
});

after(() => {
  const db = getDb();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalDbPath === undefined) {
    delete process.env.CONTROL_CENTER_DB_PATH;
  } else {
    process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
  }
  if (originalPccDbPath === undefined) {
    delete process.env.PCC_DATABASE_PATH;
  } else {
    process.env.PCC_DATABASE_PATH = originalPccDbPath;
  }
  if (originalSlackClientId === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_CLIENT_ID;
  } else {
    process.env.CONTROL_CENTER_SLACK_CLIENT_ID = originalSlackClientId;
  }
  if (originalSlackClientSecret === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_CLIENT_SECRET;
  } else {
    process.env.CONTROL_CENTER_SLACK_CLIENT_SECRET = originalSlackClientSecret;
  }
  if (originalSlackOperatorV1Flag === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_OPERATOR_V1;
  } else {
    process.env.CONTROL_CENTER_SLACK_OPERATOR_V1 = originalSlackOperatorV1Flag;
  }
  if (originalSlackOperatorPersonIds === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS;
  } else {
    process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = originalSlackOperatorPersonIds;
  }
  if (originalSlackApproverPersonIds === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS;
  } else {
    process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = originalSlackApproverPersonIds;
  }
  if (originalSlackStaleDebriefMinutes === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES;
  } else {
    process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES = originalSlackStaleDebriefMinutes;
  }
  if (originalSlackApprovalTtlMinutes === undefined) {
    delete process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES;
  } else {
    process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES = originalSlackApprovalTtlMinutes;
  }
});

function resetGlobalExecutionState() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE global_shifts
       SET status = 'completed',
           completed_at = COALESCE(completed_at, @completed_at),
           error = COALESCE(error, 'reset for slack test')
     WHERE status = 'active'`
  ).run({ completed_at: now });
  db.prepare(
    `UPDATE global_agent_sessions
       SET state = 'ended',
           ended_at = COALESCE(ended_at, @ended_at),
           updated_at = @updated_at
     WHERE state != 'ended'`
  ).run({ ended_at: now, updated_at: now });
}

function seedGlobalSession(sessionId, state = "autonomous") {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO global_agent_sessions
      (id, chat_thread_id, state, onboarding_rubric, integrations_configured, goals, priority_projects, constraints, briefing_summary, briefing_confirmed_at, autonomous_started_at, paused_at, iteration_count, decisions_count, actions_count, last_check_in_at, ended_at, created_at, updated_at)
     VALUES
      (@id, @chat_thread_id, @state, @onboarding_rubric, @integrations_configured, @goals, @priority_projects, @constraints, @briefing_summary, @briefing_confirmed_at, @autonomous_started_at, @paused_at, @iteration_count, @decisions_count, @actions_count, @last_check_in_at, @ended_at, @created_at, @updated_at)`
  ).run({
    id: sessionId,
    chat_thread_id: null,
    state,
    onboarding_rubric: "[]",
    integrations_configured: "{}",
    goals: "[]",
    priority_projects: "[]",
    constraints: "{}",
    briefing_summary: null,
    briefing_confirmed_at: now,
    autonomous_started_at: now,
    paused_at: null,
    iteration_count: 0,
    decisions_count: 0,
    actions_count: 0,
    last_check_in_at: now,
    ended_at: null,
    created_at: now,
    updated_at: now,
  });
}

test("buildSlackInstallUrl includes a usable state", () => {
  const result = buildSlackInstallUrl();
  assert.equal(result.ok, true);
  assert.ok(result.url);
  const url = new URL(result.url);
  const state = url.searchParams.get("state");
  assert.ok(state);
  const first = consumeSlackOAuthState(state);
  assert.equal(first.ok, true);
  const second = consumeSlackOAuthState(state);
  assert.equal(second.ok, false);
});

test("exchangeSlackOAuthCode persists installation for callback flow", async (t) => {
  const originalFetch = globalThis.fetch;
  let oauthRequestBody = "";
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    assert.equal(input, "https://slack.com/api/oauth.v2.access");
    oauthRequestBody = typeof init?.body === "string" ? init.body : "";
    return new Response(
      JSON.stringify({
        ok: true,
        access_token: "xoxb-oauth-token",
        bot_user_id: "B-OAUTH",
        scope: "chat:write,im:history",
        team: { id: "T-OAUTH", name: "OAuth Team" },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await exchangeSlackOAuthCode("oauth-code-123");
  assert.equal(result.ok, true);
  assert.equal(result.installation?.team_id, "T-OAUTH");
  assert.match(oauthRequestBody, /client_id=test-client/);
  assert.match(oauthRequestBody, /client_secret=test-secret/);
  assert.match(oauthRequestBody, /code=oauth-code-123/);

  const persisted = getSlackInstallationByTeam("T-OAUTH");
  assert.ok(persisted);
  assert.equal(persisted.bot_token, "xoxb-oauth-token");
  assert.equal(persisted.bot_user_id, "B-OAUTH");
  assert.equal(persisted.scope, "chat:write,im:history");
});

test("url_verification envelopes return Slack challenge", async () => {
  const result = await handleSlackEventEnvelope({
    type: "url_verification",
    challenge: "challenge-token",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { challenge: "challenge-token" });
});

test("channel thread replies continue active conversation in baseline mode", async () => {
  const threadTs = "1717000000.0001";
  const conversation = createSlackConversation({
    team_id: "T123",
    channel_id: "C123",
    user_id: "U123",
    thread_ts: threadTs,
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });

  const before = listSlackConversationMessages(conversation.id).length;

  await handleSlackEventEnvelope({
    type: "event_callback",
    team_id: "T123",
    event: {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U123",
      text: "Continuing the thread.",
      ts: "1717000000.0002",
      thread_ts: threadTs,
    },
  }, { operatorV1Enabled: false });

  const after = listSlackConversationMessages(conversation.id);
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].content, "Continuing the thread.");
});

test("CONTROL_CENTER_SLACK_OPERATOR_V1=false keeps rollback path on legacy behavior", async (t) => {
  resetGlobalExecutionState();
  process.env.CONTROL_CENTER_SLACK_OPERATOR_V1 = "false";
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = "";
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-ROLLBACK",
    team_name: "Team Rollback",
    bot_user_id: "B-ROLLBACK",
    bot_token: "xoxb-rollback-token",
  });

  const threadTs = "1717000000.1001";
  const conversation = createSlackConversation({
    team_id: "T-ROLLBACK",
    channel_id: "C-ROLLBACK",
    user_id: "U-ROLLBACK",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeCommunications = listProjectCommunications({
    projectId: "project-control-center",
  }).length;

  const originalFetch = globalThis.fetch;
  const sentMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    sentMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717000000.1003" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-ROLLBACK",
      event: {
        type: "message",
        channel: "C-ROLLBACK",
        channel_type: "channel",
        user: "U-ROLLBACK",
        text: "please delete production data and run cleanup, done",
        ts: "1717000000.1002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: getSlackOperatorV1Enabled() }
  );

  const afterCommunications = listProjectCommunications({
    projectId: "project-control-center",
  }).length;
  assert.equal(afterCommunications, beforeCommunications + 1);
  assert.equal(listSlackActionRequestsByConversation(conversation.id).length, 0);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /closing this conversation and passing context to the global agent/i);

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "processed");
  assert.equal(updatedConversation.global_session_id, null);
});

test("v1 mapped operators can submit actionable Slack requests", async () => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Operator User" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-OP:U-OP",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";

  const threadTs = "1717000001.0001";
  const conversation = createSlackConversation({
    team_id: "T-OP",
    channel_id: "C-OP",
    user_id: "U-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const before = listProjectCommunications({ projectId: "project-control-center" }).length;

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-OP",
      event: {
        type: "message",
        channel: "C-OP",
        channel_type: "channel",
        user: "U-OP",
        text: "please run this request, done",
        ts: "1717000001.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const after = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(after, before + 1);
  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "processed");
  assert.equal(typeof updatedConversation.global_session_id, "string");
  assert.equal(typeof updatedConversation.global_shift_id, "string");
  const db = getDb();
  const session = db
    .prepare("SELECT state FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(updatedConversation.global_session_id);
  assert.ok(session);
  assert.equal(session.state, "autonomous");
});

test("v1 non-actionable chatter remains conversation-only and does not trigger execution", async () => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Chatter Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-CHAT:U-CHAT",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";

  const threadTs = "1717000001.1001";
  const conversation = createSlackConversation({
    team_id: "T-CHAT",
    channel_id: "C-CHAT",
    user_id: "U-CHAT",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const before = listProjectCommunications({ projectId: "project-control-center" }).length;

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CHAT",
      event: {
        type: "message",
        channel: "C-CHAT",
        channel_type: "channel",
        user: "U-CHAT",
        text: "done",
        ts: "1717000001.1002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const after = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(after, before);
  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
  assert.equal(updatedConversation.global_session_id, null);
  assert.equal(updatedConversation.global_shift_id, null);
  const db = getDb();
  const activeSession = db
    .prepare("SELECT id FROM global_agent_sessions WHERE state != 'ended' LIMIT 1")
    .get();
  assert.equal(activeSession, undefined);
});

test("v1 stops execution and notifies Slack thread when communication creation fails", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Failure Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-CFAIL:U-CFAIL",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-CFAIL",
    team_name: "Team Communication Failure",
    bot_user_id: "B-CFAIL",
    bot_token: "xoxb-cfail-token",
  });

  const db = getDb();
  db.exec(`
    DROP TRIGGER IF EXISTS slack_test_fail_escalation_insert;
    CREATE TRIGGER slack_test_fail_escalation_insert
    BEFORE INSERT ON escalations
    BEGIN
      SELECT RAISE(FAIL, 'simulated escalation insert failure');
    END;
  `);
  t.after(() => {
    db.exec("DROP TRIGGER IF EXISTS slack_test_fail_escalation_insert;");
  });

  const threadTs = "1717000001.2001";
  const conversation = createSlackConversation({
    team_id: "T-CFAIL",
    channel_id: "C-CFAIL",
    user_id: "U-CFAIL",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const before = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  const sentMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    sentMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717000001.2003" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CFAIL",
      event: {
        type: "message",
        channel: "C-CFAIL",
        channel_type: "channel",
        user: "U-CFAIL",
        text: "please execute this request, done",
        ts: "1717000001.2002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const after = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(after, before);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /couldn't queue this request for execution/i);
  assert.match(sentMessages[0].text, /failed to create project communication/i);

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
  assert.equal(updatedConversation.global_session_id, null);
  assert.equal(updatedConversation.global_shift_id, null);
  const activeSession = db
    .prepare("SELECT id FROM global_agent_sessions WHERE state != 'ended' LIMIT 1")
    .get();
  assert.equal(activeSession, undefined);
});

test("v1 mapped non-operators are blocked from actionability", async () => {
  const operator = createPerson({ name: "Configured Operator" });
  const configuredIdentifier = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-NONOP:U-ALLOWED",
  });
  assert.ok(configuredIdentifier);
  const nonOperator = createPerson({ name: "Mapped But Not Operator" });
  const mapped = createPersonIdentifier({
    person_id: nonOperator.id,
    type: "other",
    value: "slack:T-NONOP:U-NONOP",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-NONOP",
    team_name: "Team Non-Operator",
    bot_user_id: "B-NONOP",
    bot_token: "xoxb-nonop-token",
  });

  const threadTs = "1717000002.0001";
  const conversation = createSlackConversation({
    team_id: "T-NONOP",
    channel_id: "C-NONOP",
    user_id: "U-NONOP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const before = listProjectCommunications({ projectId: "project-control-center" }).length;
  const originalFetch = globalThis.fetch;
  const sentMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    sentMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717000002.0003" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await handleSlackEventEnvelope(
      {
        type: "event_callback",
        team_id: "T-NONOP",
        event: {
          type: "message",
          channel: "C-NONOP",
          channel_type: "channel",
          user: "U-NONOP",
          text: "done",
          ts: "1717000002.0002",
          thread_ts: threadTs,
        },
      },
      { operatorV1Enabled: true }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(after, before);
  assert.equal(sentMessages.length, 1);
  assert.equal(typeof sentMessages[0]?.text, "string");
  assert.match(sentMessages[0].text, /not in SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS/i);
  assert.doesNotMatch(sentMessages[0].text, /closing this conversation/i);
  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
});

test("v1 unmapped users are blocked and approvers are auto-mentioned", async (t) => {
  const approver = createPerson({ name: "Approver User" });
  const mapped = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-UNMAPPED:U-APPROVER",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = "";
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;

  upsertSlackInstallation({
    team_id: "T-UNMAPPED",
    team_name: "Team Unmapped",
    bot_user_id: "B-UNMAPPED",
    bot_token: "xoxb-test-token",
  });

  const threadTs = "1717000003.0001";
  const conversation = createSlackConversation({
    team_id: "T-UNMAPPED",
    channel_id: "C-UNMAPPED",
    user_id: "U-UNMAPPED",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const before = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  const sentMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    sentMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717000003.0003" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-UNMAPPED",
      event: {
        type: "message",
        channel: "C-UNMAPPED",
        channel_type: "channel",
        user: "U-UNMAPPED",
        text: "done",
        ts: "1717000003.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const after = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(after, before);
  assert.equal(sentMessages.length, 1);
  const messagePayload = sentMessages[0];
  assert.equal(typeof messagePayload.text, "string");
  assert.match(messagePayload.text, /not mapped to a person record/i);
  assert.match(messagePayload.text, /<@U-APPROVER>/);
  assert.doesNotMatch(messagePayload.text, /closing this conversation/i);
  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
});

test("v1 unmapped users do not mention approvers from different Slack teams", async (t) => {
  const approver = createPerson({ name: "Cross-Team Approver" });
  const mapped = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-OTHER:U-OTHER",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = "";
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;

  upsertSlackInstallation({
    team_id: "T-MISSING",
    team_name: "Team Missing",
    bot_user_id: "B-MISSING",
    bot_token: "xoxb-missing-token",
  });

  const threadTs = "1717000004.0001";
  const conversation = createSlackConversation({
    team_id: "T-MISSING",
    channel_id: "C-MISSING",
    user_id: "U-MISSING",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  const sentMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    sentMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717000004.0003" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-MISSING",
      event: {
        type: "message",
        channel: "C-MISSING",
        channel_type: "channel",
        user: "U-MISSING",
        text: "done",
        ts: "1717000004.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  assert.equal(sentMessages.length, 1);
  const messagePayload = sentMessages[0];
  assert.equal(typeof messagePayload.text, "string");
  assert.match(messagePayload.text, /not mapped to a person record/i);
  assert.match(messagePayload.text, /Ask a configured approver/i);
  assert.doesNotMatch(messagePayload.text, /<@U-OTHER>/);
  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
});

test("v1 actionable requests roll over stale debrief once across duplicate webhook deliveries", async (t) => {
  resetGlobalExecutionState();
  process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES = "5";

  const operator = createPerson({ name: "Rollover Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-ROLL:U-ROLL",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";

  upsertSlackInstallation({
    team_id: "T-ROLL",
    team_name: "Team Rollover",
    bot_user_id: "B-ROLL",
    bot_token: "xoxb-roll-token",
  });

  const db = getDb();
  const staleSessionId = `session-stale-${Date.now()}`;
  const staleTime = new Date(Date.now() - 20 * 60_000).toISOString();
  const debriefSummary = "Stale summary for rollover test.";
  db.prepare(
    `INSERT INTO global_agent_sessions
      (id, chat_thread_id, state, onboarding_rubric, integrations_configured, goals, priority_projects, constraints, briefing_summary, briefing_confirmed_at, autonomous_started_at, paused_at, iteration_count, decisions_count, actions_count, last_check_in_at, ended_at, created_at, updated_at)
     VALUES
      (@id, @chat_thread_id, @state, @onboarding_rubric, @integrations_configured, @goals, @priority_projects, @constraints, @briefing_summary, @briefing_confirmed_at, @autonomous_started_at, @paused_at, @iteration_count, @decisions_count, @actions_count, @last_check_in_at, @ended_at, @created_at, @updated_at)`
  ).run({
    id: staleSessionId,
    chat_thread_id: null,
    state: "debrief",
    onboarding_rubric: "[]",
    integrations_configured: "{}",
    goals: "[]",
    priority_projects: "[]",
    constraints: "{}",
    briefing_summary: null,
    briefing_confirmed_at: null,
    autonomous_started_at: null,
    paused_at: null,
    iteration_count: 2,
    decisions_count: 3,
    actions_count: 1,
    last_check_in_at: staleTime,
    ended_at: null,
    created_at: staleTime,
    updated_at: staleTime,
  });
  db.prepare(
    `INSERT INTO global_agent_session_events
      (id, session_id, type, payload, created_at)
     VALUES
      (?, ?, ?, ?, ?)`
  ).run(
    `evt-${staleSessionId}`,
    staleSessionId,
    "completion",
    JSON.stringify({ summary: debriefSummary }),
    staleTime
  );

  const threadTs = "1717000999.0001";
  const conversation = createSlackConversation({
    team_id: "T-ROLL",
    channel_id: "C-ROLL",
    user_id: "U-ROLL",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (input.includes("https://slack.com/api/conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D-ROLL" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(
      JSON.stringify({ ok: true, ts: `${1717000999 + postMessages.length}.0003` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const payload = {
    type: "event_callback",
    team_id: "T-ROLL",
    event: {
      type: "message",
      channel: "C-ROLL",
      channel_type: "channel",
      user: "U-ROLL",
      text: "please take this request, done",
      ts: "1717000999.0002",
      thread_ts: threadTs,
    },
  };

  await handleSlackEventEnvelope(payload, { operatorV1Enabled: true });

  const afterFirstComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterFirstComms, beforeComms + 1);
  const endedStaleSession = db
    .prepare("SELECT state FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(staleSessionId);
  assert.equal(endedStaleSession.state, "ended");
  const activeSession = db
    .prepare(
      "SELECT id, state, autonomous_started_at FROM global_agent_sessions WHERE state != 'ended' ORDER BY created_at DESC LIMIT 1"
    )
    .get();
  assert.ok(activeSession);
  assert.notEqual(activeSession.id, staleSessionId);
  assert.equal(activeSession.state, "autonomous");
  assert.equal(typeof activeSession.autonomous_started_at, "string");

  const threadNotice = postMessages.find(
    (message) =>
      message.channel === "C-ROLL" &&
      message.thread_ts === threadTs &&
      typeof message.text === "string" &&
      message.text.includes("Debrief summary:")
  );
  assert.ok(threadNotice);
  assert.match(threadNotice.text, /stale summary for rollover test/i);
  const dmNotice = postMessages.find(
    (message) =>
      message.channel === "D-ROLL" &&
      typeof message.text === "string" &&
      message.text.includes("Debrief summary:")
  );
  assert.ok(dmNotice);

  const postCountAfterFirst = postMessages.length;
  await handleSlackEventEnvelope(payload, { operatorV1Enabled: true });
  const afterSecondComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterSecondComms, afterFirstComms);
  assert.equal(postMessages.length, postCountAfterFirst);
  const activeAfterDuplicate = db
    .prepare(
      "SELECT id FROM global_agent_sessions WHERE state != 'ended' ORDER BY created_at DESC LIMIT 1"
    )
    .get();
  assert.equal(activeAfterDuplicate.id, activeSession.id);

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "processed");
});

test("v1 actionable requests still forward when stale debrief rollover notices hit Slack send exceptions", async (t) => {
  resetGlobalExecutionState();
  process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES = "5";

  const operator = createPerson({ name: "Rollover Exception Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-ROLL-ERR:U-ROLL-ERR",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";

  upsertSlackInstallation({
    team_id: "T-ROLL-ERR",
    team_name: "Team Rollover Exceptions",
    bot_user_id: "B-ROLL-ERR",
    bot_token: "xoxb-roll-err-token",
  });

  const db = getDb();
  const resetTime = new Date().toISOString();
  db.prepare(
    `UPDATE global_agent_sessions
       SET state = 'ended',
           ended_at = COALESCE(ended_at, @ended_at),
           updated_at = @updated_at
     WHERE state != 'ended'`
  ).run({ ended_at: resetTime, updated_at: resetTime });
  const staleSessionId = `session-stale-err-${Date.now()}`;
  const staleTime = new Date(Date.now() - 20 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO global_agent_sessions
      (id, chat_thread_id, state, onboarding_rubric, integrations_configured, goals, priority_projects, constraints, briefing_summary, briefing_confirmed_at, autonomous_started_at, paused_at, iteration_count, decisions_count, actions_count, last_check_in_at, ended_at, created_at, updated_at)
     VALUES
      (@id, @chat_thread_id, @state, @onboarding_rubric, @integrations_configured, @goals, @priority_projects, @constraints, @briefing_summary, @briefing_confirmed_at, @autonomous_started_at, @paused_at, @iteration_count, @decisions_count, @actions_count, @last_check_in_at, @ended_at, @created_at, @updated_at)`
  ).run({
    id: staleSessionId,
    chat_thread_id: null,
    state: "debrief",
    onboarding_rubric: "[]",
    integrations_configured: "{}",
    goals: "[]",
    priority_projects: "[]",
    constraints: "{}",
    briefing_summary: null,
    briefing_confirmed_at: null,
    autonomous_started_at: null,
    paused_at: null,
    iteration_count: 2,
    decisions_count: 3,
    actions_count: 1,
    last_check_in_at: staleTime,
    ended_at: null,
    created_at: staleTime,
    updated_at: staleTime,
  });
  db.prepare(
    `INSERT INTO global_agent_session_events
      (id, session_id, type, payload, created_at)
     VALUES
      (?, ?, ?, ?, ?)`
  ).run(
    `evt-${staleSessionId}`,
    staleSessionId,
    "completion",
    JSON.stringify({ summary: "Stale summary for exception path." }),
    staleTime
  );

  const threadTs = "1717001999.0001";
  const conversation = createSlackConversation({
    team_id: "T-ROLL-ERR",
    channel_id: "C-ROLL-ERR",
    user_id: "U-ROLL-ERR",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  let failedRolloverPostAttempts = 0;
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("expected Slack API URL string");
    }
    if (input.includes("https://slack.com/api/conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D-ROLL-ERR" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (input.includes("https://slack.com/api/chat.postMessage")) {
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const payload = rawBody ? JSON.parse(rawBody) : {};
      if (
        typeof payload.text === "string" &&
        payload.text.includes("Debrief summary:")
      ) {
        failedRolloverPostAttempts += 1;
        throw new Error("simulated Slack API network failure");
      }
      return new Response(JSON.stringify({ ok: true, ts: "1717001999.0004" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected Slack API method: ${input}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-ROLL-ERR",
      event: {
        type: "message",
        channel: "C-ROLL-ERR",
        channel_type: "channel",
        user: "U-ROLL-ERR",
        text: "please handle this request, done",
        ts: "1717001999.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms + 1);
  assert.equal(failedRolloverPostAttempts, 2);

  const endedStaleSession = db
    .prepare("SELECT state FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(staleSessionId);
  assert.equal(endedStaleSession.state, "ended");
  const activeSession = db
    .prepare(
      "SELECT id, state FROM global_agent_sessions WHERE state != 'ended' ORDER BY created_at DESC LIMIT 1"
    )
    .get();
  assert.ok(activeSession);
  assert.notEqual(activeSession.id, staleSessionId);
  assert.equal(activeSession.state, "autonomous");

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "processed");
});

test("slack action requests table exists", () => {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slack_action_requests' LIMIT 1"
    )
    .get();
  assert.ok(row);
});

test("v1 high-risk requests create pending approval records and do not auto-execute", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "High Risk Operator" });
  const operatorIdentifier = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-HIGH:U-HIGH",
  });
  assert.ok(operatorIdentifier);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES = "20";

  upsertSlackInstallation({
    team_id: "T-HIGH",
    team_name: "Team High Risk",
    bot_user_id: "B-HIGH",
    bot_token: "xoxb-high-token",
  });

  const threadTs = "1717003000.0001";
  const conversation = createSlackConversation({
    team_id: "T-HIGH",
    channel_id: "C-HIGH",
    user_id: "U-HIGH",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  const sentMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    sentMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717003000.0009" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-HIGH",
      event: {
        type: "message",
        channel: "C-HIGH",
        channel_type: "channel",
        user: "U-HIGH",
        text: "please delete the production database, done",
        ts: "1717003000.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /high-risk request/i);
  assert.match(sentMessages[0].text, /white_check_mark/i);
  assert.match(sentMessages[0].text, /:x:/i);

  const actionRequests = listSlackActionRequestsByConversation(conversation.id);
  assert.equal(actionRequests.length, 1);
  const actionRequest = actionRequests[0];
  assert.equal(actionRequest.status, "pending_approval");
  assert.equal(actionRequest.risk_level, "high");
  assert.equal(actionRequest.approval_message_ts, "1717003000.0009");
  assert.equal(typeof actionRequest.expires_at, "string");

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
});

test("v1 high-risk approval prompt send exceptions fail safely without execution", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "High Risk Prompt Failure Operator" });
  const operatorIdentifier = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-HIGH-ERR:U-HIGH-ERR",
  });
  assert.ok(operatorIdentifier);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES = "20";

  upsertSlackInstallation({
    team_id: "T-HIGH-ERR",
    team_name: "Team High Risk Prompt Failure",
    bot_user_id: "B-HIGH-ERR",
    bot_token: "xoxb-high-err-token",
  });

  const threadTs = "1717003050.0001";
  const conversation = createSlackConversation({
    team_id: "T-HIGH-ERR",
    channel_id: "C-HIGH-ERR",
    user_id: "U-HIGH-ERR",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  let postMessageAttempts = 0;
  globalThis.fetch = async (input) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (input.includes("https://slack.com/api/chat.postMessage")) {
      postMessageAttempts += 1;
      throw new Error("simulated Slack API chat.postMessage exception");
    }
    throw new Error(`unexpected Slack API method: ${input}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-HIGH-ERR",
      event: {
        type: "message",
        channel: "C-HIGH-ERR",
        channel_type: "channel",
        user: "U-HIGH-ERR",
        text: "please revoke all production access, done",
        ts: "1717003050.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms);
  assert.ok(postMessageAttempts >= 1);

  const actionRequests = listSlackActionRequestsByConversation(conversation.id);
  assert.equal(actionRequests.length, 1);
  const failed = actionRequests[0];
  assert.equal(failed.status, "denied");
  assert.equal(typeof failed.decision_at, "string");
  assert.equal(failed.communication_id, null);
  assert.match(failed.error ?? "", /approval prompt failed/i);

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "ended");
});

test("v1 authorized approvers can approve high-risk requests via white_check_mark reaction", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Approve Operator" });
  const approver = createPerson({ name: "Approve Approver" });
  const mappedOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-APR:U-APR-OP",
  });
  const mappedApprover = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-APR:U-APR-APP",
  });
  assert.ok(mappedOperator);
  assert.ok(mappedApprover);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;

  upsertSlackInstallation({
    team_id: "T-APR",
    team_name: "Team Approve",
    bot_user_id: "B-APR",
    bot_token: "xoxb-apr-token",
  });

  const threadTs = "1717003100.0001";
  const conversation = createSlackConversation({
    team_id: "T-APR",
    channel_id: "C-APR",
    user_id: "U-APR-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const payload = rawBody ? JSON.parse(rawBody) : {};
    if (payload.channel !== "C-APR") {
      throw new Error(`unexpected channel payload: ${payload.channel}`);
    }
    return new Response(JSON.stringify({ ok: true, ts: "1717003100.0009" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-APR",
      event: {
        type: "message",
        channel: "C-APR",
        channel_type: "channel",
        user: "U-APR-OP",
        text: "please remove production access, done",
        ts: "1717003100.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const pending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(pending);
  assert.equal(pending.status, "pending_approval");
  assert.equal(typeof pending.approval_message_ts, "string");

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-APR",
      event: {
        type: "reaction_added",
        user: "U-APR-APP",
        reaction: "white_check_mark",
        item: {
          type: "message",
          channel: "C-APR",
          ts: pending.approval_message_ts,
        },
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms + 1);

  const completed = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(completed);
  assert.equal(completed.status, "completed");
  assert.equal(typeof completed.communication_id, "string");
  assert.equal(typeof completed.global_session_id, "string");
  assert.equal(typeof completed.global_shift_id, "string");

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "processed");
});

test("v1 duplicate approval races are idempotent and never downgrade completed requests", async (t) => {
  resetGlobalExecutionState();
  process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES = "5";

  const operator = createPerson({ name: "Approval Race Operator" });
  const approver = createPerson({ name: "Approval Race Approver" });
  const mappedOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-APR-RACE:U-APR-RACE-OP",
  });
  const mappedApprover = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-APR-RACE:U-APR-RACE-APP",
  });
  assert.ok(mappedOperator);
  assert.ok(mappedApprover);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;

  upsertSlackInstallation({
    team_id: "T-APR-RACE",
    team_name: "Team Approval Race",
    bot_user_id: "B-APR-RACE",
    bot_token: "xoxb-apr-race-token",
  });

  const db = getDb();
  const staleSessionId = `session-apr-race-${Date.now()}`;
  const staleTime = new Date(Date.now() - 20 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO global_agent_sessions
      (id, chat_thread_id, state, onboarding_rubric, integrations_configured, goals, priority_projects, constraints, briefing_summary, briefing_confirmed_at, autonomous_started_at, paused_at, iteration_count, decisions_count, actions_count, last_check_in_at, ended_at, created_at, updated_at)
     VALUES
      (@id, @chat_thread_id, @state, @onboarding_rubric, @integrations_configured, @goals, @priority_projects, @constraints, @briefing_summary, @briefing_confirmed_at, @autonomous_started_at, @paused_at, @iteration_count, @decisions_count, @actions_count, @last_check_in_at, @ended_at, @created_at, @updated_at)`
  ).run({
    id: staleSessionId,
    chat_thread_id: null,
    state: "debrief",
    onboarding_rubric: "[]",
    integrations_configured: "{}",
    goals: "[]",
    priority_projects: "[]",
    constraints: "{}",
    briefing_summary: null,
    briefing_confirmed_at: null,
    autonomous_started_at: null,
    paused_at: null,
    iteration_count: 1,
    decisions_count: 1,
    actions_count: 1,
    last_check_in_at: staleTime,
    ended_at: null,
    created_at: staleTime,
    updated_at: staleTime,
  });
  db.prepare(
    `INSERT INTO global_agent_session_events
      (id, session_id, type, payload, created_at)
     VALUES
      (?, ?, ?, ?, ?)`
  ).run(
    `evt-${staleSessionId}`,
    staleSessionId,
    "completion",
    JSON.stringify({ summary: "Stale summary for duplicate approval race test." }),
    staleTime
  );

  const threadTs = "1717003150.0001";
  const conversation = createSlackConversation({
    team_id: "T-APR-RACE",
    channel_id: "C-APR-RACE",
    user_id: "U-APR-RACE-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  let postMessageCount = 0;
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (input.includes("https://slack.com/api/conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D-APR-RACE" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const payload = rawBody ? JSON.parse(rawBody) : {};
    if (typeof payload.text === "string" && payload.text.includes("Debrief summary:")) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    postMessageCount += 1;
    return new Response(JSON.stringify({ ok: true, ts: `1717003150.${postMessageCount}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-APR-RACE",
      event: {
        type: "message",
        channel: "C-APR-RACE",
        channel_type: "channel",
        user: "U-APR-RACE-OP",
        text: "please remove production access, done",
        ts: "1717003150.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const pending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(pending);
  assert.equal(pending.status, "pending_approval");
  assert.equal(typeof pending.approval_message_ts, "string");

  const seededCommunication = createProjectCommunication({
    project_id: "project-control-center",
    intent: "request",
    summary: "Seed communication for duplicate approval race test",
    body: "seed",
    payload: "{}",
    from_scope: "user",
    to_scope: "global",
  });
  const expectedComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const approvalEvent = {
    type: "event_callback",
    team_id: "T-APR-RACE",
    event: {
      type: "reaction_added",
      user: "U-APR-RACE-APP",
      reaction: "white_check_mark",
      item: {
        type: "message",
        channel: "C-APR-RACE",
        ts: pending.approval_message_ts,
      },
    },
  };
  const firstApproval = handleSlackEventEnvelope(approvalEvent, { operatorV1Enabled: true });

  let approved = null;
  for (let index = 0; index < 50; index += 1) {
    const current = listSlackActionRequestsByConversation(conversation.id)[0];
    if (current?.status === "approved") {
      approved = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(approved);
  assert.equal(approved.status, "approved");

  const duplicateApproval = handleSlackEventEnvelope(approvalEvent, { operatorV1Enabled: true });

  const completedAt = new Date().toISOString();
  db.prepare(
    `UPDATE slack_action_requests
       SET status = 'completed',
           completed_at = @completed_at,
           communication_id = @communication_id,
           updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id: approved.id,
    completed_at: completedAt,
    communication_id: seededCommunication.id,
    updated_at: completedAt,
  });

  await Promise.all([firstApproval, duplicateApproval]);

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, expectedComms);

  const finalRequest = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(finalRequest);
  assert.equal(finalRequest.status, "completed");
  assert.equal(finalRequest.communication_id, seededCommunication.id);
});

test("v1 authorized approvers can deny high-risk requests via x reaction", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Deny Operator" });
  const approver = createPerson({ name: "Deny Approver" });
  const mappedOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-DENY:U-DENY-OP",
  });
  const mappedApprover = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-DENY:U-DENY-APP",
  });
  assert.ok(mappedOperator);
  assert.ok(mappedApprover);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;

  upsertSlackInstallation({
    team_id: "T-DENY",
    team_name: "Team Deny",
    bot_user_id: "B-DENY",
    bot_token: "xoxb-deny-token",
  });

  const threadTs = "1717003200.0001";
  const conversation = createSlackConversation({
    team_id: "T-DENY",
    channel_id: "C-DENY",
    user_id: "U-DENY-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    return new Response(JSON.stringify({ ok: true, ts: "1717003200.0009" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-DENY",
      event: {
        type: "message",
        channel: "C-DENY",
        channel_type: "channel",
        user: "U-DENY-OP",
        text: "please delete user data in prod, done",
        ts: "1717003200.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const pending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(pending);
  assert.equal(pending.status, "pending_approval");

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-DENY",
      event: {
        type: "reaction_added",
        user: "U-DENY-APP",
        reaction: "x",
        item: {
          type: "message",
          channel: "C-DENY",
          ts: pending.approval_message_ts,
        },
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms);

  const denied = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(denied);
  assert.equal(denied.status, "denied");
  assert.equal(denied.decision_reaction, "x");
});

test("v1 unauthorized approval reactions are ignored and logged without execution", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Unauthorized Reaction Operator" });
  const approver = createPerson({ name: "Authorized Approver" });
  const nonApprover = createPerson({ name: "Unauthorized Reactor" });
  const mappedOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-UNAUTH:U-UNAUTH-OP",
  });
  const mappedApprover = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-UNAUTH:U-UNAUTH-APP",
  });
  const mappedNonApprover = createPersonIdentifier({
    person_id: nonApprover.id,
    type: "other",
    value: "slack:T-UNAUTH:U-UNAUTH-NON",
  });
  assert.ok(mappedOperator);
  assert.ok(mappedApprover);
  assert.ok(mappedNonApprover);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;

  upsertSlackInstallation({
    team_id: "T-UNAUTH",
    team_name: "Team Unauthorized",
    bot_user_id: "B-UNAUTH",
    bot_token: "xoxb-unauth-token",
  });

  const threadTs = "1717003300.0001";
  const conversation = createSlackConversation({
    team_id: "T-UNAUTH",
    channel_id: "C-UNAUTH",
    user_id: "U-UNAUTH-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    return new Response(JSON.stringify({ ok: true, ts: "1717003300.0009" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-UNAUTH",
      event: {
        type: "message",
        channel: "C-UNAUTH",
        channel_type: "channel",
        user: "U-UNAUTH-OP",
        text: "please drop production database tables, done",
        ts: "1717003300.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const pending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(pending);
  assert.equal(pending.status, "pending_approval");

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-UNAUTH",
      event: {
        type: "reaction_added",
        user: "U-UNAUTH-NON",
        reaction: "white_check_mark",
        item: {
          type: "message",
          channel: "C-UNAUTH",
          ts: pending.approval_message_ts,
        },
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms);

  const stillPending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(stillPending);
  assert.equal(stillPending.status, "pending_approval");
});

test("v1 expired approval requests are marked expired and cannot execute", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Expired Operator" });
  const approver = createPerson({ name: "Expired Approver" });
  const mappedOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-EXP:U-EXP-OP",
  });
  const mappedApprover = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-EXP:U-EXP-APP",
  });
  assert.ok(mappedOperator);
  assert.ok(mappedApprover);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;
  process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES = "5";

  upsertSlackInstallation({
    team_id: "T-EXP",
    team_name: "Team Expired",
    bot_user_id: "B-EXP",
    bot_token: "xoxb-exp-token",
  });

  const threadTs = "1717003400.0001";
  const conversation = createSlackConversation({
    team_id: "T-EXP",
    channel_id: "C-EXP",
    user_id: "U-EXP-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    return new Response(JSON.stringify({ ok: true, ts: "1717003400.0009" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-EXP",
      event: {
        type: "message",
        channel: "C-EXP",
        channel_type: "channel",
        user: "U-EXP-OP",
        text: "please remove production access immediately, done",
        ts: "1717003400.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const pending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(pending);
  const db = getDb();
  const pastExpiry = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE slack_action_requests SET expires_at = ? WHERE id = ?").run(
    pastExpiry,
    pending.id
  );

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-EXP",
      event: {
        type: "reaction_added",
        user: "U-EXP-APP",
        reaction: "white_check_mark",
        item: {
          type: "message",
          channel: "C-EXP",
          ts: pending.approval_message_ts,
        },
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms);

  const expired = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(expired);
  assert.equal(expired.status, "expired");
  assert.match(expired.error ?? "", /expired/i);
});

test("v1 approvals that expire after approval but before execution are marked expired", async (t) => {
  resetGlobalExecutionState();
  process.env.CONTROL_CENTER_SLACK_STALE_DEBRIEF_MINUTES = "5";

  const operator = createPerson({ name: "Expiry Gap Operator" });
  const approver = createPerson({ name: "Expiry Gap Approver" });
  const mappedOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-EXP-GAP:U-EXP-GAP-OP",
  });
  const mappedApprover = createPersonIdentifier({
    person_id: approver.id,
    type: "other",
    value: "slack:T-EXP-GAP:U-EXP-GAP-APP",
  });
  assert.ok(mappedOperator);
  assert.ok(mappedApprover);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = approver.id;
  process.env.CONTROL_CENTER_SLACK_APPROVAL_TTL_MINUTES = "5";

  upsertSlackInstallation({
    team_id: "T-EXP-GAP",
    team_name: "Team Expiry Gap",
    bot_user_id: "B-EXP-GAP",
    bot_token: "xoxb-exp-gap-token",
  });

  const db = getDb();
  const staleSessionId = `session-exp-gap-${Date.now()}`;
  const staleTime = new Date(Date.now() - 20 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO global_agent_sessions
      (id, chat_thread_id, state, onboarding_rubric, integrations_configured, goals, priority_projects, constraints, briefing_summary, briefing_confirmed_at, autonomous_started_at, paused_at, iteration_count, decisions_count, actions_count, last_check_in_at, ended_at, created_at, updated_at)
     VALUES
      (@id, @chat_thread_id, @state, @onboarding_rubric, @integrations_configured, @goals, @priority_projects, @constraints, @briefing_summary, @briefing_confirmed_at, @autonomous_started_at, @paused_at, @iteration_count, @decisions_count, @actions_count, @last_check_in_at, @ended_at, @created_at, @updated_at)`
  ).run({
    id: staleSessionId,
    chat_thread_id: null,
    state: "debrief",
    onboarding_rubric: "[]",
    integrations_configured: "{}",
    goals: "[]",
    priority_projects: "[]",
    constraints: "{}",
    briefing_summary: null,
    briefing_confirmed_at: null,
    autonomous_started_at: null,
    paused_at: null,
    iteration_count: 2,
    decisions_count: 3,
    actions_count: 1,
    last_check_in_at: staleTime,
    ended_at: null,
    created_at: staleTime,
    updated_at: staleTime,
  });
  db.prepare(
    `INSERT INTO global_agent_session_events
      (id, session_id, type, payload, created_at)
     VALUES
      (?, ?, ?, ?, ?)`
  ).run(
    `evt-${staleSessionId}`,
    staleSessionId,
    "completion",
    JSON.stringify({ summary: "Stale summary for approval expiry window." }),
    staleTime
  );

  const threadTs = "1717003410.0001";
  const conversation = createSlackConversation({
    team_id: "T-EXP-GAP",
    channel_id: "C-EXP-GAP",
    user_id: "U-EXP-GAP-OP",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const beforeComms = listProjectCommunications({ projectId: "project-control-center" }).length;

  const originalFetch = globalThis.fetch;
  let postMessageCount = 0;
  let delayedRolloverNotices = 0;
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (input.includes("https://slack.com/api/conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D-EXP-GAP" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const payload = rawBody ? JSON.parse(rawBody) : {};
    if (
      typeof payload.text === "string" &&
      payload.text.includes("Debrief summary:")
    ) {
      delayedRolloverNotices += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    postMessageCount += 1;
    return new Response(JSON.stringify({ ok: true, ts: `1717003410.${postMessageCount}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-EXP-GAP",
      event: {
        type: "message",
        channel: "C-EXP-GAP",
        channel_type: "channel",
        user: "U-EXP-GAP-OP",
        text: "please remove production access immediately, done",
        ts: "1717003410.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const pending = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(pending);
  assert.equal(pending.status, "pending_approval");
  const nearFutureExpiry = new Date(Date.now() + 400).toISOString();
  db.prepare("UPDATE slack_action_requests SET expires_at = ? WHERE id = ?").run(
    nearFutureExpiry,
    pending.id
  );

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-EXP-GAP",
      event: {
        type: "reaction_added",
        user: "U-EXP-GAP-APP",
        reaction: "white_check_mark",
        item: {
          type: "message",
          channel: "C-EXP-GAP",
          ts: pending.approval_message_ts,
        },
      },
    },
    { operatorV1Enabled: true }
  );

  const afterComms = listProjectCommunications({ projectId: "project-control-center" }).length;
  assert.equal(afterComms, beforeComms);
  assert.ok(delayedRolloverNotices > 0);

  const expired = listSlackActionRequestsByConversation(conversation.id)[0];
  assert.ok(expired);
  assert.equal(expired.status, "expired");
  assert.match(expired.error ?? "", /expired/i);
  assert.equal(expired.communication_id, null);
});

test("v1 pcc commands run in DM context against global session APIs", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Command DM Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-CMD-DM:U-CMD-DM",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-CMD-DM",
    team_name: "Team Command DM",
    bot_user_id: "B-CMD-DM",
    bot_token: "xoxb-cmd-dm-token",
  });

  const sessionId = `session-cmd-dm-${Date.now()}`;
  seedGlobalSession(sessionId);

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(
      JSON.stringify({ ok: true, ts: `1717003500.${postMessages.length.toString().padStart(4, "0")}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-DM",
      event: {
        type: "message",
        channel: "D-CMD-DM",
        channel_type: "im",
        user: "U-CMD-DM",
        text: "pcc help",
        ts: "1717003500.0001",
      },
    },
    { operatorV1Enabled: true }
  );

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-DM",
      event: {
        type: "message",
        channel: "D-CMD-DM",
        channel_type: "im",
        user: "U-CMD-DM",
        text: "pcc status",
        ts: "1717003500.0002",
      },
    },
    { operatorV1Enabled: true }
  );

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-DM",
      event: {
        type: "message",
        channel: "D-CMD-DM",
        channel_type: "im",
        user: "U-CMD-DM",
        text: "pcc pause",
        ts: "1717003500.0003",
      },
    },
    { operatorV1Enabled: true }
  );

  const db = getDb();
  const paused = db
    .prepare("SELECT state, paused_at FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(sessionId);
  assert.equal(paused.state, "briefing");
  assert.equal(typeof paused.paused_at, "string");

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-DM",
      event: {
        type: "message",
        channel: "D-CMD-DM",
        channel_type: "im",
        user: "U-CMD-DM",
        text: "pcc resume",
        ts: "1717003500.0004",
      },
    },
    { operatorV1Enabled: true }
  );

  const resumed = db
    .prepare("SELECT state, paused_at FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(sessionId);
  assert.equal(resumed.state, "autonomous");
  assert.equal(resumed.paused_at, null);

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-DM",
      event: {
        type: "message",
        channel: "D-CMD-DM",
        channel_type: "im",
        user: "U-CMD-DM",
        text: "pcc end",
        ts: "1717003500.0005",
      },
    },
    { operatorV1Enabled: true }
  );

  const ended = db
    .prepare("SELECT state, ended_at FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(sessionId);
  assert.equal(ended.state, "ended");
  assert.equal(typeof ended.ended_at, "string");

  assert.equal(postMessages.length, 5);
  assert.match(postMessages[0].text, /^Done:/);
  assert.match(postMessages[0].text, /pcc help/i);
  assert.match(postMessages[1].text, /^Running:/);
  assert.match(postMessages[2].text, /^Done:/);
  assert.match(postMessages[2].text, /paused global session/i);
  assert.match(postMessages[3].text, /^Running:/);
  assert.match(postMessages[4].text, /^Done:/);
  assert.match(postMessages[4].text, /ended global session/i);
});

test("v1 pcc commands are recognized in mention-thread context", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Command Mention Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-CMD-MENTION:U-CMD-MENTION",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-CMD-MENTION",
    team_name: "Team Command Mention",
    bot_user_id: "B-CMD-MENTION",
    bot_token: "xoxb-cmd-mention-token",
  });

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717003510.0001" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-MENTION",
      event: {
        type: "app_mention",
        channel: "C-CMD-MENTION",
        user: "U-CMD-MENTION",
        text: "<@BCMDMENTION> pcc status",
        ts: "1717003510.0009",
      },
    },
    { operatorV1Enabled: true }
  );

  assert.equal(postMessages.length, 1);
  assert.equal(postMessages[0].channel, "C-CMD-MENTION");
  assert.equal(postMessages[0].thread_ts, "1717003510.0009");
  assert.match(postMessages[0].text, /^Blocked:/);
  assert.match(postMessages[0].text, /no active global session/i);
});

test("v1 unauthorized pcc commands return unblock guidance without mutating session state", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Command Allowed Operator" });
  const configuredOperator = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-CMD-DENY:U-CMD-ALLOW",
  });
  assert.ok(configuredOperator);
  const nonOperator = createPerson({ name: "Command Blocked User" });
  const mappedNonOperator = createPersonIdentifier({
    person_id: nonOperator.id,
    type: "other",
    value: "slack:T-CMD-DENY:U-CMD-DENY",
  });
  assert.ok(mappedNonOperator);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-CMD-DENY",
    team_name: "Team Command Deny",
    bot_user_id: "B-CMD-DENY",
    bot_token: "xoxb-cmd-deny-token",
  });

  const sessionId = `session-cmd-deny-${Date.now()}`;
  seedGlobalSession(sessionId);

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717003520.0001" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-DENY",
      event: {
        type: "message",
        channel: "D-CMD-DENY",
        channel_type: "im",
        user: "U-CMD-DENY",
        text: "pcc pause",
        ts: "1717003520.0002",
      },
    },
    { operatorV1Enabled: true }
  );

  assert.equal(postMessages.length, 1);
  assert.match(postMessages[0].text, /^Blocked:/);
  assert.match(postMessages[0].text, /not in SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS/i);

  const db = getDb();
  const session = db
    .prepare("SELECT state, paused_at FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(sessionId);
  assert.equal(session.state, "autonomous");
  assert.equal(session.paused_at, null);
});

test("v1 ambiguous pcc command syntax safely no-ops with clarification", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Command Ambiguous Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-CMD-AMB:U-CMD-AMB",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-CMD-AMB",
    team_name: "Team Command Ambiguous",
    bot_user_id: "B-CMD-AMB",
    bot_token: "xoxb-cmd-amb-token",
  });

  const sessionId = `session-cmd-amb-${Date.now()}`;
  seedGlobalSession(sessionId);

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717003530.0001" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-CMD-AMB",
      event: {
        type: "app_mention",
        channel: "C-CMD-AMB",
        user: "U-CMD-AMB",
        text: "<@BCMDAMB> pcc status please",
        ts: "1717003530.0002",
      },
    },
    { operatorV1Enabled: true }
  );

  assert.equal(postMessages.length, 1);
  assert.match(postMessages[0].text, /^Blocked:/);
  assert.match(postMessages[0].text, /couldn't parse that command/i);

  const db = getDb();
  const session = db
    .prepare("SELECT state FROM global_agent_sessions WHERE id = ? LIMIT 1")
    .get(sessionId);
  assert.equal(session.state, "autonomous");
});

test("v1 actionable requests emit accepted/running/blocked/done milestone trail in thread", async (t) => {
  resetGlobalExecutionState();
  const operator = createPerson({ name: "Milestone Operator" });
  const mapped = createPersonIdentifier({
    person_id: operator.id,
    type: "other",
    value: "slack:T-MILE:U-MILE",
  });
  assert.ok(mapped);
  process.env.CONTROL_CENTER_SLACK_OPERATOR_PERSON_IDS = operator.id;
  process.env.CONTROL_CENTER_SLACK_APPROVER_PERSON_IDS = "";
  upsertSlackInstallation({
    team_id: "T-MILE",
    team_name: "Team Milestone",
    bot_user_id: "B-MILE",
    bot_token: "xoxb-mile-token",
  });

  const threadTs = "1717010000.0001";
  const conversation = createSlackConversation({
    team_id: "T-MILE",
    channel_id: "C-MILE",
    user_id: "U-MILE",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(
      JSON.stringify({ ok: true, ts: `1717010000.${postMessages.length.toString().padStart(4, "0")}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleSlackEventEnvelope(
    {
      type: "event_callback",
      team_id: "T-MILE",
      event: {
        type: "message",
        channel: "C-MILE",
        channel_type: "channel",
        user: "U-MILE",
        text: "please process this request, done",
        ts: "1717010000.0002",
        thread_ts: threadTs,
      },
    },
    { operatorV1Enabled: true }
  );

  const updatedConversation = getSlackConversationById(conversation.id);
  assert.ok(updatedConversation);
  assert.equal(updatedConversation.status, "processed");
  assert.equal(typeof updatedConversation.global_session_id, "string");

  await notifySlackMilestoneForSessionEvent({
    id: "evt-mile-running",
    session_id: updatedConversation.global_session_id,
    type: "check_in",
    payload: { message: "Investigating and executing queued actions." },
    created_at: new Date().toISOString(),
  });
  await notifySlackMilestoneForSessionEvent({
    id: "evt-mile-guidance",
    session_id: updatedConversation.global_session_id,
    type: "guidance",
    payload: { message: "Need clarification on deployment environment." },
    created_at: new Date().toISOString(),
  });
  await notifySlackMilestoneForSessionEvent({
    id: "evt-mile-alert",
    session_id: updatedConversation.global_session_id,
    type: "alert",
    payload: { reason: "A blocking dependency failed." },
    created_at: new Date().toISOString(),
  });
  await notifySlackMilestoneForSessionEvent({
    id: "evt-mile-done",
    session_id: updatedConversation.global_session_id,
    type: "completion",
    payload: { summary: "Execution finished and debrief is ready." },
    created_at: new Date().toISOString(),
  });

  const milestoneTexts = postMessages
    .filter(
      (message) =>
        message.channel === "C-MILE" &&
        message.thread_ts === threadTs &&
        typeof message.text === "string" &&
        /^(Accepted|Running|Blocked|Done):/.test(message.text)
    )
    .map((message) => message.text);
  assert.equal(milestoneTexts.length, 5);
  assert.match(milestoneTexts[0], /^Accepted:/);
  assert.match(milestoneTexts[1], /^Running:/);
  assert.match(milestoneTexts[2], /^Blocked:/);
  assert.match(milestoneTexts[3], /^Blocked:/);
  assert.match(milestoneTexts[4], /^Done:/);
});

test("session milestone updates fall back to DM with explicit notice when thread context is missing", async (t) => {
  upsertSlackInstallation({
    team_id: "T-MILE-DM",
    team_name: "Team Milestone DM",
    bot_user_id: "B-MILE-DM",
    bot_token: "xoxb-mile-dm-token",
  });

  const conversation = createSlackConversation({
    team_id: "T-MILE-DM",
    channel_id: "C-MILE-DM",
    user_id: "U-MILE-DM",
    thread_ts: null,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const sessionId = `session-mile-dm-${Date.now()}`;
  seedGlobalSession(sessionId);
  updateSlackConversation({
    id: conversation.id,
    status: "processed",
    global_session_id: sessionId,
  });

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (input.includes("https://slack.com/api/conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D-MILE-DM" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(JSON.stringify({ ok: true, ts: "1717010001.0001" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await notifySlackMilestoneForSessionEvent({
    id: "evt-mile-dm-running",
    session_id: sessionId,
    type: "check_in",
    payload: { message: "Still running." },
    created_at: new Date().toISOString(),
  });

  assert.equal(postMessages.length, 1);
  assert.equal(postMessages[0].channel, "D-MILE-DM");
  assert.equal(postMessages[0].thread_ts, undefined);
  assert.equal(typeof postMessages[0].text, "string");
  assert.match(postMessages[0].text, /Thread context unavailable/i);
  assert.match(postMessages[0].text, /Running:/);
});

test("replayed session events do not duplicate milestone posts", async (t) => {
  upsertSlackInstallation({
    team_id: "T-MILE-DEDUPE",
    team_name: "Team Milestone Dedupe",
    bot_user_id: "B-MILE-DEDUPE",
    bot_token: "xoxb-mile-dedupe-token",
  });

  const threadTs = "1717010002.0001";
  const conversation = createSlackConversation({
    team_id: "T-MILE-DEDUPE",
    channel_id: "C-MILE-DEDUPE",
    user_id: "U-MILE-DEDUPE",
    thread_ts: threadTs,
    project_id: "project-control-center",
    started_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  });
  const sessionId = `session-mile-dedupe-${Date.now()}`;
  seedGlobalSession(sessionId);
  updateSlackConversation({
    id: conversation.id,
    status: "processed",
    global_session_id: sessionId,
  });

  const originalFetch = globalThis.fetch;
  const postMessages = [];
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string") throw new Error("expected Slack API URL string");
    if (!input.includes("https://slack.com/api/chat.postMessage")) {
      throw new Error(`unexpected Slack API method: ${input}`);
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    postMessages.push(JSON.parse(rawBody));
    return new Response(
      JSON.stringify({ ok: true, ts: `1717010002.${postMessages.length.toString().padStart(4, "0")}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const replayEvent = {
    id: "evt-mile-dedupe-running",
    session_id: sessionId,
    type: "check_in",
    payload: { message: "Executing replay-safe milestone update." },
    created_at: new Date().toISOString(),
  };

  await notifySlackMilestoneForSessionEvent(replayEvent);
  await notifySlackMilestoneForSessionEvent(replayEvent);

  const runningMilestones = postMessages.filter(
    (message) =>
      message.channel === "C-MILE-DEDUPE" &&
      message.thread_ts === threadTs &&
      typeof message.text === "string" &&
      message.text.startsWith("Running:")
  );
  assert.equal(runningMilestones.length, 1);
});
