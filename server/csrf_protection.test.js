/**
 * Unit tests for server/csrf_protection.ts
 *
 * The module is tested by constructing minimal mock req/res/next objects that
 * match the shapes Express passes to middleware, keeping zero external deps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { csrfOriginGuard } from "./csrf_protection.ts";

const ALLOWED = new Set([
  "http://localhost:3010",
  "http://127.0.0.1:3010",
]);

/** Build a minimal mock Express request. */
function makeReq({ method = "POST", headers = {} } = {}) {
  const hdrs = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    method,
    get(name) {
      return hdrs[name.toLowerCase()];
    },
  };
}

/** Build a minimal mock Express response that records the last json call. */
function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
    },
  };
  return res;
}

const middleware = csrfOriginGuard(ALLOWED);

// ---------------------------------------------------------------------------
// GET / HEAD / OPTIONS — always pass through
// ---------------------------------------------------------------------------

test("GET passes through without any origin headers", () => {
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called, "next() should be called for GET");
  assert.equal(res._status, null);
});

test("HEAD passes through", () => {
  const req = makeReq({ method: "HEAD" });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("OPTIONS passes through", () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

// ---------------------------------------------------------------------------
// POST with no Origin, no Sec-Fetch-Site — non-browser client
// ---------------------------------------------------------------------------

test("POST with no headers passes through (curl / server-to-server / shift agent)", () => {
  const req = makeReq({ method: "POST" });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called, "non-browser POST must reach the handler");
  assert.equal(res._status, null);
});

// ---------------------------------------------------------------------------
// Sec-Fetch-Site header present
// ---------------------------------------------------------------------------

test("POST with Sec-Fetch-Site: same-origin passes through", () => {
  const req = makeReq({
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
  assert.equal(res._status, null);
});

test("POST with Sec-Fetch-Site: none passes through (direct navigation)", () => {
  const req = makeReq({
    method: "POST",
    headers: { "sec-fetch-site": "none" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("POST with Sec-Fetch-Site: cross-site is rejected with 403", () => {
  const req = makeReq({
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false, "next() must not be called");
  assert.equal(res._status, 403);
  assert.equal(res._body?.error, "forbidden");
});

test("POST with Sec-Fetch-Site: same-site is rejected with 403", () => {
  const req = makeReq({
    method: "POST",
    headers: { "sec-fetch-site": "same-site" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res._status, 403);
});

test("DELETE with Sec-Fetch-Site: cross-site is rejected", () => {
  const req = makeReq({
    method: "DELETE",
    headers: { "sec-fetch-site": "cross-site" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res._status, 403);
});

// ---------------------------------------------------------------------------
// Origin header present (no Sec-Fetch-Site)
// ---------------------------------------------------------------------------

test("POST with allowed Origin passes through", () => {
  const req = makeReq({
    method: "POST",
    headers: { origin: "http://localhost:3010" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
  assert.equal(res._status, null);
});

test("POST with foreign Origin is rejected with 403", () => {
  const req = makeReq({
    method: "POST",
    headers: { origin: "https://evil.example.com" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res._status, 403);
  assert.equal(res._body?.error, "forbidden");
});

test("PATCH with foreign Origin is rejected", () => {
  const req = makeReq({
    method: "PATCH",
    headers: { origin: "http://attacker.test" },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res._status, 403);
});

// ---------------------------------------------------------------------------
// Sec-Fetch-Site takes precedence over Origin when both are present
// ---------------------------------------------------------------------------

test("cross-site Sec-Fetch-Site wins even when Origin is in the allowlist", () => {
  const req = makeReq({
    method: "POST",
    headers: {
      "sec-fetch-site": "cross-site",
      origin: "http://localhost:3010", // allowed, but Sec-Fetch-Site says no
    },
  });
  const res = makeRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res._status, 403);
});
