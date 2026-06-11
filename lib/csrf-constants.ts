/**
 * Shared CSRF constants for the Next.js layer (middleware.ts and lib/proxy-guard.ts).
 *
 * This file is the single source of truth for values used on the Next.js side.
 * The Express server (server/index.ts) cannot import from lib/ because its
 * tsconfig rootDir is scoped to server/.  The equivalent exported constant in
 * server/config.ts (DEFAULT_DEV_PORTS) must be kept in sync with the value here.
 *
 * IMPORTANT: if you change DEFAULT_DEV_PORTS here, also update it in server/config.ts.
 */

/** HTTP methods that carry side effects — the only ones subject to CSRF checks. */
export const MUTABLE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Default UI dev-server ports on loopback.
 * Must match the value in server/config.ts DEFAULT_DEV_PORTS.
 */
export const DEFAULT_DEV_PORTS: readonly number[] = [3000, 3010, 3011, 3012, 3013];

/**
 * Expand the dev-port list into full origin strings (both localhost and 127.0.0.1
 * variants) that are always permitted.
 */
export const DEFAULT_ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>(
  DEFAULT_DEV_PORTS.flatMap((p) => [
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
  ])
);

/**
 * Read SHIFTBOSS_ALLOWED_ORIGINS with legacy-prefix fallbacks.
 *
 * The server uses readEnv() from server/config.ts for this, but that module
 * cannot be imported in the Next.js edge runtime.  This helper replicates
 * the three-prefix check (canonical + two legacy prefixes) for the Next.js side.
 *
 * If you add a new legacy prefix to server/config.ts LEGACY_ENV_PREFIXES,
 * add it here too.
 */
export function readAllowedOriginsEnv(): string {
  return (
    process.env.SHIFTBOSS_ALLOWED_ORIGINS ||
    process.env.CONTROL_CENTER_ALLOWED_ORIGINS ||
    process.env.PCC_ALLOWED_ORIGINS ||
    ""
  );
}
