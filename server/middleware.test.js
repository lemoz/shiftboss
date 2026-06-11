/**
 * Unit tests for middleware.ts (Next.js edge middleware CSRF + content-type enforcement).
 *
 * These tests exercise the real middleware function with real NextRequest objects so
 * that regressions (e.g. body-less POST returning 415) are caught by the unit suite.
 * The e2e suite hits Express directly on port 4011 and never traverses Next.js
 * middleware, so this file is the only place where middleware.ts is tested.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";

// NextRequest is available via Next.js server web exports.
const { NextRequest } = await import(
  "../node_modules/next/dist/server/web/exports/index.js"
);

// Import after NextRequest to ensure the Next.js runtime is initialised.
const { middleware } = await import("../middleware.ts");

/** Build a NextRequest for the given options. */
function makeRequest({
  method = "POST",
  headers = {},
  url = "http://localhost:3010/api/test",
} = {}) {
  return new NextRequest(url, { method, headers: new Headers(headers) });
}

// ---------------------------------------------------------------------------
// GET / HEAD / OPTIONS — always pass through
// ---------------------------------------------------------------------------

test("GET passes through", () => {
  const req = makeRequest({ method: "GET" });
  assert.equal(middleware(req), undefined);
});

test("HEAD passes through", () => {
  const req = makeRequest({ method: "HEAD" });
  assert.equal(middleware(req), undefined);
});

test("OPTIONS passes through", () => {
  const req = makeRequest({ method: "OPTIONS" });
  assert.equal(middleware(req), undefined);
});

// ---------------------------------------------------------------------------
// Body-less POST (no Content-Type, no browser headers) — must pass through.
// This is the regression test for the 415 bug on cancel/approve-merge/reject etc.
// ---------------------------------------------------------------------------

test("POST with no headers passes through (non-browser client: curl, shift agent)", () => {
  const req = makeRequest({ method: "POST", headers: {} });
  assert.equal(middleware(req), undefined);
});

test("POST with no Content-Type and no origin headers passes through", () => {
  // Simulates the UI calling cancel/approve-merge/reject with a bare POST
  // (no Content-Type header).  Must not get 415.
  const req = makeRequest({
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(middleware(req), undefined);
});

// ---------------------------------------------------------------------------
// Sec-Fetch-Site: same-origin / none — allowed
// ---------------------------------------------------------------------------

test("POST with Sec-Fetch-Site: same-origin passes through", () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(middleware(req), undefined);
});

test("POST with Sec-Fetch-Site: none passes through (direct navigation)", () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "none" },
  });
  assert.equal(middleware(req), undefined);
});

// ---------------------------------------------------------------------------
// Sec-Fetch-Site: cross-site / same-site — rejected with 403
// ---------------------------------------------------------------------------

test("POST with Sec-Fetch-Site: cross-site is rejected with 403", async () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "cross-site" },
  });
  const res = middleware(req);
  assert.ok(res !== undefined && res !== null, "should return a response");
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "forbidden");
});

test("POST with Sec-Fetch-Site: same-site is rejected with 403", async () => {
  const req = makeRequest({
    headers: { "sec-fetch-site": "same-site" },
  });
  const res = middleware(req);
  assert.ok(res !== undefined);
  assert.equal(res.status, 403);
});

test("DELETE with Sec-Fetch-Site: cross-site is rejected with 403", async () => {
  const req = makeRequest({
    method: "DELETE",
    headers: { "sec-fetch-site": "cross-site" },
  });
  const res = middleware(req);
  assert.ok(res !== undefined);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Origin header (no Sec-Fetch-Site) — allowed / rejected
// ---------------------------------------------------------------------------

test("POST with allowed Origin (localhost:3010) passes through", () => {
  const req = makeRequest({
    headers: { origin: "http://localhost:3010" },
  });
  assert.equal(middleware(req), undefined);
});

test("POST with foreign Origin is rejected with 403", async () => {
  const req = makeRequest({
    headers: { origin: "https://evil.example.com" },
  });
  const res = middleware(req);
  assert.ok(res !== undefined);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "forbidden");
});

// ---------------------------------------------------------------------------
// Content-type enforcement — only when CT is present and wrong.
// ---------------------------------------------------------------------------

test("text/plain Content-Type on same-origin POST is rejected with 415", async () => {
  // An attacker sending a CORS simple request carries Content-Type: text/plain
  // even when Sec-Fetch-Site is same-origin (hypothetically).  We reject it.
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    },
  });
  const res = middleware(req);
  assert.ok(res !== undefined);
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.error, "unsupported_media_type");
});

test("application/json Content-Type on same-origin POST passes through", () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(middleware(req), undefined);
});

test("no Content-Type header on same-origin POST passes through (body-less route)", () => {
  // cancel, approve-merge, reject, etc. send no Content-Type.
  // middleware.ts must not return 415 when the header is absent.
  const req = makeRequest({
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(middleware(req), undefined);
});

// ---------------------------------------------------------------------------
// CSRF check takes priority over content-type check
// ---------------------------------------------------------------------------

test("cross-site request with application/json is still rejected with 403", async () => {
  const req = makeRequest({
    headers: {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    },
  });
  const res = middleware(req);
  assert.ok(res !== undefined);
  assert.equal(res.status, 403); // CSRF, not 415
});
