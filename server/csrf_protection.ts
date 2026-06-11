/**
 * CSRF / origin enforcement middleware for the Express server.
 *
 * Defends against drive-by browser CSRF on the default localhost deployment.
 * CORS only gates response *reads*; it does not block cross-origin state-changing
 * requests from reaching their handlers.  This middleware fills that gap.
 *
 * Rules (applied to non-GET/HEAD/OPTIONS requests only):
 *  1. Sec-Fetch-Site present and set to 'cross-site' or 'same-site' → 403.
 *  2. Origin present and not in the configured allowed-origins set → 403.
 *  3. No Origin and no Sec-Fetch-Site → pass (curl, server-to-server, shift agent).
 *
 * The allowed-origins set is the same one already used by the CORS handler so
 * there is a single source of truth.
 */

import { type Request, type Response, type NextFunction } from "express";
import { MUTABLE_METHODS } from "./config.js";

export interface CsrfOriginGuardOptions {
  /**
   * When true (SHIFTBOSS_CORS_ALLOW_ALL=1 in dev), skip the origin check so
   * that any browser origin is accepted.  This keeps the CSRF guard in sync
   * with the CORS handler, which already permits all origins in this mode.
   */
  allowAll?: boolean;
}

/**
 * Build an Express middleware that enforces same-origin policy on
 * state-changing requests.
 *
 * @param allowedOrigins  The set of origins permitted to issue cross-origin
 *                        credentialed requests (must include the UI origin).
 *                        Pass the same Set<string> constructed in index.ts.
 * @param options         Optional flags; see CsrfOriginGuardOptions.
 */
export function csrfOriginGuard(
  allowedOrigins: ReadonlySet<string>,
  options: CsrfOriginGuardOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  return function csrfMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!MUTABLE_METHODS.has(req.method)) {
      return next();
    }

    // When allow-all is active (dev mode only) skip the origin check — the
    // CORS handler already permits all origins and the two guards must agree.
    if (options.allowAll) {
      return next();
    }

    const secFetchSite = req.get("sec-fetch-site");
    if (secFetchSite !== undefined) {
      // Browser sent the header.  'same-origin' and 'none' (direct navigation)
      // are safe.  'same-site' and 'cross-site' are not.
      if (secFetchSite === "same-origin" || secFetchSite === "none") {
        return next();
      }
      res.status(403).json({
        error: "forbidden",
        message:
          "Cross-origin or same-site requests are not permitted on this endpoint.",
      });
      return;
    }

    const origin = req.get("origin");
    if (origin !== undefined) {
      if (allowedOrigins.has(origin)) {
        return next();
      }
      res.status(403).json({
        error: "forbidden",
        message: "Origin not in the allowed-origins list.",
      });
      return;
    }

    // No Sec-Fetch-Site, no Origin — non-browser client (curl, server-to-server,
    // shift agent).  Let it through.
    return next();
  };
}

/** Exported for unit tests only — not part of the public API. */
export const __test__ = { MUTABLE_METHODS };
