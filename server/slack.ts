import crypto from "crypto";
import {
  createProjectCommunication,
  findProjectByPath,
  getDb,
  getPersonDetails,
  listProjects,
  resolvePersonByIdentifier,
  startGlobalShift,
  type ProjectRow,
} from "./db.js";
import {
  getGlobalAgentId,
  getGlobalAgentType,
  getSlackApprovalTtlMinutes,
  getSlackApproverPersonIds,
  getSlackClientId,
  getSlackClientSecret,
  getSlackConversationTimeoutMinutes,
  getSlackOperatorPersonIds,
  getSlackRedirectUri,
  getSlackScopes,
  getSlackSigningSecret,
  getSlackStaleDebriefMinutes,
} from "./config.js";
import {
  completeGlobalAgentOnboarding,
  createGlobalAgentSession,
  endGlobalAgentSession,
  getGlobalAgentSessionById,
  listGlobalAgentSessionEvents,
  pauseGlobalAgentSession,
  registerGlobalAgentSessionEventListener,
  startGlobalAgentSessionAutonomous,
  stopGlobalAgentSession,
  updateGlobalAgentSessionDetails,
  type GlobalAgentSessionEvent,
  type GlobalAgentSession,
} from "./global_agent_sessions.js";
import {
  buildNormalizedSlackPersonIdentifier,
  parseSlackPersonIdentifier,
} from "./slack_identity.js";
import {
  createSlackActionRequest,
  createSlackConversation,
  createSlackOAuthState,
  consumeSlackOAuthState,
  findActiveSlackConversation,
  getSlackActionRequestById,
  getSlackConversationById,
  getSlackConversationMessageByKey,
  hasSlackConversationMessageForEvent,
  getSlackInstallationByTeam,
  listSlackActionRequestsByApprovalMessage,
  listSlackConversationsByGlobalSessionId,
  listSlackConversationMessages,
  listSlackInstallations,
  listStaleSlackConversations,
  recordSlackConversationMessage,
  transitionApprovedSlackActionRequestToExecution,
  updateSlackActionRequest,
  updateSlackConversation,
  upsertSlackInstallation,
  type SlackActionRequestRow,
  type SlackActionRequestStatus,
  type SlackConversationMessageRow,
  type SlackConversationRow,
  type SlackInstallationRow,
} from "./slack_db.js";

type SlackEnvelope = {
  type: string;
  challenge?: string;
  team_id?: string;
  event?: Record<string, unknown>;
};

type SlackEvent = {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
  reaction?: string;
  item?: Record<string, unknown>;
  event_ts?: string;
  bot_id?: string;
  bot_profile?: Record<string, unknown>;
  subtype?: string;
};

type SlackApiResponse = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

type SlackMessageSendResult = {
  ok: boolean;
  error?: string;
  slack_ts?: string;
  conversation?: SlackConversationRow;
  message?: SlackConversationMessageRow;
};

type SlackEventResult = {
  status: number;
  body: Record<string, unknown>;
};

type HandleSlackEventEnvelopeOptions = {
  operatorV1Enabled?: boolean;
};

type SlackSignatureVerification = {
  ok: boolean;
  error?: string;
};

type SlackActionabilityOutcome =
  | {
      allowed: true;
      actorPersonId: string;
    }
  | {
      allowed: false;
      reason: "unmapped" | "non_operator";
      actorPersonId: string | null;
      approverMentions: string[];
    };

type ActiveGlobalSessionSnapshotRow = {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
};

type ActiveGlobalSessionInspection =
  | { ok: true; session: GlobalAgentSession }
  | { ok: false; reason: "none" | "ambiguous" | "corrupt"; details: Record<string, unknown> };

type SlackOperatorBridgeLogContext = {
  correlation_id: string;
  conversation_id: string;
  communication_id: string | null;
  global_session_id: string | null;
  project_id: string | null;
  [key: string]: unknown;
};

type SlackSessionExecutionOutcome =
  | {
      ok: true;
      sessionId: string;
      mode: "started" | "resumed" | "already_autonomous";
    }
  | {
      ok: false;
      error: string;
      sessionId: string | null;
    };

type SlackApproverAuthorizationOutcome =
  | {
      allowed: true;
      actorPersonId: string;
    }
  | {
      allowed: false;
      reason: "unmapped" | "non_approver";
      actorPersonId: string | null;
    };

type SlackActionExecutionOutcome =
  | {
      ok: true;
      communicationId: string;
      sessionId: string;
      shiftId: string;
      sessionMode: "started" | "resumed" | "already_autonomous";
      shiftReused: boolean;
    }
  | {
      ok: false;
      error: string;
      communicationId: string | null;
      sessionId: string | null;
    };

type SlackMilestoneState = "accepted" | "running" | "blocked" | "done";
type SlackOperatorCommand = "help" | "status" | "pause" | "resume" | "end";
type ParsedSlackOperatorCommand =
  | { type: "none" }
  | { type: "ambiguous" }
  | { type: "command"; command: SlackOperatorCommand };

const GLOBAL_AGENT_SESSION_STATES = new Set([
  "onboarding",
  "briefing",
  "autonomous",
  "debrief",
  "ended",
]);

const SLACK_APPROVE_REACTION = "white_check_mark";
const SLACK_DENY_REACTION = "x";
const HIGH_RISK_REQUEST_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\b(delete|remove|destroy|drop|wipe|purge)\b/i,
  /\b(restart|shutdown|terminate|kill)\b/i,
  /\b(production|prod)\b/i,
  /\b(secret|token|password|credential)\b/i,
  /\b(grant|revoke)\s+access\b/i,
  /\b(database|schema|migration)\b/i,
];

const END_COMMANDS = ["/end", "end conversation", "end convo", "close conversation"];
const END_PHRASES = [
  "done",
  "thanks",
  "thank you",
  "thx",
  "that's all",
  "thats all",
  "all good",
  "nothing else",
  "no more",
];
const SLACK_OPERATOR_COMMANDS: SlackOperatorCommand[] = [
  "help",
  "status",
  "pause",
  "resume",
  "end",
];

const SLACK_DM_FALLBACK_NOTICE =
  "Thread context unavailable for this request. Sending milestone updates in DM.";

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripSlackMentions(value: string): string {
  return value.replace(/<@[A-Z0-9]+>/gi, "").replace(/\s+/g, " ").trim();
}

function slackTsToIso(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed * 1000).toISOString();
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function buildConversationSummary(messages: SlackConversationMessageRow[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const content = message.content.trim();
    if (!content) continue;
    return content.length > 140 ? `${content.slice(0, 137)}...` : content;
  }
  return "Slack conversation";
}

function formatConversationBody(messages: SlackConversationMessageRow[]): string {
  return messages
    .map((message) => {
      const label =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "system"
            ? "System"
            : "User";
      return `${label}: ${message.content}`;
    })
    .join("\n");
}

function resolveDefaultProjectId(): string | null {
  const byPath = findProjectByPath(process.cwd());
  if (byPath) return byPath.id;
  const projects = listProjects();
  return projects.length ? projects[0].id : null;
}

function detectProjectIdFromText(text: string): string | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const projects = listProjects();
  for (const project of projects) {
    const tokens = buildProjectTokens(project);
    for (const token of tokens) {
      if (!token) continue;
      if (normalized.includes(token)) return project.id;
    }
  }
  return null;
}

function buildProjectTokens(project: ProjectRow): string[] {
  const tokens = [
    project.id,
    project.name,
    project.path.split(/[\\/]/).filter(Boolean).pop() ?? "",
  ]
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 2);
  return Array.from(new Set(tokens));
}

function classifyConversationEnd(text: string): "explicit" | "natural" | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (END_COMMANDS.some((command) => normalized.includes(command))) {
    return "explicit";
  }
  if (
    END_PHRASES.some(
      (phrase) =>
        normalized === phrase ||
        normalized.startsWith(`${phrase} `) ||
        normalized.endsWith(` ${phrase}`)
    )
  ) {
    return "natural";
  }
  return null;
}

function parseSlackOperatorCommand(text: string): ParsedSlackOperatorCommand {
  const normalized = normalizeText(text);
  const match = normalized.match(/^pcc(?:[\s:/-]+(.+))?$/);
  if (!match) return { type: "none" };
  const rawCommand = (match[1] ?? "").trim();
  if (!rawCommand) return { type: "ambiguous" };
  const commandMatch = rawCommand.match(/^(help|status|pause|resume|end)[.!?]?$/);
  if (!commandMatch) return { type: "ambiguous" };
  return {
    type: "command",
    command: commandMatch[1] as SlackOperatorCommand,
  };
}

function isSlackOperatorCommandContext(params: {
  eventType: string;
  channelType: string | null;
  threadTs: string | null;
}): boolean {
  if (params.channelType === "im") return true;
  if (params.eventType === "app_mention") return true;
  return Boolean(params.threadTs);
}

function formatMilestoneText(state: SlackMilestoneState, detail: string): string {
  const prefix =
    state === "accepted"
      ? "Accepted"
      : state === "running"
        ? "Running"
        : state === "blocked"
          ? "Blocked"
          : "Done";
  const normalizedDetail = detail.trim();
  return `${prefix}: ${normalizedDetail || "No details available."}`;
}

function normalizePersonIdList(personIds: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const personId of personIds) {
    const value = personId.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function resolvePersonSlackUserIdForTeam(personId: string, teamId: string): string | null {
  const person = getPersonDetails(personId);
  if (!person) return null;
  const teamIdLower = teamId.trim().toLowerCase();
  const parsedIdentifiers: Array<{ teamId: string; userId: string }> = [];
  for (const identifier of person.identifiers) {
    if (identifier.type !== "other") continue;
    const fromValue = parseSlackPersonIdentifier(identifier.value);
    if (fromValue) {
      parsedIdentifiers.push(fromValue);
      continue;
    }
    const fromNormalized = parseSlackPersonIdentifier(identifier.normalized_value);
    if (fromNormalized) parsedIdentifiers.push(fromNormalized);
  }
  if (!parsedIdentifiers.length) return null;
  const match = parsedIdentifiers.find(
    (identifier) => identifier.teamId.toLowerCase() === teamIdLower
  );
  return match?.userId ?? null;
}

function resolveApproverMentions(teamId: string, approverPersonIds: string[]): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const personId of approverPersonIds) {
    const userId = resolvePersonSlackUserIdForTeam(personId, teamId);
    if (!userId) continue;
    const mention = `<@${userId}>`;
    if (seen.has(mention)) continue;
    seen.add(mention);
    mentions.push(mention);
  }
  return mentions;
}

function resolveSlackPersonIdForActor(teamId: string, userId: string): string | null {
  const normalizedIdentifier = buildNormalizedSlackPersonIdentifier({
    teamId,
    userId,
  });
  if (!normalizedIdentifier) return null;
  const person = resolvePersonByIdentifier({
    type: "other",
    normalizedValue: normalizedIdentifier,
  });
  return person?.id ?? null;
}

function resolveSlackActionability(params: {
  teamId: string;
  userId: string;
}): SlackActionabilityOutcome {
  const approverPersonIds = normalizePersonIdList(getSlackApproverPersonIds());
  const approverMentions = resolveApproverMentions(params.teamId, approverPersonIds);
  const actorPersonId = resolveSlackPersonIdForActor(params.teamId, params.userId);
  if (!actorPersonId) {
    return {
      allowed: false,
      reason: "unmapped",
      actorPersonId: null,
      approverMentions,
    };
  }
  const operatorPersonIds = new Set(normalizePersonIdList(getSlackOperatorPersonIds()));
  if (operatorPersonIds.has(actorPersonId)) {
    return {
      allowed: true,
      actorPersonId,
    };
  }
  return {
    allowed: false,
    reason: "non_operator",
    actorPersonId,
    approverMentions,
  };
}

function resolveSlackApproverAuthorization(params: {
  teamId: string;
  userId: string;
}): SlackApproverAuthorizationOutcome {
  const actorPersonId = resolveSlackPersonIdForActor(params.teamId, params.userId);
  if (!actorPersonId) {
    return { allowed: false, reason: "unmapped", actorPersonId: null };
  }
  const approverPersonIds = new Set(normalizePersonIdList(getSlackApproverPersonIds()));
  if (approverPersonIds.has(actorPersonId)) {
    return { allowed: true, actorPersonId };
  }
  return { allowed: false, reason: "non_approver", actorPersonId };
}

function buildActionabilityBlockedMessage(
  outcome: Extract<SlackActionabilityOutcome, { allowed: false }>
): string {
  if (outcome.reason === "non_operator") {
    if (outcome.approverMentions.length) {
      return `You're mapped to person ${outcome.actorPersonId}, but this person is not in SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS. ${outcome.approverMentions.join(" ")} can approve access.`;
    }
    return `You're mapped to person ${outcome.actorPersonId}, but this person is not in SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS. Ask an approver to grant operator access.`;
  }
  if (outcome.approverMentions.length) {
    return `I can't process this request yet because your Slack identity is not mapped to a person record. ${outcome.approverMentions.join(" ")} please map this user and grant operator access in SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS if appropriate.`;
  }
  return "I can't process this request yet because your Slack identity is not mapped to a person record. Ask a configured approver to map your identity and grant operator access.";
}

function inferIntent(messages: SlackConversationMessageRow[]): "request" | "message" {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content.toLowerCase();
    if (content.includes("?")) return "request";
    if (content.startsWith("can you") || content.startsWith("could you")) {
      return "request";
    }
    if (content.includes("please")) return "request";
  }
  return "message";
}

function classifySlackRequestRisk(messages: SlackConversationMessageRow[]): "high" | "low" {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  if (!userText.trim()) return "low";
  for (const pattern of HIGH_RISK_REQUEST_PATTERNS) {
    if (pattern.test(userText)) return "high";
  }
  return "low";
}

function isSlackActionRequestExpired(
  actionRequest: Pick<SlackActionRequestRow, "expires_at">
): boolean {
  if (!actionRequest.expires_at) return false;
  const expiresAtMs = Date.parse(actionRequest.expires_at);
  if (!Number.isFinite(expiresAtMs)) return true;
  return Date.now() > expiresAtMs;
}

function formatSlackApprovalExpiry(expiresAt: string): string {
  const unixSeconds = Math.floor(Date.parse(expiresAt) / 1000);
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return expiresAt;
  return `<!date^${unixSeconds}^{date_short_pretty} at {time}|${expiresAt}>`;
}

function buildHighRiskApprovalPrompt(params: {
  summary: string;
  expiresAt: string;
  correlationId: string;
}): string {
  return [
    "High-risk request detected. Approval is required before execution.",
    `Request: ${params.summary}`,
    `React with :${SLACK_APPROVE_REACTION}: to approve or :${SLACK_DENY_REACTION}: to deny.`,
    `Expires: ${formatSlackApprovalExpiry(params.expiresAt)}`,
    `Correlation: ${params.correlationId}`,
  ].join("\n");
}

function resolveSlackInstallation(teamId: string | null): SlackInstallationRow | null {
  if (teamId) return getSlackInstallationByTeam(teamId);
  const installs = listSlackInstallations();
  if (installs.length === 1) return installs[0];
  return null;
}

async function callSlackApi(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => null)) as SlackApiResponse | null;
  if (!data) return { ok: false, error: "invalid Slack response" };
  return data;
}

async function openSlackDm(token: string, userId: string): Promise<string | null> {
  const response = await callSlackApi(token, "conversations.open", { users: userId });
  if (!response.ok) return null;
  const channel = asRecord(response.channel);
  const channelId = readString(channel?.id);
  return channelId ?? null;
}

function isDirectMessageChannelId(channelId: string): boolean {
  return channelId.startsWith("D");
}

function logStaleDebriefDiagnostic(
  event: string,
  context: Record<string, unknown>
): void {
  // eslint-disable-next-line no-console
  console.error(
    "[slack][stale_debrief_rollover]",
    JSON.stringify({
      event,
      ...context,
    })
  );
}

function logSlackOperatorBridge(
  event: string,
  context: SlackOperatorBridgeLogContext,
  level: "info" | "error" = "info"
): void {
  // eslint-disable-next-line no-console
  const logger = level === "error" ? console.error : console.info;
  logger(
    "[slack][operator_v1_bridge]",
    JSON.stringify({
      event,
      ...context,
    })
  );
}

function logSlackApprovalEvent(
  event: string,
  context: Record<string, unknown>,
  level: "info" | "error" = "info"
): void {
  // eslint-disable-next-line no-console
  const logger = level === "error" ? console.error : console.info;
  logger(
    "[slack][operator_v1_approval]",
    JSON.stringify({
      event,
      ...context,
    })
  );
}

function compactMilestoneDetail(value: string, maxLength = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function mapSessionEventToMilestone(
  event: GlobalAgentSessionEvent
): { state: Exclude<SlackMilestoneState, "accepted">; text: string } | null {
  const payload = event.payload ?? {};
  const message = compactMilestoneDetail(readString(payload.message) ?? "");
  const reason = compactMilestoneDetail(readString(payload.reason) ?? "");
  const summary = compactMilestoneDetail(readString(payload.summary) ?? "");
  if (event.type === "check_in") {
    return { state: "running", text: `Running: ${message || "Work is in progress."}` };
  }
  if (event.type === "guidance") {
    return { state: "blocked", text: `Blocked: ${message || "Guidance required to continue."}` };
  }
  if (event.type === "alert") {
    return {
      state: "blocked",
      text: `Blocked: ${reason || message || "Execution alert received."}`,
    };
  }
  if (event.type === "completion") {
    return { state: "done", text: `Done: ${summary || "Execution completed."}` };
  }
  return null;
}

function buildAcceptedMilestoneText(params: {
  sessionId: string;
  shiftId: string;
  sessionMode: "started" | "resumed" | "already_autonomous";
}): string {
  const modeText =
    params.sessionMode === "already_autonomous"
      ? "using the active global session"
      : params.sessionMode === "resumed"
        ? "resuming the paused global session"
        : "starting a global session";
  return `Accepted: queued for execution ${modeText} (${params.sessionId}, shift ${params.shiftId}).`;
}

function hasDmFallbackNotice(conversationId: string): boolean {
  return listSlackConversationMessages(conversationId).some(
    (message) => message.role === "assistant" && message.content.includes(SLACK_DM_FALLBACK_NOTICE)
  );
}

async function postMilestoneToConversation(params: {
  conversation: SlackConversationRow;
  text: string;
  messageKey: string;
  globalSessionId: string | null;
  milestoneState: SlackMilestoneState;
}): Promise<void> {
  let conversation = params.conversation;
  if (!resolveSlackInstallation(conversation.slack_team_id)) return;
  const basePayload = {
    team_id: conversation.slack_team_id,
    user_id: conversation.slack_user_id,
    conversation_id: conversation.id,
    project_id: conversation.project_id,
    message_key: params.messageKey,
  };

  if (conversation.slack_thread_ts) {
    try {
      const threadResult = await sendSlackMessage({
        ...basePayload,
        channel_id: conversation.slack_channel_id,
        thread_ts: conversation.slack_thread_ts,
        text: params.text,
      });
      if (threadResult.ok) return;
      logSlackOperatorBridge(
        "milestone_thread_send_failed",
        {
          correlation_id: params.messageKey,
          conversation_id: conversation.id,
          communication_id: null,
          global_session_id: params.globalSessionId,
          project_id: conversation.project_id,
          milestone_state: params.milestoneState,
          error: threadResult.error ?? "thread send failed",
        },
        "error"
      );
    } catch (error) {
      logSlackOperatorBridge(
        "milestone_thread_send_exception",
        {
          correlation_id: params.messageKey,
          conversation_id: conversation.id,
          communication_id: null,
          global_session_id: params.globalSessionId,
          project_id: conversation.project_id,
          milestone_state: params.milestoneState,
          error: readErrorMessage(error),
        },
        "error"
      );
    }
    const updated = updateSlackConversation({
      id: conversation.id,
      slack_thread_ts: null,
    });
    if (updated) conversation = updated;
  }

  const prefix = hasDmFallbackNotice(conversation.id)
    ? ""
    : `${SLACK_DM_FALLBACK_NOTICE}\n\n`;
  const dmResult = await sendSlackMessage({
    ...basePayload,
    text: `${prefix}${params.text}`,
    force_dm: true,
  });
  if (dmResult.ok) return;
  logSlackOperatorBridge(
    "milestone_dm_send_failed",
    {
      correlation_id: params.messageKey,
      conversation_id: conversation.id,
      communication_id: null,
      global_session_id: params.globalSessionId,
      project_id: conversation.project_id,
      milestone_state: params.milestoneState,
      error: dmResult.error ?? "dm send failed",
    },
    "error"
  );
}

async function postAcceptedMilestone(params: {
  conversation: SlackConversationRow;
  communicationId: string;
  sessionId: string;
  shiftId: string;
  sessionMode: "started" | "resumed" | "already_autonomous";
}): Promise<void> {
  await postMilestoneToConversation({
    conversation: params.conversation,
    text: buildAcceptedMilestoneText({
      sessionId: params.sessionId,
      shiftId: params.shiftId,
      sessionMode: params.sessionMode,
    }),
    messageKey: `milestone:accepted:${params.communicationId}`,
    globalSessionId: params.sessionId,
    milestoneState: "accepted",
  });
}

export async function notifySlackMilestoneForSessionEvent(
  event: GlobalAgentSessionEvent
): Promise<void> {
  const mapped = mapSessionEventToMilestone(event);
  if (!mapped) return;
  const conversations = listSlackConversationsByGlobalSessionId(event.session_id);
  if (!conversations.length) return;

  for (const conversation of conversations) {
    await postMilestoneToConversation({
      conversation,
      text: mapped.text,
      messageKey: `milestone:event:${event.id}:${mapped.state}`,
      globalSessionId: event.session_id,
      milestoneState: mapped.state,
    });
  }
}

let slackMilestoneListenerRegistered = false;

function ensureSlackMilestoneListenerRegistered(): void {
  if (slackMilestoneListenerRegistered) return;
  registerGlobalAgentSessionEventListener((event) => notifySlackMilestoneForSessionEvent(event));
  slackMilestoneListenerRegistered = true;
}

function buildSlackBridgeCorrelationId(conversationId: string, endedAt: string): string {
  return `${conversationId}:${endedAt}`;
}

function buildSlackCommunicationPayload(params: {
  conversation: SlackConversationRow;
  endedAt: string;
  reason: "explicit" | "natural" | "timeout";
  correlationId: string;
  messages: SlackConversationMessageRow[];
  actionable: boolean;
}): string {
  return JSON.stringify({
    source: "slack",
    actionable_request: params.actionable,
    correlation_id: params.correlationId,
    conversation_id: params.conversation.id,
    slack_team_id: params.conversation.slack_team_id,
    slack_channel_id: params.conversation.slack_channel_id,
    slack_user_id: params.conversation.slack_user_id,
    slack_thread_ts: params.conversation.slack_thread_ts,
    started_at: params.conversation.started_at,
    ended_at: params.endedAt,
    reason: params.reason,
    messages: params.messages.map((message) => ({
      role: message.role,
      content: message.content,
      created_at: message.created_at,
    })),
  });
}

async function notifySlackThreadExecutionFailure(params: {
  conversation: SlackConversationRow;
  correlationId: string;
  error: string;
  communicationId: string | null;
  globalSessionId: string | null;
}): Promise<void> {
  const details = [
    "I couldn't queue this request for execution.",
    `Reason: ${params.error}`,
    `Correlation: ${params.correlationId}`,
  ];
  if (params.communicationId) {
    details.push(`Communication: ${params.communicationId}`);
  }
  if (params.globalSessionId) {
    details.push(`Global session: ${params.globalSessionId}`);
  }
  try {
    const result = await sendSlackMessage({
      team_id: params.conversation.slack_team_id,
      channel_id: params.conversation.slack_channel_id,
      user_id: params.conversation.slack_user_id,
      text: details.join("\n"),
      thread_ts: params.conversation.slack_thread_ts,
      conversation_id: params.conversation.id,
      project_id: params.conversation.project_id,
    });
    if (!result.ok) {
      logSlackOperatorBridge(
        "failure_notice_send_failed",
        {
          correlation_id: params.correlationId,
          conversation_id: params.conversation.id,
          communication_id: params.communicationId,
          global_session_id: params.globalSessionId,
          project_id: params.conversation.project_id,
          error: result.error ?? "Slack send failed",
        },
        "error"
      );
    }
  } catch (error) {
    logSlackOperatorBridge(
      "failure_notice_send_exception",
      {
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        communication_id: params.communicationId,
        global_session_id: params.globalSessionId,
        project_id: params.conversation.project_id,
        error: readErrorMessage(error),
      },
      "error"
    );
  }
}

function bootstrapOnboardingSessionForSlack(
  session: GlobalAgentSession
): { ok: true; session: GlobalAgentSession } | { ok: false; error: string } {
  const rubric = session.onboarding_rubric.map((item) => ({ ...item, done: true }));
  const updated = updateGlobalAgentSessionDetails(session.id, { onboarding_rubric: rubric });
  if (!updated.ok) {
    return { ok: false, error: `failed to update onboarding rubric: ${updated.error}` };
  }
  const completed = completeGlobalAgentOnboarding(session.id);
  if (!completed.ok) {
    return { ok: false, error: `failed to complete onboarding: ${completed.error}` };
  }
  return { ok: true, session: completed.session };
}

function ensureAutonomousGlobalSessionForSlackRequest(): SlackSessionExecutionOutcome {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const inspection = inspectActiveGlobalSessionForRollover();
    if (!inspection.ok) {
      if (inspection.reason === "none") {
        const created = createGlobalAgentSession();
        if (!created.ok) {
          if (created.error === "session already active") {
            continue;
          }
          return {
            ok: false,
            error: `failed to create global session: ${created.error}`,
            sessionId: null,
          };
        }
        continue;
      }
      return {
        ok: false,
        error: `active session inspection failed: ${inspection.reason}`,
        sessionId: null,
      };
    }

    const activeSession = inspection.session;
    if (activeSession.state === "autonomous") {
      return { ok: true, sessionId: activeSession.id, mode: "already_autonomous" };
    }
    if (activeSession.state === "briefing") {
      const resumed = Boolean(activeSession.paused_at);
      const started = startGlobalAgentSessionAutonomous({
        sessionId: activeSession.id,
        resume: resumed,
        startLoop: false,
      });
      if (!started.ok) {
        return {
          ok: false,
          error: `failed to start global session: ${started.error}`,
          sessionId: activeSession.id,
        };
      }
      return {
        ok: true,
        sessionId: started.session.id,
        mode: resumed ? "resumed" : "started",
      };
    }
    if (activeSession.state === "onboarding") {
      const bootstrap = bootstrapOnboardingSessionForSlack(activeSession);
      if (!bootstrap.ok) {
        return {
          ok: false,
          error: bootstrap.error,
          sessionId: activeSession.id,
        };
      }
      continue;
    }
    if (activeSession.state === "debrief") {
      const ended = endGlobalAgentSession(activeSession.id);
      if (!ended.ok) {
        return {
          ok: false,
          error: `failed to end debrief session: ${ended.error}`,
          sessionId: activeSession.id,
        };
      }
      continue;
    }
    return {
      ok: false,
      error: `unsupported global session state: ${activeSession.state}`,
      sessionId: activeSession.id,
    };
  }
  return {
    ok: false,
    error: "unable to prepare a runnable global session",
    sessionId: null,
  };
}

function resolveDebriefSummary(session: GlobalAgentSession): string {
  const events = listGlobalAgentSessionEvents({ sessionId: session.id, limit: 20 });
  for (const event of events) {
    if (event.type !== "completion") continue;
    const summary = readString(event.payload?.summary);
    if (summary) return summary;
  }
  return "Debrief summary unavailable.";
}

function buildStaleDebriefRolloverNotice(params: {
  staleMinutes: number;
  staleSessionId: string;
  freshSessionId: string;
  summary: string;
}): string {
  return [
    `The prior global session sat in debrief for more than ${params.staleMinutes} minute(s).`,
    `Ended stale session ${params.staleSessionId} and started session ${params.freshSessionId}.`,
    `Debrief summary:\n${params.summary}`,
  ].join("\n\n");
}

function inspectActiveGlobalSessionForRollover(): ActiveGlobalSessionInspection {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, state, created_at, updated_at
       FROM global_agent_sessions
       WHERE state != 'ended'
       ORDER BY created_at DESC`
    )
    .all() as ActiveGlobalSessionSnapshotRow[];
  if (!rows.length) {
    return { ok: false, reason: "none", details: {} };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      details: {
        active_sessions: rows.map((row) => ({
          id: row.id,
          state: row.state,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
      },
    };
  }
  const row = rows[0];
  if (!GLOBAL_AGENT_SESSION_STATES.has(row.state)) {
    return {
      ok: false,
      reason: "corrupt",
      details: {
        session_id: row.id,
        invalid_state: row.state,
      },
    };
  }
  const session = getGlobalAgentSessionById(row.id);
  if (!session) {
    return {
      ok: false,
      reason: "corrupt",
      details: {
        session_id: row.id,
        error: "active session row missing",
      },
    };
  }
  return { ok: true, session };
}

async function postStaleDebriefRolloverNotice(params: {
  conversation: SlackConversationRow;
  text: string;
  correlationId: string;
}): Promise<void> {
  if (params.conversation.slack_thread_ts) {
    try {
      const threadResult = await sendSlackMessage({
        team_id: params.conversation.slack_team_id,
        channel_id: params.conversation.slack_channel_id,
        user_id: params.conversation.slack_user_id,
        text: params.text,
        thread_ts: params.conversation.slack_thread_ts,
        conversation_id: params.conversation.id,
        project_id: params.conversation.project_id,
      });
      if (!threadResult.ok) {
        logStaleDebriefDiagnostic("thread_notice_failed", {
          correlation_id: params.correlationId,
          conversation_id: params.conversation.id,
          error: threadResult.error ?? "thread send failed",
        });
      }
    } catch (error) {
      logStaleDebriefDiagnostic("thread_notice_exception", {
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        error: readErrorMessage(error),
      });
    }
  }
  try {
    const dmResult = await sendSlackMessage({
      team_id: params.conversation.slack_team_id,
      user_id: params.conversation.slack_user_id,
      text: params.text,
      project_id: params.conversation.project_id,
    });
    if (!dmResult.ok) {
      logStaleDebriefDiagnostic("dm_notice_failed", {
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        error: dmResult.error ?? "dm send failed",
      });
    }
  } catch (error) {
    logStaleDebriefDiagnostic("dm_notice_exception", {
      correlation_id: params.correlationId,
      conversation_id: params.conversation.id,
      error: readErrorMessage(error),
    });
  }
}

async function maybeRolloverStaleDebriefSessionForActionableSlackRequest(params: {
  conversation: SlackConversationRow;
  staleMinutes: number;
  correlationId: string;
}): Promise<void> {
  const inspection = inspectActiveGlobalSessionForRollover();
  if (!inspection.ok) {
    if (inspection.reason === "ambiguous" || inspection.reason === "corrupt") {
      logStaleDebriefDiagnostic(inspection.reason, {
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        ...inspection.details,
      });
    }
    return;
  }

  const activeSession = inspection.session;
  if (activeSession.state !== "debrief") return;
  const updatedAtMs = Date.parse(activeSession.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    logStaleDebriefDiagnostic("corrupt", {
      correlation_id: params.correlationId,
      conversation_id: params.conversation.id,
      session_id: activeSession.id,
      error: "invalid updated_at timestamp",
      updated_at: activeSession.updated_at,
    });
    return;
  }
  const staleDurationMs = params.staleMinutes * 60_000;
  if (Date.now() - updatedAtMs < staleDurationMs) return;

  const debriefSummary = resolveDebriefSummary(activeSession);
  const ended = endGlobalAgentSession(activeSession.id);
  if (!ended.ok) {
    logStaleDebriefDiagnostic("end_failed", {
      correlation_id: params.correlationId,
      conversation_id: params.conversation.id,
      session_id: activeSession.id,
      error: ended.error,
    });
    return;
  }

  const created = createGlobalAgentSession();
  if (!created.ok) {
    if (created.error === "session already active") {
      return;
    }
    logStaleDebriefDiagnostic("create_failed", {
      correlation_id: params.correlationId,
      conversation_id: params.conversation.id,
      prior_session_id: activeSession.id,
      error: created.error,
    });
    return;
  }

  const started = startGlobalAgentSessionAutonomous({
    sessionId: created.session.id,
    // Slack bridge execution remains shift-triggered; avoid starting a parallel loop here.
    startLoop: false,
  });
  if (!started.ok) {
    logStaleDebriefDiagnostic("start_failed", {
      correlation_id: params.correlationId,
      conversation_id: params.conversation.id,
      stale_session_id: activeSession.id,
      fresh_session_id: created.session.id,
      error: started.error,
    });
    return;
  }

  const notice = buildStaleDebriefRolloverNotice({
    staleMinutes: params.staleMinutes,
    staleSessionId: activeSession.id,
    freshSessionId: created.session.id,
    summary: debriefSummary,
  });
  await postStaleDebriefRolloverNotice({
    conversation: params.conversation,
    text: notice,
    correlationId: params.correlationId,
  });
}

async function executeOperatorV1ActionableRequest(params: {
  conversation: SlackConversationRow;
  projectId: string;
  intent: "request" | "message";
  summary: string;
  body: string;
  payload: string;
  correlationId: string;
}): Promise<SlackActionExecutionOutcome> {
  let communicationId: string | null = null;
  try {
    const communication = createProjectCommunication({
      project_id: params.projectId,
      intent: params.intent,
      summary: `Slack conversation: ${params.summary}`,
      body: params.body,
      payload: params.payload,
      from_scope: "user",
      to_scope: "global",
    });
    communicationId = communication.id;
  } catch (error) {
    const message = `failed to create project communication: ${readErrorMessage(error)}`;
    logSlackOperatorBridge(
      "communication_create_failed",
      {
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        communication_id: null,
        global_session_id: null,
        project_id: params.projectId,
        error: message,
      },
      "error"
    );
    await notifySlackThreadExecutionFailure({
      conversation: params.conversation,
      correlationId: params.correlationId,
      error: message,
      communicationId: null,
      globalSessionId: null,
    });
    return {
      ok: false,
      error: message,
      communicationId: null,
      sessionId: null,
    };
  }

  const sessionExecution = ensureAutonomousGlobalSessionForSlackRequest();
  if (!sessionExecution.ok) {
    logSlackOperatorBridge(
      "global_session_prepare_failed",
      {
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        communication_id: communicationId,
        global_session_id: sessionExecution.sessionId,
        project_id: params.projectId,
        error: sessionExecution.error,
      },
      "error"
    );
    await notifySlackThreadExecutionFailure({
      conversation: params.conversation,
      correlationId: params.correlationId,
      error: sessionExecution.error,
      communicationId,
      globalSessionId: sessionExecution.sessionId,
    });
    return {
      ok: false,
      error: sessionExecution.error,
      communicationId,
      sessionId: sessionExecution.sessionId,
    };
  }

  const linkedConversation =
    updateSlackConversation({
      id: params.conversation.id,
      global_session_id: sessionExecution.sessionId,
    }) ?? params.conversation;

  const shiftResult = startGlobalShift({
    agentType: getGlobalAgentType(),
    agentId: getGlobalAgentId(),
    timeoutMinutes: null,
    sessionId: sessionExecution.sessionId,
  });
  const globalShiftId = shiftResult.ok ? shiftResult.shift.id : shiftResult.activeShift.id;

  logSlackOperatorBridge("execution_enqueued", {
    correlation_id: params.correlationId,
    conversation_id: params.conversation.id,
    communication_id: communicationId,
    global_session_id: sessionExecution.sessionId,
    project_id: params.projectId,
    session_mode: sessionExecution.mode,
    global_shift_id: globalShiftId,
    shift_reused: !shiftResult.ok,
  });

  if (communicationId) {
    try {
      await postAcceptedMilestone({
        conversation: linkedConversation,
        communicationId,
        sessionId: sessionExecution.sessionId,
        shiftId: globalShiftId,
        sessionMode: sessionExecution.mode,
      });
    } catch (error) {
      logSlackOperatorBridge(
        "accepted_milestone_send_exception",
        {
          correlation_id: params.correlationId,
          conversation_id: params.conversation.id,
          communication_id: communicationId,
          global_session_id: sessionExecution.sessionId,
          project_id: params.projectId,
          error: readErrorMessage(error),
        },
        "error"
      );
    }
  }

  return {
    ok: true,
    communicationId,
    sessionId: sessionExecution.sessionId,
    shiftId: globalShiftId,
    sessionMode: sessionExecution.mode,
    shiftReused: !shiftResult.ok,
  };
}

function isSlackActionRequestTerminalStatus(status: SlackActionRequestStatus): boolean {
  return (
    status === "denied" ||
    status === "expired" ||
    status === "executing" ||
    status === "completed"
  );
}

function markSlackActionRequestFailedSafely(params: {
  actionRequestId: string;
  error: string;
  expectedCurrentStatus?: SlackActionRequestStatus | SlackActionRequestStatus[];
}): SlackActionRequestRow | null {
  return updateSlackActionRequest({
    id: params.actionRequestId,
    status: "denied",
    error: params.error,
    decision_at: nowIso(),
    expected_current_status: params.expectedCurrentStatus ?? [
      "pending_approval",
      "approved",
      "executing",
    ],
  });
}

async function enqueueHighRiskSlackApprovalRequest(params: {
  conversation: SlackConversationRow;
  projectId: string;
  summary: string;
  body: string;
  intent: "request" | "message";
  payload: string;
  correlationId: string;
  requestedByPersonId: string | null;
}): Promise<{ ok: true; actionRequest: SlackActionRequestRow } | { ok: false; error: string }> {
  const expiresAt = new Date(
    Date.now() + getSlackApprovalTtlMinutes() * 60_000
  ).toISOString();
  const actionRequest = createSlackActionRequest({
    conversation_id: params.conversation.id,
    project_id: params.projectId,
    slack_team_id: params.conversation.slack_team_id,
    slack_channel_id: params.conversation.slack_channel_id,
    slack_thread_ts: params.conversation.slack_thread_ts,
    request_summary: params.summary,
    request_body: params.body,
    intent: params.intent,
    communication_payload: params.payload,
    correlation_id: params.correlationId,
    risk_level: "high",
    status: "pending_approval",
    requested_by_slack_user_id: params.conversation.slack_user_id,
    requested_by_person_id: params.requestedByPersonId,
    expires_at: expiresAt,
  });

  try {
    const approvalPrompt = buildHighRiskApprovalPrompt({
      summary: params.summary,
      expiresAt,
      correlationId: params.correlationId,
    });
    const approvalMessageResult = await sendSlackMessage({
      team_id: params.conversation.slack_team_id,
      channel_id: params.conversation.slack_channel_id,
      user_id: params.conversation.slack_user_id,
      text: approvalPrompt,
      thread_ts: params.conversation.slack_thread_ts,
      conversation_id: params.conversation.id,
      project_id: params.projectId,
    });
    if (!approvalMessageResult.ok || !approvalMessageResult.slack_ts) {
      const reason = approvalMessageResult.error ?? "approval message missing Slack ts";
      markSlackActionRequestFailedSafely({
        actionRequestId: actionRequest.id,
        error: `approval prompt failed: ${reason}`,
        expectedCurrentStatus: "pending_approval",
      });
      return { ok: false, error: `approval prompt failed: ${reason}` };
    }

    const withApprovalMessage = updateSlackActionRequest({
      id: actionRequest.id,
      approval_message_ts: approvalMessageResult.slack_ts,
      error: null,
    });
    if (!withApprovalMessage?.approval_message_ts) {
      markSlackActionRequestFailedSafely({
        actionRequestId: actionRequest.id,
        error: "approval prompt could not be correlated deterministically",
        expectedCurrentStatus: "pending_approval",
      });
      return {
        ok: false,
        error: "approval prompt could not be correlated deterministically",
      };
    }

    const matches = listSlackActionRequestsByApprovalMessage({
      team_id: params.conversation.slack_team_id,
      channel_id: params.conversation.slack_channel_id,
      approval_message_ts: withApprovalMessage.approval_message_ts,
    });
    if (matches.length !== 1 || matches[0]?.id !== withApprovalMessage.id) {
      markSlackActionRequestFailedSafely({
        actionRequestId: actionRequest.id,
        error: "approval prompt correlation is ambiguous",
        expectedCurrentStatus: "pending_approval",
      });
      return {
        ok: false,
        error: "approval prompt correlation is ambiguous",
      };
    }

    logSlackApprovalEvent("approval_requested", {
      action_request_id: withApprovalMessage.id,
      correlation_id: params.correlationId,
      conversation_id: params.conversation.id,
      approval_message_ts: withApprovalMessage.approval_message_ts,
      expires_at: withApprovalMessage.expires_at,
    });
    return { ok: true, actionRequest: withApprovalMessage };
  } catch (error) {
    const reason = `approval prompt failed: ${readErrorMessage(error)}`;
    const failed = markSlackActionRequestFailedSafely({
      actionRequestId: actionRequest.id,
      error: reason,
      expectedCurrentStatus: ["pending_approval", "approved"],
    });
    if (!failed) {
      const latest = getSlackActionRequestById(actionRequest.id);
      logSlackApprovalEvent("approval_request_enqueue_exception_request_preserved", {
        action_request_id: actionRequest.id,
        correlation_id: params.correlationId,
        current_status: latest?.status ?? null,
      });
    }
    logSlackApprovalEvent(
      "approval_request_enqueue_exception",
      {
        action_request_id: actionRequest.id,
        correlation_id: params.correlationId,
        conversation_id: params.conversation.id,
        error: reason,
      },
      "error"
    );
    return { ok: false, error: reason };
  }
}

async function finalizeConversation(params: {
  conversation: SlackConversationRow;
  ended_at: string;
  reason: "explicit" | "natural" | "timeout";
  operatorV1Enabled?: boolean;
}): Promise<{ forwardedToGlobal: boolean }> {
  let actionability:
    | Extract<SlackActionabilityOutcome, { allowed: true }>
    | null = null;
  if (params.operatorV1Enabled) {
    const outcome = resolveSlackActionability({
      teamId: params.conversation.slack_team_id,
      userId: params.conversation.slack_user_id,
    });
    if (!outcome.allowed) {
      await sendSlackMessage({
        team_id: params.conversation.slack_team_id,
        channel_id: params.conversation.slack_channel_id,
        user_id: params.conversation.slack_user_id,
        text: buildActionabilityBlockedMessage(outcome),
        thread_ts: params.conversation.slack_thread_ts,
        conversation_id: params.conversation.id,
        project_id: params.conversation.project_id,
      });
      updateSlackConversation({
        id: params.conversation.id,
        status: "ended",
        ended_at: params.ended_at,
        global_session_id: null,
      });
      return { forwardedToGlobal: false };
    }
    actionability = outcome;
  }

  const messages = listSlackConversationMessages(params.conversation.id);
  const combinedText = messages.map((message) => message.content).join("\n");
  const detectedProjectId = detectProjectIdFromText(combinedText);
  const projectId =
    params.conversation.project_id ?? detectedProjectId ?? resolveDefaultProjectId();
  if (!projectId) {
    updateSlackConversation({
      id: params.conversation.id,
      status: "ended",
      ended_at: params.ended_at,
      global_session_id: null,
    });
    return { forwardedToGlobal: false };
  }

  const summary = buildConversationSummary(messages);
  const body = formatConversationBody(messages);
  const intent = inferIntent(messages);
  const actionableRequest = intent === "request";
  const correlationId = buildSlackBridgeCorrelationId(params.conversation.id, params.ended_at);

  if (params.operatorV1Enabled && !actionableRequest) {
    logSlackOperatorBridge("non_actionable_conversation_ended", {
      correlation_id: correlationId,
      conversation_id: params.conversation.id,
      communication_id: null,
      global_session_id: null,
      project_id: projectId,
      intent,
    });
    updateSlackConversation({
      id: params.conversation.id,
      status: "ended",
      project_id: projectId,
      ended_at: params.ended_at,
      global_session_id: null,
    });
    return { forwardedToGlobal: false };
  }

  const payload = buildSlackCommunicationPayload({
    conversation: params.conversation,
    endedAt: params.ended_at,
    reason: params.reason,
    correlationId,
    messages,
    actionable: actionableRequest,
  });

  if (params.operatorV1Enabled && intent === "request") {
    const riskLevel = classifySlackRequestRisk(messages);
    if (riskLevel === "high") {
      const approvalResult = await enqueueHighRiskSlackApprovalRequest({
        conversation: params.conversation,
        projectId,
        summary,
        body,
        intent,
        payload,
        correlationId,
        requestedByPersonId: actionability?.actorPersonId ?? null,
      });
      if (!approvalResult.ok) {
        await notifySlackThreadExecutionFailure({
          conversation: params.conversation,
          correlationId,
          error: approvalResult.error,
          communicationId: null,
          globalSessionId: null,
        });
      }
      updateSlackConversation({
        id: params.conversation.id,
        status: "ended",
        project_id: projectId,
        ended_at: params.ended_at,
        global_session_id: null,
      });
      return { forwardedToGlobal: false };
    }
    await maybeRolloverStaleDebriefSessionForActionableSlackRequest({
      conversation: params.conversation,
      staleMinutes: getSlackStaleDebriefMinutes(),
      correlationId,
    });
    const execution = await executeOperatorV1ActionableRequest({
      conversation: params.conversation,
      projectId,
      intent,
      summary,
      body,
      payload,
      correlationId,
    });
    if (!execution.ok) {
      updateSlackConversation({
        id: params.conversation.id,
        status: "ended",
        project_id: projectId,
        ended_at: params.ended_at,
        global_session_id: execution.sessionId,
      });
      return { forwardedToGlobal: false };
    }

    updateSlackConversation({
      id: params.conversation.id,
      status: "processed",
      project_id: projectId,
      ended_at: params.ended_at,
      processed_at: nowIso(),
      global_shift_id: execution.shiftId,
      global_session_id: execution.sessionId,
    });
    return { forwardedToGlobal: true };
  }

  let communicationId: string | null = null;
  try {
    const communication = createProjectCommunication({
      project_id: projectId,
      intent,
      summary: `Slack conversation: ${summary}`,
      body,
      payload,
      from_scope: "user",
      to_scope: "global",
    });
    communicationId = communication.id;
  } catch (error) {
    const message = `failed to create project communication: ${readErrorMessage(error)}`;
    logSlackOperatorBridge(
      "communication_create_failed",
      {
        correlation_id: correlationId,
        conversation_id: params.conversation.id,
        communication_id: null,
        global_session_id: null,
        project_id: projectId,
        error: message,
      },
      "error"
    );
    await notifySlackThreadExecutionFailure({
      conversation: params.conversation,
      correlationId,
      error: message,
      communicationId: null,
      globalSessionId: null,
    });
    updateSlackConversation({
      id: params.conversation.id,
      status: "ended",
      project_id: projectId,
      ended_at: params.ended_at,
      global_session_id: null,
    });
    return { forwardedToGlobal: false };
  }

  const shiftResult = startGlobalShift({
    agentType: getGlobalAgentType(),
    agentId: getGlobalAgentId(),
    timeoutMinutes: null,
  });

  updateSlackConversation({
    id: params.conversation.id,
    status: "processed",
    project_id: projectId,
    ended_at: params.ended_at,
    processed_at: nowIso(),
    global_shift_id: shiftResult.ok ? shiftResult.shift.id : null,
    global_session_id: null,
  });
  logSlackOperatorBridge("execution_enqueued", {
    correlation_id: correlationId,
    conversation_id: params.conversation.id,
    communication_id: communicationId,
    global_session_id: null,
    project_id: projectId,
    global_shift_id: shiftResult.ok ? shiftResult.shift.id : null,
    shift_reused: !shiftResult.ok,
    session_mode: null,
  });
  return { forwardedToGlobal: true };
}

function buildSlackOperatorHelpResponse(): string {
  const commands = SLACK_OPERATOR_COMMANDS.map((command) => `pcc ${command}`).join(", ");
  return formatMilestoneText(
    "done",
    `Available commands: ${commands}. Commands are operational shortcuts; continue in natural language anytime.`
  );
}

function buildSessionInspectionBlockedResponse(
  inspection: Extract<ActiveGlobalSessionInspection, { ok: false }>
): string {
  if (inspection.reason === "none") {
    return formatMilestoneText(
      "blocked",
      "No active global session. Queue work with a normal request, then run `pcc status`."
    );
  }
  if (inspection.reason === "ambiguous") {
    return formatMilestoneText(
      "blocked",
      "Multiple active global sessions were detected, so this command was not executed. Resolve active session state in Shiftboss, then retry."
    );
  }
  return formatMilestoneText(
    "blocked",
    "Global session state appears inconsistent, so this command was not executed. Inspect `/global/sessions/active` and resolve before retrying."
  );
}

function buildSessionStatsSuffix(session: GlobalAgentSession): string {
  return `iterations ${session.iteration_count}, decisions ${session.decisions_count}, actions ${session.actions_count}`;
}

function buildSlackOperatorStatusResponse(session: GlobalAgentSession): string {
  if (session.state === "autonomous") {
    return formatMilestoneText(
      "running",
      `Global session ${session.id} is autonomous (${buildSessionStatsSuffix(session)}).`
    );
  }
  if (session.state === "briefing" && session.paused_at) {
    return formatMilestoneText(
      "blocked",
      `Global session ${session.id} is paused in briefing. Run \`pcc resume\` to continue.`
    );
  }
  if (session.state === "briefing") {
    return formatMilestoneText(
      "blocked",
      `Global session ${session.id} is waiting in briefing. Run \`pcc resume\` to enter autonomous mode.`
    );
  }
  if (session.state === "onboarding") {
    return formatMilestoneText(
      "blocked",
      `Global session ${session.id} is in onboarding and cannot run commands yet.`
    );
  }
  if (session.state === "debrief") {
    return formatMilestoneText(
      "done",
      `Global session ${session.id} is in debrief. Run \`pcc end\` to close it.`
    );
  }
  return formatMilestoneText("done", `Global session ${session.id} is ${session.state}.`);
}

function executeSlackOperatorCommand(command: SlackOperatorCommand): string {
  if (command === "help") {
    return buildSlackOperatorHelpResponse();
  }
  const inspection = inspectActiveGlobalSessionForRollover();
  if (!inspection.ok) {
    return buildSessionInspectionBlockedResponse(inspection);
  }
  const session = inspection.session;

  if (command === "status") {
    return buildSlackOperatorStatusResponse(session);
  }

  if (command === "pause") {
    if (session.state === "briefing" && session.paused_at) {
      return formatMilestoneText("done", `Global session ${session.id} is already paused.`);
    }
    if (session.state !== "autonomous") {
      return formatMilestoneText(
        "blocked",
        `Global session ${session.id} is ${session.state}; only autonomous sessions can be paused.`
      );
    }
    const paused = pauseGlobalAgentSession(session.id, "slack_command_pause");
    if (!paused.ok) {
      return formatMilestoneText(
        "blocked",
        `Failed to pause global session ${session.id}: ${paused.error}.`
      );
    }
    return formatMilestoneText("done", `Paused global session ${session.id}.`);
  }

  if (command === "resume") {
    if (session.state === "autonomous") {
      return formatMilestoneText("running", `Global session ${session.id} is already autonomous.`);
    }
    if (session.state !== "briefing") {
      return formatMilestoneText(
        "blocked",
        `Global session ${session.id} is ${session.state}; only briefing sessions can be resumed.`
      );
    }
    const resumed = startGlobalAgentSessionAutonomous({
      sessionId: session.id,
      resume: Boolean(session.paused_at),
      // Slack command execution should mirror bridge behavior and avoid spawning a parallel loop.
      startLoop: false,
    });
    if (!resumed.ok) {
      return formatMilestoneText(
        "blocked",
        `Failed to resume global session ${session.id}: ${resumed.error}.`
      );
    }
    const mode = session.paused_at ? "Resumed" : "Started";
    return formatMilestoneText("running", `${mode} global session ${session.id} in autonomous mode.`);
  }

  if (session.state === "onboarding") {
    return formatMilestoneText(
      "blocked",
      `Global session ${session.id} is in onboarding and cannot be ended yet.`
    );
  }

  if (session.state === "debrief") {
    const ended = endGlobalAgentSession(session.id);
    if (!ended.ok) {
      return formatMilestoneText(
        "blocked",
        `Failed to end global session ${session.id}: ${ended.error}.`
      );
    }
    return formatMilestoneText("done", `Ended global session ${session.id}.`);
  }

  const stopped = stopGlobalAgentSession(session.id, "Stopped by Slack command");
  if (!stopped.ok) {
    return formatMilestoneText(
      "blocked",
      `Failed to stop global session ${session.id}: ${stopped.error}.`
    );
  }
  const ended = endGlobalAgentSession(session.id);
  if (!ended.ok) {
    return formatMilestoneText(
      "blocked",
      `Global session ${session.id} reached debrief but could not be closed: ${ended.error}. Run \`pcc end\` again.`
    );
  }
  const summary = compactMilestoneDetail(stopped.summary, 180);
  return formatMilestoneText(
    "done",
    `Ended global session ${session.id}. ${summary || "Debrief summary captured."}`
  );
}

async function maybeHandleSlackOperatorCommand(params: {
  operatorV1Enabled?: boolean;
  teamId: string;
  channelId: string;
  channelType: string | null;
  userId: string;
  threadTs: string | null;
  eventType: string;
  eventTs: string | null;
  text: string;
  conversation: SlackConversationRow;
}): Promise<boolean> {
  if (!params.operatorV1Enabled) return false;
  if (
    !isSlackOperatorCommandContext({
      eventType: params.eventType,
      channelType: params.channelType,
      threadTs: params.threadTs,
    })
  ) {
    return false;
  }

  const parsed = parseSlackOperatorCommand(params.text);
  if (parsed.type === "none") return false;

  let responseText: string;
  if (parsed.type === "ambiguous") {
    const commands = SLACK_OPERATOR_COMMANDS.map((command) => `pcc ${command}`).join(", ");
    responseText = formatMilestoneText(
      "blocked",
      `I couldn't parse that command. Use one of: ${commands}. If this is a natural-language request, resend without the \`pcc\` prefix.`
    );
  } else {
    const actionability = resolveSlackActionability({
      teamId: params.teamId,
      userId: params.userId,
    });
    if (!actionability.allowed) {
      responseText = formatMilestoneText("blocked", buildActionabilityBlockedMessage(actionability));
    } else {
      responseText = executeSlackOperatorCommand(parsed.command);
    }
  }

  const correlationId = params.eventTs ?? `evt-${Date.now()}`;
  const messageKey = `command:${correlationId}`;
  const sendResult = await sendSlackMessage({
    team_id: params.teamId,
    channel_id: params.channelId,
    user_id: params.userId,
    text: responseText,
    thread_ts: params.threadTs,
    conversation_id: params.conversation.id,
    project_id: params.conversation.project_id,
    message_key: messageKey,
  });
  if (!sendResult.ok) {
    logSlackOperatorBridge(
      "command_response_send_failed",
      {
        correlation_id: correlationId,
        conversation_id: params.conversation.id,
        communication_id: null,
        global_session_id: params.conversation.global_session_id,
        project_id: params.conversation.project_id,
        error: sendResult.error ?? "Slack send failed",
      },
      "error"
    );
  }
  return true;
}

async function processSlackMessageEvent(params: {
  envelope: SlackEnvelope;
  event: SlackEvent;
  operatorV1Enabled?: boolean;
}): Promise<void> {
  if (params.event.bot_id || params.event.bot_profile) return;
  if (params.event.subtype) return;
  const teamId = params.envelope.team_id ?? null;
  if (!teamId) return;
  const channelId = readString(params.event.channel);
  const channelType = readString(params.event.channel_type);
  const userId = readString(params.event.user);
  const rawText = readString(params.event.text) ?? "";
  const text = stripSlackMentions(rawText);
  if (!channelId || !userId || !text) return;

  const threadTsRaw =
    readString(params.event.thread_ts) ??
    (params.event.type === "app_mention" ? readString(params.event.ts) : null);
  const threadTs = threadTsRaw ?? null;
  const eventTs = readString(params.event.ts);
  if (
    eventTs &&
    hasSlackConversationMessageForEvent({
      team_id: teamId,
      channel_id: channelId,
      user_id: userId,
      thread_ts: threadTs,
      slack_ts: eventTs,
    })
  ) {
    return;
  }

  const timeoutMinutes = getSlackConversationTimeoutMinutes();
  let conversation = findActiveSlackConversation({
    team_id: teamId,
    channel_id: channelId,
    user_id: userId,
    thread_ts: threadTs,
  });

  const isChannelMessage = params.event.type === "message" && channelType !== "im";

  if (conversation) {
    const lastMs = Date.parse(conversation.last_message_at);
    if (Number.isFinite(lastMs)) {
      const isStale = Date.now() - lastMs > timeoutMinutes * 60_000;
      if (isStale) {
        await finalizeConversation({
          conversation,
          ended_at: nowIso(),
          reason: "timeout",
          operatorV1Enabled: params.operatorV1Enabled,
        });
        conversation = null;
      }
    }
  }

  if (isChannelMessage && !conversation) {
    return;
  }

  const startedAt = slackTsToIso(eventTs ?? "") ?? nowIso();
  const detectedProjectId = detectProjectIdFromText(text);
  const created = conversation
    ? null
    : createSlackConversation({
        team_id: teamId,
        channel_id: channelId,
        user_id: userId,
        thread_ts: threadTs,
        project_id: detectedProjectId,
        started_at: startedAt,
        last_message_at: startedAt,
      });
  if (created) conversation = created;
  if (!conversation) return;

  if (!conversation.project_id && detectedProjectId) {
    updateSlackConversation({
      id: conversation.id,
      project_id: detectedProjectId,
    });
  }

  const createdAt = slackTsToIso(eventTs ?? "") ?? nowIso();
  recordSlackConversationMessage({
    conversation_id: conversation.id,
    role: "user",
    content: text,
    slack_ts: eventTs ?? null,
    created_at: createdAt,
  });

  const commandHandled = await maybeHandleSlackOperatorCommand({
    operatorV1Enabled: params.operatorV1Enabled,
    teamId,
    channelId,
    channelType,
    userId,
    threadTs,
    eventType: params.event.type,
    eventTs,
    text,
    conversation,
  });
  if (commandHandled) return;

  const endReason = classifyConversationEnd(text);
  if (endReason) {
    const finalizeResult = await finalizeConversation({
      conversation,
      ended_at: nowIso(),
      reason: endReason,
      operatorV1Enabled: params.operatorV1Enabled,
    });
    if (finalizeResult.forwardedToGlobal) {
      await sendSlackMessage({
        team_id: teamId,
        channel_id: channelId,
        user_id: userId,
        text: "Closing this conversation and passing context to the global agent.",
        thread_ts: threadTs,
        conversation_id: conversation.id,
        project_id: detectedProjectId ?? conversation.project_id ?? null,
      });
    }
    return;
  }

  if (created) {
    await sendSlackMessage({
      team_id: teamId,
      channel_id: channelId,
      user_id: userId,
      text: "Got it. Share more details, or say \"done\" to wrap up.",
      thread_ts: threadTs,
      conversation_id: conversation.id,
      project_id: detectedProjectId ?? conversation.project_id ?? null,
    });
  }
}

async function processSlackReactionEvent(params: {
  envelope: SlackEnvelope;
  event: SlackEvent;
}): Promise<void> {
  const teamId = params.envelope.team_id ?? null;
  if (!teamId) return;
  const reaction = readString(params.event.reaction);
  if (!reaction) return;
  if (reaction !== SLACK_APPROVE_REACTION && reaction !== SLACK_DENY_REACTION) return;

  const reactingUserId = readString(params.event.user);
  const item = asRecord(params.event.item);
  if (!reactingUserId || !item) return;
  if (readString(item.type) !== "message") return;

  const channelId = readString(item.channel);
  const messageTs = readString(item.ts);
  if (!channelId || !messageTs) return;

  const matchedRequests = listSlackActionRequestsByApprovalMessage({
    team_id: teamId,
    channel_id: channelId,
    approval_message_ts: messageTs,
  });
  if (!matchedRequests.length) {
    logSlackApprovalEvent("reaction_ignored_no_matching_request", {
      team_id: teamId,
      channel_id: channelId,
      approval_message_ts: messageTs,
      reaction,
      reacting_user_id: reactingUserId,
    });
    return;
  }

  if (matchedRequests.length > 1) {
    for (const request of matchedRequests) {
      if (isSlackActionRequestTerminalStatus(request.status)) continue;
      const failed = markSlackActionRequestFailedSafely({
        actionRequestId: request.id,
        error: "approval message correlation is ambiguous",
        expectedCurrentStatus: ["pending_approval", "approved"],
      });
      if (!failed) {
        logSlackApprovalEvent("reaction_correlation_ambiguous_request_preserved", {
          action_request_id: request.id,
          current_status: request.status,
        });
      }
    }
    logSlackApprovalEvent(
      "reaction_correlation_ambiguous",
      {
        team_id: teamId,
        channel_id: channelId,
        approval_message_ts: messageTs,
        matched_request_ids: matchedRequests.map((request) => request.id),
      },
      "error"
    );
    return;
  }

  const actionRequest = matchedRequests[0];
  if (isSlackActionRequestTerminalStatus(actionRequest.status)) {
    logSlackApprovalEvent("reaction_ignored_terminal_request", {
      action_request_id: actionRequest.id,
      status: actionRequest.status,
      reaction,
      reacting_user_id: reactingUserId,
    });
    return;
  }
  if (actionRequest.status !== "pending_approval") {
    logSlackApprovalEvent("reaction_ignored_non_pending_request", {
      action_request_id: actionRequest.id,
      status: actionRequest.status,
      reaction,
      reacting_user_id: reactingUserId,
    });
    return;
  }

  const approverAuth = resolveSlackApproverAuthorization({
    teamId,
    userId: reactingUserId,
  });
  if (!approverAuth.allowed) {
    logSlackApprovalEvent("reaction_ignored_unauthorized_actor", {
      action_request_id: actionRequest.id,
      reaction,
      reacting_user_id: reactingUserId,
      reason: approverAuth.reason,
      actor_person_id: approverAuth.actorPersonId,
    });
    return;
  }

  const decisionAt = nowIso();
  if (isSlackActionRequestExpired(actionRequest)) {
    const expired = updateSlackActionRequest({
      id: actionRequest.id,
      status: "expired",
      decision_reaction: reaction,
      decided_by_slack_user_id: reactingUserId,
      decided_by_person_id: approverAuth.actorPersonId,
      decision_at: decisionAt,
      error: "approval expired before execution",
      expected_current_status: "pending_approval",
    });
    if (!expired) {
      const latest = getSlackActionRequestById(actionRequest.id);
      logSlackApprovalEvent("request_expire_transition_raced", {
        action_request_id: actionRequest.id,
        correlation_id: actionRequest.correlation_id,
        current_status: latest?.status ?? null,
      });
      return;
    }
    logSlackApprovalEvent("request_expired", {
      action_request_id: actionRequest.id,
      correlation_id: actionRequest.correlation_id,
      reacting_user_id: reactingUserId,
    });
    return;
  }

  if (reaction === SLACK_DENY_REACTION) {
    const denied = updateSlackActionRequest({
      id: actionRequest.id,
      status: "denied",
      decision_reaction: reaction,
      decided_by_slack_user_id: reactingUserId,
      decided_by_person_id: approverAuth.actorPersonId,
      decision_at: decisionAt,
      error: null,
      expected_current_status: "pending_approval",
    });
    if (!denied) {
      const latest = getSlackActionRequestById(actionRequest.id);
      logSlackApprovalEvent("request_denial_transition_raced", {
        action_request_id: actionRequest.id,
        correlation_id: actionRequest.correlation_id,
        current_status: latest?.status ?? null,
      });
      return;
    }
    logSlackApprovalEvent("request_denied", {
      action_request_id: actionRequest.id,
      correlation_id: actionRequest.correlation_id,
      reacting_user_id: reactingUserId,
      approver_person_id: approverAuth.actorPersonId,
    });
    return;
  }

  const approved = updateSlackActionRequest({
    id: actionRequest.id,
    status: "approved",
    decision_reaction: reaction,
    decided_by_slack_user_id: reactingUserId,
    decided_by_person_id: approverAuth.actorPersonId,
    decision_at: decisionAt,
    error: null,
    expected_current_status: "pending_approval",
  });
  if (!approved) {
    const latest = getSlackActionRequestById(actionRequest.id);
    logSlackApprovalEvent("request_approval_transition_raced", {
      action_request_id: actionRequest.id,
      correlation_id: actionRequest.correlation_id,
      reaction,
      reacting_user_id: reactingUserId,
      current_status: latest?.status ?? null,
    });
    return;
  }
  if (isSlackActionRequestExpired(approved)) {
    const expiredAfterApproval = updateSlackActionRequest({
      id: approved.id,
      status: "expired",
      error: "approval expired before execution",
      expected_current_status: "approved",
    });
    if (!expiredAfterApproval) {
      const latest = getSlackActionRequestById(approved.id);
      logSlackApprovalEvent("request_expired_after_approval_transition_raced", {
        action_request_id: approved.id,
        correlation_id: approved.correlation_id,
        current_status: latest?.status ?? null,
      });
      return;
    }
    logSlackApprovalEvent("request_expired_after_approval", {
      action_request_id: approved.id,
      correlation_id: approved.correlation_id,
    });
    return;
  }

  const conversation = getSlackConversationById(approved.conversation_id);
  if (!conversation) {
    markSlackActionRequestFailedSafely({
      actionRequestId: approved.id,
      error: "missing Slack conversation for approved request",
    });
    logSlackApprovalEvent(
      "approved_request_missing_conversation",
      { action_request_id: approved.id },
      "error"
    );
    return;
  }

  const projectId = approved.project_id ?? conversation.project_id ?? resolveDefaultProjectId();
  if (!projectId) {
    markSlackActionRequestFailedSafely({
      actionRequestId: approved.id,
      error: "missing project id for approved request",
    });
    updateSlackConversation({
      id: conversation.id,
      status: "ended",
      ended_at: nowIso(),
      global_session_id: null,
    });
    return;
  }

  await maybeRolloverStaleDebriefSessionForActionableSlackRequest({
    conversation,
    staleMinutes: getSlackStaleDebriefMinutes(),
    correlationId: approved.correlation_id,
  });

  const executing = transitionApprovedSlackActionRequestToExecution({
    id: approved.id,
    executing_at: nowIso(),
  });
  if (!executing) {
    const latest = getSlackActionRequestById(approved.id);
    logSlackApprovalEvent("request_execution_transition_raced", {
      action_request_id: approved.id,
      correlation_id: approved.correlation_id,
      current_status: latest?.status ?? null,
    });
    return;
  }
  if (executing.status === "expired") {
    logSlackApprovalEvent("request_expired_before_execution", {
      action_request_id: executing.id,
      correlation_id: executing.correlation_id,
    });
    return;
  }
  if (executing.status !== "executing") {
    logSlackApprovalEvent(
      "request_execution_transition_invalid_status",
      {
        action_request_id: approved.id,
        correlation_id: approved.correlation_id,
        status: executing.status,
      },
      "error"
    );
    return;
  }

  const execution = await executeOperatorV1ActionableRequest({
    conversation,
    projectId,
    intent: approved.intent,
    summary: approved.request_summary,
    body: approved.request_body,
    payload: approved.communication_payload,
    correlationId: approved.correlation_id,
  });
  if (!execution.ok) {
    markSlackActionRequestFailedSafely({
      actionRequestId: approved.id,
      error: execution.error,
    });
    updateSlackConversation({
      id: conversation.id,
      status: "ended",
      project_id: projectId,
      ended_at: nowIso(),
      global_session_id: execution.sessionId,
    });
    return;
  }

  updateSlackConversation({
    id: conversation.id,
    status: "processed",
    project_id: projectId,
    ended_at: conversation.ended_at ?? nowIso(),
    processed_at: nowIso(),
    global_shift_id: execution.shiftId,
    global_session_id: execution.sessionId,
  });
  updateSlackActionRequest({
    id: approved.id,
    status: "completed",
    completed_at: nowIso(),
    communication_id: execution.communicationId,
    global_session_id: execution.sessionId,
    global_shift_id: execution.shiftId,
    error: null,
  });
  logSlackApprovalEvent("request_completed", {
    action_request_id: approved.id,
    correlation_id: approved.correlation_id,
    communication_id: execution.communicationId,
    global_session_id: execution.sessionId,
    global_shift_id: execution.shiftId,
  });
}

ensureSlackMilestoneListenerRegistered();

export function buildSlackInstallUrl(): { ok: boolean; url?: string; error?: string } {
  const clientId = getSlackClientId();
  if (!clientId) {
    return { ok: false, error: "Slack client id not configured" };
  }
  const scopes = getSlackScopes();
  let state: string;
  try {
    state = createSlackOAuthState();
  } catch (err) {
    console.warn("[slack] failed to create OAuth state", err);
    return { ok: false, error: "Slack OAuth state unavailable" };
  }
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("scope", scopes.join(","));
  params.set("state", state);
  const redirectUri = getSlackRedirectUri();
  if (redirectUri) params.set("redirect_uri", redirectUri);
  return { ok: true, url: `https://slack.com/oauth/v2/authorize?${params}` };
}

export async function exchangeSlackOAuthCode(
  code: string
): Promise<{ ok: boolean; installation?: SlackInstallationRow; error?: string }> {
  const clientId = getSlackClientId();
  const clientSecret = getSlackClientSecret();
  if (!clientId || !clientSecret) {
    return { ok: false, error: "Slack OAuth credentials not configured" };
  }
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  params.set("code", code);
  const redirectUri = getSlackRedirectUri();
  if (redirectUri) params.set("redirect_uri", redirectUri);

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = (await res.json().catch(() => null)) as SlackApiResponse | null;
  if (!data || !data.ok) {
    return { ok: false, error: data?.error ?? "Slack OAuth failed" };
  }
  const team = asRecord(data.team);
  const teamId = readString(team?.id);
  const teamName = readString(team?.name);
  const botToken = readString(data.access_token);
  const botUserId = readString(data.bot_user_id);
  const scope = readString(data.scope);
  if (!teamId || !botToken) {
    return { ok: false, error: "Slack OAuth response missing team or token" };
  }
  const installation = upsertSlackInstallation({
    team_id: teamId,
    team_name: teamName ?? null,
    bot_user_id: botUserId ?? null,
    bot_token: botToken,
    scope: scope ?? null,
  });
  return { ok: true, installation };
}

export function verifySlackOAuthState(
  state: string
): { ok: boolean; error?: string } {
  return consumeSlackOAuthState(state);
}

export function verifySlackSignature(params: {
  rawBody: Buffer;
  timestamp: string | null;
  signature: string | null;
}): SlackSignatureVerification {
  const signingSecret = getSlackSigningSecret();
  if (!signingSecret) return { ok: false, error: "Slack signing secret not configured" };
  if (!params.timestamp || !params.signature) {
    return { ok: false, error: "missing Slack signature headers" };
  }
  const timestamp = Number(params.timestamp);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: "invalid Slack timestamp" };
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > 60 * 5) {
    return { ok: false, error: "Slack request timestamp out of range" };
  }
  const base = `v0:${params.timestamp}:${params.rawBody.toString("utf8")}`;
  const digest = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${digest}`;
  if (!timingSafeEqualString(expected, params.signature)) {
    return { ok: false, error: "invalid Slack signature" };
  }
  return { ok: true };
}

async function handleSlackEventEnvelopeByMode(
  payload: unknown,
  operatorV1Enabled: boolean
): Promise<SlackEventResult> {
  const envelope = asRecord(payload);
  if (!envelope) return { status: 400, body: { error: "invalid payload" } };
  const type = readString(envelope.type);
  if (!type) return { status: 400, body: { error: "missing event type" } };
  if (type === "url_verification") {
    const challenge = readString(envelope.challenge);
    if (!challenge) return { status: 400, body: { error: "missing challenge" } };
    return { status: 200, body: { challenge } };
  }
  if (type !== "event_callback") {
    return { status: 200, body: { ok: true } };
  }
  const event = asRecord(envelope.event);
  if (!event) return { status: 400, body: { error: "missing event payload" } };
  const eventType = readString(event.type);
  if (!eventType) return { status: 200, body: { ok: true } };
  if (eventType === "message" || eventType === "app_mention") {
    await processSlackMessageEvent({
      envelope: {
        type,
        challenge: readString(envelope.challenge) ?? undefined,
        team_id: readString(envelope.team_id) ?? undefined,
        event,
      },
      event: event as SlackEvent,
      operatorV1Enabled,
    });
  } else if (operatorV1Enabled && eventType === "reaction_added") {
    await processSlackReactionEvent({
      envelope: {
        type,
        challenge: readString(envelope.challenge) ?? undefined,
        team_id: readString(envelope.team_id) ?? undefined,
        event,
      },
      event: event as SlackEvent,
    });
  }
  return { status: 200, body: { ok: true } };
}

async function handleSlackEventEnvelopeLegacy(payload: unknown): Promise<SlackEventResult> {
  return handleSlackEventEnvelopeByMode(payload, false);
}

async function handleSlackEventEnvelopeV1(payload: unknown): Promise<SlackEventResult> {
  return handleSlackEventEnvelopeByMode(payload, true);
}

export async function handleSlackEventEnvelope(
  payload: unknown,
  options?: HandleSlackEventEnvelopeOptions
): Promise<SlackEventResult> {
  if (options?.operatorV1Enabled) {
    return handleSlackEventEnvelopeV1(payload);
  }
  return handleSlackEventEnvelopeLegacy(payload);
}

export async function sendSlackMessage(params: {
  team_id?: string | null;
  channel_id?: string | null;
  user_id: string;
  text: string;
  thread_ts?: string | null;
  project_id?: string | null;
  conversation_id?: string | null;
  message_key?: string | null;
  force_dm?: boolean;
}): Promise<SlackMessageSendResult> {
  const conversation =
    params.conversation_id ? getSlackConversationById(params.conversation_id) : null;
  const messageKey = readString(params.message_key) ?? null;
  if (conversation && messageKey) {
    const existing = getSlackConversationMessageByKey({
      conversation_id: conversation.id,
      message_key: messageKey,
    });
    if (existing) {
      return { ok: true, conversation, message: existing };
    }
  }
  const teamId = params.team_id ?? conversation?.slack_team_id ?? null;
  const installation = resolveSlackInstallation(teamId);
  if (!installation) {
    return { ok: false, error: "Slack installation not found" };
  }
  const userId = params.user_id;
  if (!userId) return { ok: false, error: "Slack user id required" };

  let channelId = params.force_dm ? null : params.channel_id ?? conversation?.slack_channel_id ?? null;
  if (!channelId) {
    channelId = await openSlackDm(installation.bot_token, userId);
  }
  if (!channelId) {
    return { ok: false, error: "Slack channel not resolved" };
  }

  const threadTs = params.force_dm ? null : params.thread_ts ?? conversation?.slack_thread_ts ?? null;
  const response = await callSlackApi(installation.bot_token, "chat.postMessage", {
    channel: channelId,
    text: params.text,
    thread_ts: threadTs ?? undefined,
  });
  if (!response.ok) {
    return { ok: false, error: response.error ?? "Slack send failed" };
  }
  const slackTs = readString(response.ts) ?? null;

  let activeConversation = conversation;
  if (!activeConversation) {
    activeConversation =
      findActiveSlackConversation({
        team_id: installation.team_id,
        channel_id: channelId,
        user_id: userId,
        thread_ts: threadTs,
      }) ??
      createSlackConversation({
        team_id: installation.team_id,
        channel_id: channelId,
        user_id: userId,
        thread_ts: threadTs,
        project_id: params.project_id ?? null,
        started_at: nowIso(),
        last_message_at: nowIso(),
      });
  }

  if (
    activeConversation &&
    !threadTs &&
    slackTs &&
    !activeConversation.slack_thread_ts &&
    !isDirectMessageChannelId(channelId)
  ) {
    const updated = updateSlackConversation({
      id: activeConversation.id,
      slack_thread_ts: slackTs,
    });
    if (updated) {
      activeConversation = updated;
    }
  }

  const message = recordSlackConversationMessage({
    conversation_id: activeConversation.id,
    role: "assistant",
    content: params.text,
    slack_ts: slackTs,
    message_key: messageKey,
    created_at: nowIso(),
  });

  return { ok: true, slack_ts: slackTs ?? undefined, conversation: activeConversation, message };
}

export async function expireSlackConversations(options?: {
  operatorV1Enabled?: boolean;
}): Promise<number> {
  const timeoutMinutes = getSlackConversationTimeoutMinutes();
  const stale = listStaleSlackConversations(timeoutMinutes);
  for (const conversation of stale) {
    await finalizeConversation({
      conversation,
      ended_at: nowIso(),
      reason: "timeout",
      operatorV1Enabled: options?.operatorV1Enabled,
    });
  }
  return stale.length;
}
