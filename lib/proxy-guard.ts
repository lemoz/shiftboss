/**
 * Shared CSRF guard for Next.js API proxy routes.
 *
 * Two distinct threats are addressed here:
 *
 * 1. Cross-origin browser requests: a remote page can issue a "simple" POST
 *    with Content-Type: text/plain whose body is valid JSON.  The browser
 *    sends no preflight for simple requests, so CORS never blocks them, and
 *    the Next.js route handler receives and proxies the body upstream.
 *
 * 2. Content-type smuggling on JSON endpoints: even after (1) is closed,
 *    a cross-origin attacker might guess a route that accepts arbitrary
 *    content types.  Enforcing application/json kills the text/plain vector.
 *
 * How it works:
 *   - Sec-Fetch-Site present and !== 'same-origin' | 'none' → 403.
 *   - Origin present and not in SHIFTBOSS_ALLOWED_ORIGINS (or the hardcoded
 *     default dev-port list) → 403.
 *   - No Sec-Fetch-Site and no Origin → pass (server-to-server, curl, shift
 *     agent — these are server-side fetches from Next itself and have no
 *     browser Origin header).
 *   - enforceJsonContentType=true: reject requests whose Content-Type does
 *     not begin with 'application/json'.  Call this on every POST/PUT/PATCH
 *     handler that parses JSON.
 *
 * Usage (per route — thin call site):
 *
 *   import { checkProxyRequest } from "@/lib/proxy-guard";
 *
 *   export async function POST(request: Request) {
 *     const guard = checkProxyRequest(request, { enforceJsonContentType: true });
 *     if (guard) return guard;
 *     ...
 *   }
 *
 * For routes with no body (cancel, approve-merge, reject …):
 *
 *   const guard = checkProxyRequest(request);
 *   if (guard) return guard;
 */

import { NextResponse } from "next/server";
import {
  DEFAULT_ALLOWED_ORIGINS,
  readAllowedOriginsEnv,
} from "./csrf-constants";

/** Lazily built, incorporates SHIFTBOSS_ALLOWED_ORIGINS at runtime. */
let _resolvedOrigins: Set<string> | null = null;

function resolvedAllowedOrigins(): Set<string> {
  if (_resolvedOrigins) return _resolvedOrigins;
  const extra = readAllowedOriginsEnv()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  _resolvedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
  return _resolvedOrigins;
}

/** Reset the lazy cache — only needed in tests. */
export function __resetOriginCache(): void {
  _resolvedOrigins = null;
}

export interface ProxyGuardOptions {
  /**
   * When true, reject requests whose Content-Type does not start with
   * 'application/json'.  Set this on every handler that calls request.json().
   */
  enforceJsonContentType?: boolean;
  /**
   * When true (SHIFTBOSS_CORS_ALLOW_ALL=1 in dev), skip the origin check so
   * that any browser origin is accepted.  The content-type check still applies
   * when enforceJsonContentType is set — content-type smuggling is a separate
   * vector that should be closed even in dev.
   */
  allowAll?: boolean;
}

/**
 * Check an incoming Next.js route handler request for CSRF and content-type
 * issues.  Returns a NextResponse (403/415) when the request should be rejected,
 * or null when it should be allowed to continue.
 */
export function checkProxyRequest(
  request: Request,
  options: ProxyGuardOptions = {}
): NextResponse | null {
  if (!options.allowAll) {
    const secFetchSite = request.headers.get("sec-fetch-site");
    if (secFetchSite !== null) {
      if (secFetchSite !== "same-origin" && secFetchSite !== "none") {
        return NextResponse.json(
          {
            error: "forbidden",
            message:
              "Cross-origin or same-site requests are not permitted on this endpoint.",
          },
          { status: 403 }
        );
      }
      // same-origin or none: fall through to content-type check if needed.
    } else {
      const origin = request.headers.get("origin");
      if (origin !== null) {
        if (!resolvedAllowedOrigins().has(origin)) {
          return NextResponse.json(
            {
              error: "forbidden",
              message: "Origin not in the allowed-origins list.",
            },
            { status: 403 }
          );
        }
        // Known-good origin: fall through to content-type check if needed.
      }
      // No sec-fetch-site and no origin: non-browser client.  Pass through.
    }
  }

  if (options.enforceJsonContentType) {
    const ct = request.headers.get("content-type") ?? "";
    if (!ct.startsWith("application/json")) {
      return NextResponse.json(
        {
          error: "unsupported_media_type",
          message: "Content-Type must be application/json.",
        },
        { status: 415 }
      );
    }
  }

  return null;
}
