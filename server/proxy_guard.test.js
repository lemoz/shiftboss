/**
 * Unit tests for lib/proxy-guard.ts
 *
 * We test the shared checkProxyRequest() helper that the Next.js middleware
 * and individual route handlers can call.  The module uses the Web Fetch API
 * (Request / Headers) which is available in Node 18+.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { checkProxyRequest, __resetOriginCache } from "../lib/proxy-guard.ts";

function makeRequest({ method = "POST", headers = {}, url = "http://localhost:3010/api/test" } = {}) {
  return new Request(url, {
    method,
    headers: new Headers(headers),
    // Body not needed — we are only testing headers.
  });
}

beforeEach(() => {
  // Reset the lazy allowed-origins cache before each test so env overrides
  // from one test don't bleed into the next.
  __resetOriginCache();
  delete process.env.SHIFTBOSS_ALLOWED_ORIGINS;
});

// ---------------------------------------------------------------------------
// GET passes through (no check needed)
// ---------------------------------------------------------------------------

test("GET returns null (no restriction)", () => {
  // The middleware does not call checkProxyRequest for GET, but the guard
  // itself should still handle it if called — it applies content-type check
  // only when enforceJsonContentType is set, and CSRF only on mutable methods
  // is enforced by middleware.ts.  The guard itself is method-agnostic for
  // the origin check, so test that no-origin GET passes.
  const req = makeRequest({ method: "GET" });
  const result = checkProxyRequest(req);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// No Origin, no Sec-Fetch-Site — non-browser (server-to-server, shift agent)
// ---------------------------------------------------------------------------

test("POST with no browser headers returns null (pass through)", () => {
  const req = makeRequest({ method: "POST", headers: { "content-type": "application/json" } });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Sec-Fetch-Site: same-origin / none — allowed
// ---------------------------------------------------------------------------

test("same-origin Sec-Fetch-Site returns null", () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.equal(result, null);
});

test("Sec-Fetch-Site: none returns null", () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "none",
      "content-type": "application/json",
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Sec-Fetch-Site: cross-site — rejected
// ---------------------------------------------------------------------------

test("cross-site Sec-Fetch-Site returns 403", async () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "cross-site" },
  });
  const result = checkProxyRequest(req);
  assert.ok(result !== null);
  assert.equal(result.status, 403);
  const body = await result.json();
  assert.equal(body.error, "forbidden");
});

test("same-site Sec-Fetch-Site returns 403", async () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "same-site" },
  });
  const result = checkProxyRequest(req);
  assert.ok(result !== null);
  assert.equal(result.status, 403);
});

// ---------------------------------------------------------------------------
// Origin header — allowed / forbidden
// ---------------------------------------------------------------------------

test("Origin in default allowlist (localhost:3010) returns null", () => {
  const req = makeRequest({
    headers: {
      origin: "http://localhost:3010",
      "content-type": "application/json",
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.equal(result, null);
});

test("foreign Origin returns 403", async () => {
  const req = makeRequest({
    headers: { origin: "https://evil.example.com" },
  });
  const result = checkProxyRequest(req);
  assert.ok(result !== null);
  assert.equal(result.status, 403);
  const body = await result.json();
  assert.equal(body.error, "forbidden");
});

test("Origin from SHIFTBOSS_ALLOWED_ORIGINS env is permitted", () => {
  process.env.SHIFTBOSS_ALLOWED_ORIGINS = "https://custom.example.com";
  __resetOriginCache(); // force rebuild with new env value
  const req = makeRequest({
    headers: {
      origin: "https://custom.example.com",
      "content-type": "application/json",
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Content-type enforcement
// ---------------------------------------------------------------------------

test("text/plain Content-Type with enforceJsonContentType returns 415", async () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.ok(result !== null);
  assert.equal(result.status, 415);
  const body = await result.json();
  assert.equal(body.error, "unsupported_media_type");
});

test("missing Content-Type with enforceJsonContentType returns 415", async () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "same-origin" },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.ok(result !== null);
  assert.equal(result.status, 415);
});

test("application/json Content-Type passes when enforceJsonContentType is true", () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "same-origin",
      "content-type": "application/json; charset=utf-8",
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.equal(result, null);
});

test("without enforceJsonContentType, text/plain is allowed", () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    },
  });
  const result = checkProxyRequest(req);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// CSRF check takes priority over content-type
// ---------------------------------------------------------------------------

test("cross-site request is rejected before content-type is checked", async () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json", // would pass ct check alone
    },
  });
  const result = checkProxyRequest(req, { enforceJsonContentType: true });
  assert.ok(result !== null);
  assert.equal(result.status, 403); // CSRF, not 415
});
