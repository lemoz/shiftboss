/**
 * Next.js edge middleware — CSRF and content-type enforcement for all
 * /api/* proxy routes.
 *
 * This is the single enforcement point for two attack vectors:
 *
 * 1. Cross-origin browser CSRF: browsers attach Sec-Fetch-Site on every
 *    fetch; we reject anything that is not 'same-origin' or 'none'.  When
 *    Sec-Fetch-Site is absent we fall back to the Origin header.
 *
 * 2. Content-type smuggling: a CORS "simple" request may carry
 *    Content-Type: text/plain whose body is valid JSON.  We enforce
 *    application/json on state-changing routes that carry a Content-Type
 *    header — but only when a Content-Type header is actually present and
 *    wrong.  Body-less POSTs (cancel, approve-merge, reject, etc.) send no
 *    Content-Type at all and must not be rejected.
 *
 * Non-browser clients (curl, shift agent, server-side Next fetches) carry
 * neither browser header and are passed through unchanged.
 *
 * Read-only methods (GET, HEAD, OPTIONS) are always passed through.
 *
 * Dev mode (SHIFTBOSS_CORS_ALLOW_ALL=1, non-production): the origin check is
 * skipped to match the Express CORS allow-all behaviour, so developers running
 * the UI on a custom port (e.g. localhost:5173) are not blocked by the CSRF
 * guard while the Express CORS handler already permits them.
 */

import { NextResponse, type NextRequest } from "next/server";
import { MUTABLE_METHODS, readAllowedOriginsEnv, DEFAULT_ALLOWED_ORIGINS } from "@/lib/csrf-constants";

// ---------------------------------------------------------------------------
// Allowed-origins set — built once per middleware worker lifetime.
// ---------------------------------------------------------------------------

function buildAllowedOrigins(): Set<string> {
  const extra = readAllowedOriginsEnv()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.length === 0) return new Set(DEFAULT_ALLOWED_ORIGINS);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

// Evaluated once per middleware worker lifetime — env is stable at that point.
const ALLOWED_ORIGINS = buildAllowedOrigins();

// ---------------------------------------------------------------------------
// Dev allow-all flag — mirrors the condition in server/index.ts so the CSRF
// guard and the Express CORS handler stay in sync for the allow-all path.
// ---------------------------------------------------------------------------

function isAllowAllCors(): boolean {
  const requested =
    (process.env.SHIFTBOSS_CORS_ALLOW_ALL || "").trim().toLowerCase();
  const isSet = requested === "1" || requested === "true" || requested === "yes" || requested === "on";
  if (!isSet) return false;
  // Mirror server/index.ts: allow-all is dev-only (not production).
  return process.env.NODE_ENV !== "production";
}

const ALLOW_ALL_CORS = isAllowAllCors();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function middleware(request: NextRequest): NextResponse | undefined {
  if (!MUTABLE_METHODS.has(request.method)) {
    return undefined; // pass through
  }

  // --- CSRF origin check ---
  // Skip when CORS allow-all is active (dev mode only) so developers running
  // the UI on a non-default port are not blocked here when Express already
  // permits them via the allow-all CORS handler.
  if (!ALLOW_ALL_CORS) {
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
      // same-origin or none: fall through to content-type check.
    } else {
      const origin = request.headers.get("origin");
      if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
        return NextResponse.json(
          {
            error: "forbidden",
            message: "Origin not in the allowed-origins list.",
          },
          { status: 403 }
        );
      }
      // No sec-fetch-site and no (or known-good) origin: pass through.
    }
  }

  // --- Content-type enforcement (kills text/plain smuggling vector) ---
  // Only enforce when a Content-Type header is actually present and wrong.
  // Body-less POSTs (cancel, approve-merge, resume, etc.) send no Content-Type
  // and must not be rejected with 415.
  const ct = request.headers.get("content-type");
  if (ct !== null && !ct.startsWith("application/json")) {
    return NextResponse.json(
      {
        error: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
      { status: 415 }
    );
  }

  return undefined; // pass through
}

export const config = {
  matcher: ["/api/:path*"],
};
