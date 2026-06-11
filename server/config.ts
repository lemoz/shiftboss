import fs from "fs";
import path from "path";

export type PccMode = "local" | "cloud";

const STARTED_AT_MS = Date.now();
const VERSION = resolveVersion();
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

const CANONICAL_ENV_PREFIX = "SHIFTBOSS_";
const LEGACY_ENV_PREFIXES = ["CONTROL_CENTER_", "PCC_"];

/**
 * Read an environment variable by its canonical SHIFTBOSS_* name.
 * Falls back to the same suffix under the legacy CONTROL_CENTER_* and PCC_*
 * prefixes, then to any explicitly provided legacy names, so existing
 * deployments keep working without renaming variables.
 */
export function readEnv(name: string, ...legacyNames: string[]): string | undefined {
  const candidates: string[] = [name];
  if (name.startsWith(CANONICAL_ENV_PREFIX)) {
    const suffix = name.slice(CANONICAL_ENV_PREFIX.length);
    for (const prefix of LEGACY_ENV_PREFIXES) {
      candidates.push(prefix + suffix);
    }
  }
  candidates.push(...legacyNames);
  for (const candidate of candidates) {
    const raw = process.env[candidate];
    if (raw !== undefined && raw !== "") return raw;
  }
  return undefined;
}

function resolveMode(): PccMode {
  const raw = (readEnv("SHIFTBOSS_MODE") || "").trim().toLowerCase();
  if (raw === "cloud") return "cloud";
  return "local";
}

function parseEnvList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

function trimEnvValue(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

let warnedLegacyDatabaseFile = false;

function resolveDatabasePath(): string {
  // Preserve pre-rename precedence: SHIFTBOSS_DB_PATH > PCC_DATABASE_PATH >
  // CONTROL_CENTER_DB_PATH. readEnv auto-inserts legacy prefixes (including
  // CONTROL_CENTER_) before explicit legacyNames, which would flip the order
  // for the two legacy vars — so we read them explicitly instead.
  const raw = (
    process.env.SHIFTBOSS_DB_PATH ||
    process.env.PCC_DATABASE_PATH ||
    process.env.CONTROL_CENTER_DB_PATH ||
    ""
  ).trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  const preferred = path.join(process.cwd(), "shiftboss.db");
  const legacy = path.join(process.cwd(), "control-center.db");
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    if (!warnedLegacyDatabaseFile) {
      warnedLegacyDatabaseFile = true;
      console.log(
        `[config] using legacy database file ${legacy} (rename it to shiftboss.db to silence this notice)`
      );
    }
    return legacy;
  }
  return preferred;
}

function resolveReposPath(): string | null {
  const raw = (readEnv("SHIFTBOSS_REPOS_PATH") || "").trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function resolveVersion(): string {
  const npmVersion = (process.env.npm_package_version || "").trim();
  if (npmVersion) return npmVersion;
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // ignore
  }
  return "unknown";
}

export function getPccMode(): PccMode {
  return resolveMode();
}

export function getDatabasePath(): string {
  return resolveDatabasePath();
}

export function getReposPath(): string | null {
  return resolveReposPath();
}

export function getAppVersion(): string {
  return VERSION;
}

export function getServerStartedAt(): number {
  return STARTED_AT_MS;
}

export function getServerUptimeSeconds(): number {
  return Math.max(0, Math.floor((Date.now() - getServerStartedAt()) / 1000));
}

export function getServerPort(): number {
  return parseNumberEnv(readEnv("SHIFTBOSS_PORT"), 4010);
}

export function getServerHost(): string {
  const raw = (readEnv("SHIFTBOSS_HOST") || "127.0.0.1").trim();
  return raw || "127.0.0.1";
}

export function getAllowLan(): boolean {
  return isTruthyEnv(readEnv("SHIFTBOSS_ALLOW_LAN"));
}

export function getAllowRemoteHealth(): boolean {
  return isTruthyEnv(readEnv("SHIFTBOSS_ALLOW_REMOTE_HEALTH"));
}

export function getHealthToken(): string {
  return (readEnv("SHIFTBOSS_HEALTH_TOKEN") || "").trim();
}

export function getEscalationTimeoutHours(): number {
  const raw = process.env.ESCALATION_TIMEOUT_HOURS;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 24;
}

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "workspace-write-whitelist"
  | "danger-full-access";

/**
 * Get the sandbox mode for builder agents.
 * Controlled by SHIFTBOSS_BUILDER_SANDBOX env var (legacy: PCC_BUILDER_SANDBOX).
 * Options: "read-only", "workspace-write", "workspace-write-whitelist", "danger-full-access"
 * Default: "workspace-write"
 *
 * Use "danger-full-access" when stream monitoring is enabled to allow
 * builders to access localhost APIs and write outside the worktree.
 */
export function getBuilderSandboxMode(): SandboxMode {
  const raw = (readEnv("SHIFTBOSS_BUILDER_SANDBOX") || "").trim().toLowerCase();
  if (raw === "danger-full-access" || raw === "full-access" || raw === "none") {
    return "danger-full-access";
  }
  if (raw === "workspace-write-whitelist") {
    return "workspace-write-whitelist";
  }
  if (raw === "read-only") {
    return "read-only";
  }
  return "workspace-write";
}

/**
 * Get the sandbox mode for reviewer agents.
 * Controlled by SHIFTBOSS_REVIEWER_SANDBOX env var (legacy: PCC_REVIEWER_SANDBOX).
 * Options: "read-only", "workspace-write", "danger-full-access"
 * Default: "read-only"
 */
export function getReviewerSandboxMode(): SandboxMode {
  const raw = (readEnv("SHIFTBOSS_REVIEWER_SANDBOX") || "").trim().toLowerCase();
  if (raw === "danger-full-access" || raw === "full-access" || raw === "none") {
    return "danger-full-access";
  }
  if (raw === "workspace-write") {
    return "workspace-write";
  }
  return "read-only";
}

export function getCorsAllowAllRequested(): boolean {
  return isTruthyEnv(readEnv("SHIFTBOSS_CORS_ALLOW_ALL"));
}

export function getAllowedOrigins(): string[] {
  return parseEnvList(readEnv("SHIFTBOSS_ALLOWED_ORIGINS"));
}

/**
 * Default UI dev-server ports on loopback.
 *
 * IMPORTANT: this value must be kept in sync with DEFAULT_DEV_PORTS in
 * lib/csrf-constants.ts.  The Next.js layer cannot import from server/ so the
 * two files each carry their own copy; they are the same number.  A port
 * change requires updating both files.
 */
export const DEFAULT_DEV_PORTS: readonly number[] = [3000, 3010, 3011, 3012, 3013];

/**
 * HTTP methods that carry side effects — subject to CSRF checks.
 *
 * IMPORTANT: must be kept in sync with MUTABLE_METHODS in lib/csrf-constants.ts.
 * The Next.js layer cannot import from server/ so each side carries its own copy.
 */
export const MUTABLE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function getNodeEnv(): string {
  return (process.env.NODE_ENV || "").trim();
}

export function getNodeEnvLabel(): string {
  return getNodeEnv() || "unknown";
}

export function isProductionEnv(): boolean {
  return getNodeEnv() === "production";
}

export function getFailRunsOnRestart(): boolean {
  return isTruthyEnv(readEnv("SHIFTBOSS_FAIL_IN_PROGRESS_ON_RESTART"));
}

// ---------------------------------------------------------------------------
// Agent execution timeouts
// ---------------------------------------------------------------------------
// All values are in seconds; the helper converts to milliseconds for callers.

const DEFAULT_BUILDER_TIMEOUT_SEC = 45 * 60; // 45 min
const DEFAULT_TEST_TIMEOUT_SEC = 20 * 60;    // 20 min
const DEFAULT_REVIEWER_TIMEOUT_SEC = 15 * 60; // 15 min
const DEFAULT_GLOBAL_AGENT_TIMEOUT_SEC = 60;   // 60 s (matches existing helper convention)

function parseTimeoutSec(
  raw: string | undefined,
  fallbackSec: number
): number {
  if (!raw) return fallbackSec;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSec;
}

/** Timeout for codex builder CLI exec (ms). */
export function getBuilderTimeoutMs(): number {
  return (
    parseTimeoutSec(readEnv("SHIFTBOSS_BUILDER_TIMEOUT_SEC"), DEFAULT_BUILDER_TIMEOUT_SEC) * 1000
  );
}

/** Timeout for npm-test subprocess (ms). */
export function getTestTimeoutMs(): number {
  return (
    parseTimeoutSec(readEnv("SHIFTBOSS_TEST_TIMEOUT_SEC"), DEFAULT_TEST_TIMEOUT_SEC) * 1000
  );
}

/** Timeout for codex reviewer CLI exec (ms). */
export function getReviewerTimeoutMs(): number {
  return (
    parseTimeoutSec(readEnv("SHIFTBOSS_REVIEWER_TIMEOUT_SEC"), DEFAULT_REVIEWER_TIMEOUT_SEC) * 1000
  );
}

/** Timeout for global-agent decideWithClaude calls (ms). */
export function getGlobalAgentDecideTimeoutMs(): number {
  return (
    parseTimeoutSec(
      readEnv("SHIFTBOSS_GLOBAL_AGENT_TIMEOUT_SEC"),
      DEFAULT_GLOBAL_AGENT_TIMEOUT_SEC
    ) * 1000
  );
}

export function getElevenLabsWebhookSecret(): string | null {
  const raw = readEnv("SHIFTBOSS_ELEVENLABS_WEBHOOK_SECRET");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function getElevenLabsAgentId(): string | null {
  const raw =
    readEnv("SHIFTBOSS_ELEVENLABS_AGENT_ID") ||
    process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function getElevenLabsApiKey(): string | null {
  const raw =
    readEnv("SHIFTBOSS_ELEVENLABS_API_KEY") || process.env.ELEVENLABS_API_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function getTwilioAccountSid(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_TWILIO_ACCOUNT_SID"));
}

export function getTwilioAuthToken(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_TWILIO_AUTH_TOKEN"));
}

export function getTwilioPhoneNumber(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_TWILIO_PHONE_NUMBER"));
}

export function getTwilioVerifySignature(): boolean {
  const raw = readEnv("SHIFTBOSS_TWILIO_VERIFY_SIGNATURE");
  if (raw === undefined) return true;
  return isTruthyEnv(raw);
}

export function getSmsMonthlyBudgetCents(): number {
  const raw = readEnv("SHIFTBOSS_SMS_MONTHLY_BUDGET_CENTS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function getSmsRateLimitPerHour(): number {
  const raw = readEnv("SHIFTBOSS_SMS_RATE_LIMIT_PER_HOUR");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 30;
}

export function getSmsMessageCostCents(): number {
  const raw = readEnv("SHIFTBOSS_SMS_MESSAGE_COST_CENTS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function getSmsConversationTimeoutMinutes(): number {
  const raw = readEnv("SHIFTBOSS_SMS_CONVERSATION_TIMEOUT_MINUTES");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 30;
}

export function getElevenLabsSignedUrlTtlSeconds(): number | null {
  const raw = readEnv("SHIFTBOSS_ELEVENLABS_SIGNED_URL_TTL_SECONDS");
  const parsed = raw === undefined ? 300 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function getSlackClientId(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SLACK_CLIENT_ID"));
}

export function getSlackClientSecret(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SLACK_CLIENT_SECRET"));
}

export function getSlackSigningSecret(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SLACK_SIGNING_SECRET"));
}

export function getSlackRedirectUri(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SLACK_REDIRECT_URI"));
}

export function getSlackScopes(): string[] {
  const scopes = parseEnvList(readEnv("SHIFTBOSS_SLACK_SCOPES"));
  if (scopes.length) return scopes;
  return [
    "chat:write",
    "im:history",
    "im:write",
    "app_mentions:read",
    "channels:history",
  ];
}

export function getSlackConversationTimeoutMinutes(): number {
  return parseNumberEnv(readEnv("SHIFTBOSS_SLACK_CONVERSATION_TIMEOUT_MINUTES"), 10);
}

export function getSlackStaleDebriefMinutes(): number {
  return parseNumberEnv(readEnv("SHIFTBOSS_SLACK_STALE_DEBRIEF_MINUTES"), 30);
}

export function getSlackApprovalTtlMinutes(): number {
  return parseNumberEnv(readEnv("SHIFTBOSS_SLACK_APPROVAL_TTL_MINUTES"), 30);
}

export function getSlackOperatorV1Enabled(): boolean {
  return isTruthyEnv(readEnv("SHIFTBOSS_SLACK_OPERATOR_V1"));
}

function parseEnvUniqueList(value: string | undefined): string[] {
  const values = parseEnvList(value);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of values) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
  }
  return unique;
}

export function getSlackOperatorPersonIds(): string[] {
  return parseEnvUniqueList(readEnv("SHIFTBOSS_SLACK_OPERATOR_PERSON_IDS"));
}

export function getSlackApproverPersonIds(): string[] {
  return parseEnvUniqueList(readEnv("SHIFTBOSS_SLACK_APPROVER_PERSON_IDS"));
}

export function getScanRoots(): string[] {
  return parseEnvList(readEnv("SHIFTBOSS_SCAN_ROOTS"));
}

export function getScanIgnoreDirs(): string[] {
  return parseEnvList(readEnv("SHIFTBOSS_IGNORE_DIRS"));
}

export function getScanIgnoreDirsRemove(): string[] {
  return parseEnvList(readEnv("SHIFTBOSS_IGNORE_DIRS_REMOVE"));
}

export function getScanMaxDepth(): number {
  const raw = readEnv("SHIFTBOSS_SCAN_MAX_DEPTH");
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 4;
}

export function getHomeDir(): string {
  const raw = (process.env.HOME || "").trim();
  return raw || process.cwd();
}

export function getProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export function getEnvironmentVariableNames(): string[] {
  return Object.keys(process.env).sort();
}

export function getPathEnv(): string {
  return process.env.PATH ?? "";
}

export function getPathExtEnv(): string {
  return process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
}

export function getScanTtlMs(): number {
  const raw = readEnv("SHIFTBOSS_SCAN_TTL_MS");
  if (raw === undefined || raw === "") return 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

export function getControlCenterApiUrl(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_API_URL"));
}

export function getShiftClaudePath(): string {
  return trimEnvValue(readEnv("SHIFTBOSS_SHIFT_CLAUDE_PATH")) ?? "claude";
}

export function getShiftAllowedToolsOverride(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SHIFT_ALLOWED_TOOLS"));
}

export function getShiftModelOverride(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SHIFT_MODEL"));
}

export function getShiftPromptPathOverride(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_SHIFT_PROMPT_FILE"));
}

export function getCodexCliPathOverride(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_CODEX_PATH"));
}

export function getCodexCliPath(): string {
  return getCodexCliPathOverride() ?? "codex";
}

export function getClaudeCliPathOverride(): string | null {
  return trimEnvValue(readEnv("SHIFTBOSS_CLAUDE_PATH"));
}

export function getClaudeCliPath(): string {
  return getClaudeCliPathOverride() ?? "claude";
}

export function getCodexModelOverride(): string | undefined {
  const raw = readEnv("SHIFTBOSS_CODEX_MODEL") || process.env.CODEX_MODEL;
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function getChatCodexModelOverride(): string | undefined {
  const raw =
    readEnv("SHIFTBOSS_CHAT_CODEX_MODEL") ||
    readEnv("SHIFTBOSS_CODEX_MODEL") ||
    process.env.CODEX_MODEL;
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function getChatCodexPathOverride(): string | undefined {
  const raw =
    readEnv("SHIFTBOSS_CHAT_CODEX_PATH") ||
    readEnv("SHIFTBOSS_CODEX_PATH");
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function getChatTrustedHostsOverride(): string | undefined {
  const raw = readEnv("SHIFTBOSS_CHAT_TRUSTED_HOSTS");
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function getMaxBuilderIterationsOverride(): number | undefined {
  const raw =
    readEnv("SHIFTBOSS_MAX_BUILDER_ITERATIONS") ||
    readEnv("SHIFTBOSS_MAX_RUN_ITERATIONS");
  const parsed = raw ? Math.trunc(Number(raw)) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.min(parsed, 20);
  }
  return undefined;
}

export function getUtilityProviderOverride(): string | undefined {
  const trimmed = trimEnvValue(readEnv("SHIFTBOSS_UTILITY_PROVIDER"));
  return trimmed ?? undefined;
}

export function getUtilityModelOverride(): string | undefined {
  const trimmed = trimEnvValue(readEnv("SHIFTBOSS_UTILITY_MODEL"));
  return trimmed ?? undefined;
}

export function getChatSuggestionContextMessageLimit(): number {
  const raw = Number(readEnv("SHIFTBOSS_CHAT_SUGGESTION_CONTEXT_MESSAGES"));
  if (!Number.isFinite(raw)) return 10;
  const n = Math.trunc(raw);
  if (n <= 0) return 0;
  return Math.min(50, n);
}

export function getUseTsWorker(): boolean {
  return isTruthyEnv(readEnv("SHIFTBOSS_USE_TS_WORKER"));
}

export function getRemoteTestTimeoutSeconds(): number {
  return parseNumberEnv(
    readEnv("SHIFTBOSS_REMOTE_TEST_TIMEOUT_SEC"),
    900
  );
}

export function getOpenAiApiKey(): string | null {
  return trimEnvValue(process.env.OPENAI_API_KEY);
}

export function getGeminiApiKey(): string | null {
  const raw =
    readEnv("SHIFTBOSS_GEMINI_API_KEY") ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export function getElevenLabsNarrationVoiceId(): string | null {
  const raw =
    readEnv("SHIFTBOSS_ELEVENLABS_NARRATION_VOICE_ID") ||
    process.env.ELEVENLABS_NARRATION_VOICE_ID;
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export function getElevenLabsNarrationModelId(): string | null {
  const raw = readEnv("SHIFTBOSS_ELEVENLABS_NARRATION_MODEL_ID");
  const trimmed = raw ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export function getGlobalAgentMaxIterations(): number | undefined {
  const raw = readEnv("SHIFTBOSS_GLOBAL_MAX_ITERATIONS");
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  return undefined;
}

export function getGlobalAgentType(): string {
  return trimEnvValue(readEnv("SHIFTBOSS_GLOBAL_AGENT_TYPE")) ?? "claude_cli";
}

export function getGlobalAgentId(): string {
  return trimEnvValue(readEnv("SHIFTBOSS_GLOBAL_AGENT_ID")) ?? "global-agent";
}

export function getGlobalAgentSessionMaxIterations(): number | null {
  const raw = readEnv("SHIFTBOSS_GLOBAL_SESSION_MAX_ITERATIONS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function getGlobalAgentSessionMaxDurationMinutes(): number | null {
  const raw = readEnv("SHIFTBOSS_GLOBAL_SESSION_MAX_DURATION_MINUTES");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function getGlobalAgentSessionCheckInMinutes(): number | null {
  const raw = readEnv("SHIFTBOSS_GLOBAL_SESSION_CHECKIN_MINUTES");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function getGlobalAgentSessionCheckInDecisions(): number | null {
  const raw = readEnv("SHIFTBOSS_GLOBAL_SESSION_CHECKIN_DECISIONS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function getGlobalAttentionMaxProjects(): number | null {
  const raw = readEnv("SHIFTBOSS_GLOBAL_ATTENTION_MAX_PROJECTS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function getBudgetUsedTodayOverride(): number {
  const raw = readEnv("SHIFTBOSS_BUDGET_USED_TODAY");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
