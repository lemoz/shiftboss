import crypto from "crypto";
import { getDb } from "./db.js";

export type SlackConversationStatus = "active" | "ended" | "processed";

export type SlackInstallationRow = {
  id: string;
  team_id: string;
  team_name: string | null;
  bot_user_id: string | null;
  bot_token: string;
  scope: string | null;
  created_at: string;
  updated_at: string;
};

export type SlackOAuthStateRow = {
  state: string;
  created_at: string;
  expires_at: string;
};

export type SlackConversationRow = {
  id: string;
  slack_team_id: string;
  slack_channel_id: string;
  slack_user_id: string;
  slack_thread_ts: string | null;
  status: SlackConversationStatus;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  processed_at: string | null;
  global_shift_id: string | null;
  global_session_id: string | null;
  last_message_at: string;
};

export type SlackConversationMessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  slack_ts: string | null;
  message_key: string | null;
  created_at: string;
};

export type SlackActionRequestStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "expired"
  | "executing"
  | "completed";

export type SlackActionRequestRow = {
  id: string;
  conversation_id: string;
  project_id: string | null;
  slack_team_id: string;
  slack_channel_id: string;
  slack_thread_ts: string | null;
  request_summary: string;
  request_body: string;
  intent: "request" | "message";
  communication_payload: string;
  correlation_id: string;
  risk_level: "low" | "high";
  status: SlackActionRequestStatus;
  requested_by_slack_user_id: string;
  requested_by_person_id: string | null;
  approval_message_ts: string | null;
  decision_reaction: string | null;
  decided_by_slack_user_id: string | null;
  decided_by_person_id: string | null;
  decision_at: string | null;
  expires_at: string | null;
  executing_at: string | null;
  completed_at: string | null;
  communication_id: string | null;
  global_session_id: string | null;
  global_shift_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

const SLACK_OAUTH_STATE_TTL_MINUTES = 10;

export function createSlackOAuthState(): string {
  const db = getDb();
  const state = crypto.randomBytes(16).toString("hex");
  const now = nowIso();
  const expiresAt = new Date(
    Date.now() + SLACK_OAUTH_STATE_TTL_MINUTES * 60_000
  ).toISOString();
  db.prepare("DELETE FROM slack_oauth_states WHERE expires_at < ?").run(now);
  db.prepare(
    "INSERT INTO slack_oauth_states (state, created_at, expires_at) VALUES (?, ?, ?)"
  ).run(state, now, expiresAt);
  return state;
}

export function consumeSlackOAuthState(
  state: string
): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM slack_oauth_states WHERE state = ? LIMIT 1")
    .get(state) as SlackOAuthStateRow | undefined;
  if (!row) return { ok: false, error: "invalid Slack OAuth state" };
  db.prepare("DELETE FROM slack_oauth_states WHERE state = ?").run(state);
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || Date.now() > expiresMs) {
    return { ok: false, error: "Slack OAuth state expired" };
  }
  return { ok: true };
}

export function upsertSlackInstallation(input: {
  team_id: string;
  team_name?: string | null;
  bot_user_id?: string | null;
  bot_token: string;
  scope?: string | null;
}): SlackInstallationRow {
  const db = getDb();
  const now = nowIso();
  const existing = db
    .prepare("SELECT * FROM slack_installations WHERE team_id = ? LIMIT 1")
    .get(input.team_id) as SlackInstallationRow | undefined;

  if (existing) {
    const updated: SlackInstallationRow = {
      ...existing,
      team_name: input.team_name ?? existing.team_name,
      bot_user_id: input.bot_user_id ?? existing.bot_user_id,
      bot_token: input.bot_token,
      scope: input.scope ?? existing.scope,
      updated_at: now,
    };
    db.prepare(
      `UPDATE slack_installations
       SET team_name = @team_name,
           bot_user_id = @bot_user_id,
           bot_token = @bot_token,
           scope = @scope,
           updated_at = @updated_at
       WHERE team_id = @team_id`
    ).run(updated);
    return updated;
  }

  const row: SlackInstallationRow = {
    id: crypto.randomUUID(),
    team_id: input.team_id,
    team_name: input.team_name ?? null,
    bot_user_id: input.bot_user_id ?? null,
    bot_token: input.bot_token,
    scope: input.scope ?? null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO slack_installations
      (id, team_id, team_name, bot_user_id, bot_token, scope, created_at, updated_at)
     VALUES
      (@id, @team_id, @team_name, @bot_user_id, @bot_token, @scope, @created_at, @updated_at)`
  ).run(row);
  return row;
}

export function getSlackInstallationByTeam(teamId: string): SlackInstallationRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM slack_installations WHERE team_id = ? LIMIT 1")
    .get(teamId) as SlackInstallationRow | undefined;
  return row ?? null;
}

export function listSlackInstallations(): SlackInstallationRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM slack_installations ORDER BY updated_at DESC")
    .all() as SlackInstallationRow[];
}

export function createSlackConversation(params: {
  team_id: string;
  channel_id: string;
  user_id: string;
  thread_ts?: string | null;
  project_id?: string | null;
  started_at?: string;
  last_message_at?: string;
}): SlackConversationRow {
  const db = getDb();
  const startedAt = params.started_at ?? nowIso();
  const lastMessageAt = params.last_message_at ?? startedAt;
  const row: SlackConversationRow = {
    id: crypto.randomUUID(),
    slack_team_id: params.team_id,
    slack_channel_id: params.channel_id,
    slack_user_id: params.user_id,
    slack_thread_ts: params.thread_ts ?? null,
    status: "active",
    project_id: params.project_id ?? null,
    started_at: startedAt,
    ended_at: null,
    processed_at: null,
    global_shift_id: null,
    global_session_id: null,
    last_message_at: lastMessageAt,
  };
  db.prepare(
    `INSERT INTO slack_conversations
      (id, slack_team_id, slack_channel_id, slack_user_id, slack_thread_ts, status, project_id, started_at, ended_at, processed_at, global_shift_id, global_session_id, last_message_at)
     VALUES
      (@id, @slack_team_id, @slack_channel_id, @slack_user_id, @slack_thread_ts, @status, @project_id, @started_at, @ended_at, @processed_at, @global_shift_id, @global_session_id, @last_message_at)`
  ).run(row);
  return row;
}

export function getSlackConversationById(conversationId: string): SlackConversationRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM slack_conversations WHERE id = ? LIMIT 1")
    .get(conversationId) as SlackConversationRow | undefined;
  return row ?? null;
}

export function listSlackConversationsByGlobalSessionId(
  sessionId: string
): SlackConversationRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT *
       FROM slack_conversations
       WHERE global_session_id = ?
       ORDER BY started_at ASC`
    )
    .all(sessionId) as SlackConversationRow[];
}

export function findActiveSlackConversation(params: {
  team_id: string;
  channel_id: string;
  user_id: string;
  thread_ts?: string | null;
}): SlackConversationRow | null {
  const db = getDb();
  const threadTs = params.thread_ts ?? null;
  const row = db
    .prepare(
      `SELECT *
       FROM slack_conversations
       WHERE slack_team_id = ?
         AND slack_channel_id = ?
         AND slack_user_id = ?
         AND status = 'active'
         AND ((slack_thread_ts IS NULL AND ? IS NULL) OR slack_thread_ts = ?)
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(params.team_id, params.channel_id, params.user_id, threadTs, threadTs) as
    | SlackConversationRow
    | undefined;
  return row ?? null;
}

export function hasSlackConversationMessageForEvent(params: {
  team_id: string;
  channel_id: string;
  user_id: string;
  thread_ts?: string | null;
  slack_ts: string;
}): boolean {
  const db = getDb();
  const threadTs = params.thread_ts ?? null;
  const row = db
    .prepare(
      `SELECT 1
       FROM slack_conversation_messages AS messages
       JOIN slack_conversations AS conversations
         ON conversations.id = messages.conversation_id
       WHERE conversations.slack_team_id = ?
         AND conversations.slack_channel_id = ?
         AND conversations.slack_user_id = ?
         AND ((conversations.slack_thread_ts IS NULL AND ? IS NULL) OR conversations.slack_thread_ts = ?)
         AND messages.slack_ts = ?
       LIMIT 1`
    )
    .get(
      params.team_id,
      params.channel_id,
      params.user_id,
      threadTs,
      threadTs,
      params.slack_ts
    ) as { "1"?: number } | undefined;
  return Boolean(row);
}

export function updateSlackConversation(params: {
  id: string;
  status?: SlackConversationStatus;
  slack_thread_ts?: string | null;
  project_id?: string | null;
  ended_at?: string | null;
  processed_at?: string | null;
  global_shift_id?: string | null;
  global_session_id?: string | null;
  last_message_at?: string;
}): SlackConversationRow | null {
  const db = getDb();
  const sets: string[] = [];
  const payload: Record<string, unknown> = { id: params.id };

  if (params.status) {
    sets.push("status = @status");
    payload.status = params.status;
  }
  if (params.slack_thread_ts !== undefined) {
    sets.push("slack_thread_ts = @slack_thread_ts");
    payload.slack_thread_ts = params.slack_thread_ts;
  }
  if (params.project_id !== undefined) {
    sets.push("project_id = @project_id");
    payload.project_id = params.project_id;
  }
  if (params.ended_at !== undefined) {
    sets.push("ended_at = @ended_at");
    payload.ended_at = params.ended_at;
  }
  if (params.processed_at !== undefined) {
    sets.push("processed_at = @processed_at");
    payload.processed_at = params.processed_at;
  }
  if (params.global_shift_id !== undefined) {
    sets.push("global_shift_id = @global_shift_id");
    payload.global_shift_id = params.global_shift_id;
  }
  if (params.global_session_id !== undefined) {
    sets.push("global_session_id = @global_session_id");
    payload.global_session_id = params.global_session_id;
  }
  if (params.last_message_at) {
    sets.push("last_message_at = @last_message_at");
    payload.last_message_at = params.last_message_at;
  }

  if (!sets.length) return getSlackConversationById(params.id);

  db.prepare(`UPDATE slack_conversations SET ${sets.join(", ")} WHERE id = @id`).run(
    payload
  );
  return getSlackConversationById(params.id);
}

export function recordSlackConversationMessage(params: {
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  slack_ts?: string | null;
  message_key?: string | null;
  created_at?: string;
}): SlackConversationMessageRow {
  const db = getDb();
  const createdAt = params.created_at ?? nowIso();
  const slackTs = params.slack_ts ?? null;
  const messageKey = params.message_key ?? null;

  const tx = db.transaction(() => {
    if (messageKey) {
      const existingByKey = db
        .prepare(
          "SELECT * FROM slack_conversation_messages WHERE conversation_id = ? AND message_key = ? LIMIT 1"
        )
        .get(params.conversation_id, messageKey) as SlackConversationMessageRow | undefined;
      if (existingByKey) return existingByKey;
    }
    if (slackTs) {
      const existing = db
        .prepare(
          "SELECT * FROM slack_conversation_messages WHERE conversation_id = ? AND slack_ts = ? LIMIT 1"
        )
        .get(params.conversation_id, slackTs) as SlackConversationMessageRow | undefined;
      if (existing) return existing;
    }
    const row: SlackConversationMessageRow = {
      id: crypto.randomUUID(),
      conversation_id: params.conversation_id,
      role: params.role,
      content: params.content,
      slack_ts: slackTs,
      message_key: messageKey,
      created_at: createdAt,
    };
    db.prepare(
      `INSERT INTO slack_conversation_messages
        (id, conversation_id, role, content, slack_ts, message_key, created_at)
       VALUES
        (@id, @conversation_id, @role, @content, @slack_ts, @message_key, @created_at)`
    ).run(row);
    db.prepare(
      "UPDATE slack_conversations SET last_message_at = ? WHERE id = ?"
    ).run(createdAt, params.conversation_id);
    return row;
  });

  return tx();
}

export function listSlackConversationMessages(
  conversationId: string
): SlackConversationMessageRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT *
       FROM slack_conversation_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conversationId) as SlackConversationMessageRow[];
}

export function getSlackConversationMessageByKey(params: {
  conversation_id: string;
  message_key: string;
}): SlackConversationMessageRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT *
       FROM slack_conversation_messages
       WHERE conversation_id = ?
         AND message_key = ?
       LIMIT 1`
    )
    .get(params.conversation_id, params.message_key) as SlackConversationMessageRow | undefined;
  return row ?? null;
}

export function createSlackActionRequest(params: {
  conversation_id: string;
  project_id?: string | null;
  slack_team_id: string;
  slack_channel_id: string;
  slack_thread_ts?: string | null;
  request_summary: string;
  request_body: string;
  intent: "request" | "message";
  communication_payload: string;
  correlation_id: string;
  risk_level: "low" | "high";
  status: SlackActionRequestStatus;
  requested_by_slack_user_id: string;
  requested_by_person_id?: string | null;
  expires_at?: string | null;
  error?: string | null;
}): SlackActionRequestRow {
  const db = getDb();
  const now = nowIso();
  const row: SlackActionRequestRow = {
    id: crypto.randomUUID(),
    conversation_id: params.conversation_id,
    project_id: params.project_id ?? null,
    slack_team_id: params.slack_team_id,
    slack_channel_id: params.slack_channel_id,
    slack_thread_ts: params.slack_thread_ts ?? null,
    request_summary: params.request_summary,
    request_body: params.request_body,
    intent: params.intent,
    communication_payload: params.communication_payload,
    correlation_id: params.correlation_id,
    risk_level: params.risk_level,
    status: params.status,
    requested_by_slack_user_id: params.requested_by_slack_user_id,
    requested_by_person_id: params.requested_by_person_id ?? null,
    approval_message_ts: null,
    decision_reaction: null,
    decided_by_slack_user_id: null,
    decided_by_person_id: null,
    decision_at: null,
    expires_at: params.expires_at ?? null,
    executing_at: null,
    completed_at: null,
    communication_id: null,
    global_session_id: null,
    global_shift_id: null,
    error: params.error ?? null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO slack_action_requests
      (id, conversation_id, project_id, slack_team_id, slack_channel_id, slack_thread_ts, request_summary, request_body, intent, communication_payload, correlation_id, risk_level, status, requested_by_slack_user_id, requested_by_person_id, approval_message_ts, decision_reaction, decided_by_slack_user_id, decided_by_person_id, decision_at, expires_at, executing_at, completed_at, communication_id, global_session_id, global_shift_id, error, created_at, updated_at)
     VALUES
      (@id, @conversation_id, @project_id, @slack_team_id, @slack_channel_id, @slack_thread_ts, @request_summary, @request_body, @intent, @communication_payload, @correlation_id, @risk_level, @status, @requested_by_slack_user_id, @requested_by_person_id, @approval_message_ts, @decision_reaction, @decided_by_slack_user_id, @decided_by_person_id, @decision_at, @expires_at, @executing_at, @completed_at, @communication_id, @global_session_id, @global_shift_id, @error, @created_at, @updated_at)`
  ).run(row);
  return row;
}

export function getSlackActionRequestById(actionRequestId: string): SlackActionRequestRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM slack_action_requests WHERE id = ? LIMIT 1")
    .get(actionRequestId) as SlackActionRequestRow | undefined;
  return row ?? null;
}

export function listSlackActionRequestsByConversation(
  conversationId: string
): SlackActionRequestRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT *
       FROM slack_action_requests
       WHERE conversation_id = ?
       ORDER BY created_at DESC`
    )
    .all(conversationId) as SlackActionRequestRow[];
}

export function listSlackActionRequestsByApprovalMessage(params: {
  team_id: string;
  channel_id: string;
  approval_message_ts: string;
}): SlackActionRequestRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT *
       FROM slack_action_requests
       WHERE slack_team_id = ?
         AND slack_channel_id = ?
         AND approval_message_ts = ?
       ORDER BY created_at DESC`
    )
    .all(params.team_id, params.channel_id, params.approval_message_ts) as SlackActionRequestRow[];
}

export function updateSlackActionRequest(params: {
  id: string;
  status?: SlackActionRequestStatus;
  approval_message_ts?: string | null;
  decision_reaction?: string | null;
  decided_by_slack_user_id?: string | null;
  decided_by_person_id?: string | null;
  decision_at?: string | null;
  expires_at?: string | null;
  executing_at?: string | null;
  completed_at?: string | null;
  communication_id?: string | null;
  global_session_id?: string | null;
  global_shift_id?: string | null;
  error?: string | null;
  expected_current_status?: SlackActionRequestStatus | SlackActionRequestStatus[];
}): SlackActionRequestRow | null {
  const db = getDb();
  const sets: string[] = [];
  const payload: Record<string, unknown> = { id: params.id };
  const expectedCurrentStatuses = Array.isArray(params.expected_current_status)
    ? params.expected_current_status
    : params.expected_current_status
      ? [params.expected_current_status]
      : [];

  if (params.status) {
    sets.push("status = @status");
    payload.status = params.status;
  }
  if (params.approval_message_ts !== undefined) {
    sets.push("approval_message_ts = @approval_message_ts");
    payload.approval_message_ts = params.approval_message_ts;
  }
  if (params.decision_reaction !== undefined) {
    sets.push("decision_reaction = @decision_reaction");
    payload.decision_reaction = params.decision_reaction;
  }
  if (params.decided_by_slack_user_id !== undefined) {
    sets.push("decided_by_slack_user_id = @decided_by_slack_user_id");
    payload.decided_by_slack_user_id = params.decided_by_slack_user_id;
  }
  if (params.decided_by_person_id !== undefined) {
    sets.push("decided_by_person_id = @decided_by_person_id");
    payload.decided_by_person_id = params.decided_by_person_id;
  }
  if (params.decision_at !== undefined) {
    sets.push("decision_at = @decision_at");
    payload.decision_at = params.decision_at;
  }
  if (params.expires_at !== undefined) {
    sets.push("expires_at = @expires_at");
    payload.expires_at = params.expires_at;
  }
  if (params.executing_at !== undefined) {
    sets.push("executing_at = @executing_at");
    payload.executing_at = params.executing_at;
  }
  if (params.completed_at !== undefined) {
    sets.push("completed_at = @completed_at");
    payload.completed_at = params.completed_at;
  }
  if (params.communication_id !== undefined) {
    sets.push("communication_id = @communication_id");
    payload.communication_id = params.communication_id;
  }
  if (params.global_session_id !== undefined) {
    sets.push("global_session_id = @global_session_id");
    payload.global_session_id = params.global_session_id;
  }
  if (params.global_shift_id !== undefined) {
    sets.push("global_shift_id = @global_shift_id");
    payload.global_shift_id = params.global_shift_id;
  }
  if (params.error !== undefined) {
    sets.push("error = @error");
    payload.error = params.error;
  }

  if (!sets.length) return getSlackActionRequestById(params.id);

  sets.push("updated_at = @updated_at");
  payload.updated_at = nowIso();

  const whereClauses = ["id = @id"];
  if (expectedCurrentStatuses.length === 1) {
    payload.expected_current_status_0 = expectedCurrentStatuses[0];
    whereClauses.push("status = @expected_current_status_0");
  } else if (expectedCurrentStatuses.length > 1) {
    const placeholders = expectedCurrentStatuses.map((status, index) => {
      const key = `expected_current_status_${index}`;
      payload[key] = status;
      return `@${key}`;
    });
    whereClauses.push(`status IN (${placeholders.join(", ")})`);
  }

  const result = db
    .prepare(
      `UPDATE slack_action_requests
       SET ${sets.join(", ")}
       WHERE ${whereClauses.join(" AND ")}`
    )
    .run(payload);
  if (!result.changes) return null;
  return getSlackActionRequestById(params.id);
}

export function transitionApprovedSlackActionRequestToExecution(params: {
  id: string;
  executing_at: string;
  expiry_reference_time?: string;
}): SlackActionRequestRow | null {
  const db = getDb();
  const payload = {
    id: params.id,
    executing_at: params.executing_at,
    expiry_reference_time: params.expiry_reference_time ?? params.executing_at,
    expired_error: "approval expired before execution",
    updated_at: nowIso(),
  };
  const result = db
    .prepare(
      `UPDATE slack_action_requests
       SET status = CASE
             WHEN expires_at IS NULL
               OR (julianday(expires_at) IS NOT NULL AND expires_at > @expiry_reference_time)
               THEN 'executing'
             ELSE 'expired'
           END,
           executing_at = CASE
             WHEN expires_at IS NULL
               OR (julianday(expires_at) IS NOT NULL AND expires_at > @expiry_reference_time)
               THEN @executing_at
             ELSE executing_at
           END,
           error = CASE
             WHEN expires_at IS NULL
               OR (julianday(expires_at) IS NOT NULL AND expires_at > @expiry_reference_time)
               THEN NULL
             ELSE @expired_error
           END,
           updated_at = @updated_at
       WHERE id = @id
         AND status = 'approved'`
    )
    .run(payload);
  if (!result.changes) return null;
  return getSlackActionRequestById(params.id);
}

export function listStaleSlackConversations(timeoutMinutes: number): SlackConversationRow[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString();
  return db
    .prepare(
      `SELECT *
       FROM slack_conversations
       WHERE status = 'active' AND last_message_at < ?
       ORDER BY last_message_at ASC`
    )
    .all(cutoff) as SlackConversationRow[];
}
