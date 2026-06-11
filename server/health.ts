import {
  getAppVersion,
  getPccMode,
  getServerStartedAt,
  getServerUptimeSeconds,
} from "./config.js";

export type HealthResponse = {
  ok: true;
  status: "ok";
  version: string;
  uptime_seconds: number;
  started_at: string;
  mode: ReturnType<typeof getPccMode>;
  ts: string;
};

export function getHealthResponse(): HealthResponse {
  return {
    ok: true,
    status: "ok",
    version: getAppVersion(),
    uptime_seconds: getServerUptimeSeconds(),
    started_at: new Date(getServerStartedAt()).toISOString(),
    mode: getPccMode(),
    ts: new Date().toISOString(),
  };
}

/**
 * Validate the health token supplied in an incoming request against the
 * configured token.
 *
 * Fail-closed policy: if no token is configured, the function returns false so
 * that SHIFTBOSS_ALLOW_REMOTE_HEALTH=1 without a token denies access rather
 * than silently publishing operational data to unauthenticated callers.
 *
 * Loopback clients are never routed through this function — they are admitted
 * unconditionally by the network firewall middleware in index.ts.
 */
export function isValidHealthToken(
  configuredToken: string,
  queryToken: string,
  headerToken: string
): boolean {
  // Fail closed: if no token is configured, deny access.
  if (!configuredToken) return false;
  const qt = queryToken.trim();
  const ht = headerToken.trim();
  return qt === configuredToken || ht === configuredToken;
}
