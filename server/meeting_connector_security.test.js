/**
 * Security regression tests for meeting_connector.ts
 *
 * Verifies that user-controlled values (bot_name, output_url) interpolated into
 * Recall.ai request-body JSON templates cannot inject or override sibling keys.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { __test__ } = await import("./meeting_connector.ts");
const { jsonStringEscape, renderTemplate, parseTemplateJson } = __test__;

// ---------------------------------------------------------------------------
// jsonStringEscape — the core escaping primitive
// ---------------------------------------------------------------------------

test("jsonStringEscape: plain strings pass through unchanged (no wrapping quotes)", () => {
  assert.equal(jsonStringEscape("hello world"), "hello world");
  assert.equal(jsonStringEscape("Shiftboss Agent"), "Shiftboss Agent");
});

test("jsonStringEscape: double quotes are escaped so they cannot break JSON string context", () => {
  const escaped = jsonStringEscape('"');
  assert.equal(escaped, '\\"');
});

test("jsonStringEscape: backslashes are escaped", () => {
  const escaped = jsonStringEscape("C:\\Users\\foo");
  assert.equal(escaped, "C:\\\\Users\\\\foo");
});

test("jsonStringEscape: control characters are escaped", () => {
  // Newlines and tabs must be escaped inside a JSON string literal.
  const escaped = jsonStringEscape("line1\nline2\ttab");
  assert.ok(!escaped.includes("\n"), "raw newline must not appear");
  assert.ok(!escaped.includes("\t"), "raw tab must not appear");
});

// ---------------------------------------------------------------------------
// parseTemplateJson — injection attempts via bot_name
// ---------------------------------------------------------------------------

const JOIN_TEMPLATE = JSON.stringify({
  url: "{meeting_url}",
  bot_name: "{bot_name}",
  real_time_media: {
    websocket_audio_destination_url: "{audio_ws_url}",
  },
});

test("JSON injection via bot_name: quote-escape attempt does not inject sibling keys", () => {
  const hostileValues = {
    meeting_url: "https://meet.google.com/abc-defg-hij",
    bot_name: 'x","recording_config":{"real_time_transcription":{"destination_url":"http://attacker.example"}},"__injected":"',
    audio_ws_url: "ws://127.0.0.1:8765",
  };

  const result = parseTemplateJson(JOIN_TEMPLATE, hostileValues);

  // The template must still parse cleanly (no JSON syntax error from the
  // hostile value — the value is safely escaped).
  assert.ok(result.ok, `Template parse failed unexpectedly: ${result.ok ? "" : result.error}`);

  const body = result.body;
  // The injected key must NOT appear at top level.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(body, "recording_config"),
    "Injected 'recording_config' key must not be present in parsed body"
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(body, "__injected"),
    "Injected '__injected' key must not be present in parsed body"
  );

  // The bot_name field must be the full hostile string, stored as a plain value.
  assert.equal(typeof body.bot_name, "string");
  assert.ok(
    body.bot_name.includes("recording_config"),
    "The hostile text should be preserved verbatim as the bot_name string value"
  );
});

test("JSON injection via bot_name: backslash payload does not break parse", () => {
  const hostileValues = {
    meeting_url: "https://meet.google.com/abc-defg-hij",
    bot_name: 'evil\\"},"extra_key":"injected',
    audio_ws_url: "ws://127.0.0.1:8765",
  };

  const result = parseTemplateJson(JOIN_TEMPLATE, hostileValues);
  assert.ok(result.ok, `Template parse failed: ${result.ok ? "" : result.error}`);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result.body, "extra_key"),
    "Injected 'extra_key' must not appear in parsed body"
  );
});

// ---------------------------------------------------------------------------
// parseTemplateJson — injection attempt via output_url
// ---------------------------------------------------------------------------

const OUTPUT_TEMPLATE = JSON.stringify({
  bot_id: "{bot_id}",
  output_media_url: "{output_media_url}",
  mode: "{mode}",
});

test("JSON injection via output_url: hostile value is escaped, not injected", () => {
  const hostileValues = {
    bot_id: "bot-123",
    output_media_url: 'https://legit.example","extra":{"steal":"data"',
    mode: "screen_share",
    output_media_mode: "screen_share",
    meeting_url: "",
    bot_name: "",
    output_media_id: "",
  };

  const result = parseTemplateJson(OUTPUT_TEMPLATE, hostileValues);
  assert.ok(result.ok, `Template parse failed: ${result.ok ? "" : result.error}`);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result.body, "extra"),
    "Injected 'extra' key must not appear in parsed body"
  );
  assert.equal(typeof result.body.output_media_url, "string");
});

// ---------------------------------------------------------------------------
// renderTemplate — numbers and safe strings are not double-escaped
// ---------------------------------------------------------------------------

test("renderTemplate: numeric-string values survive round-trip through JSON.parse", () => {
  const template = JSON.stringify({ sample_rate: "{sample_rate}", channels: "{channels}" });
  const values = { sample_rate: "16000", channels: "1" };
  const result = parseTemplateJson(template, values);
  assert.ok(result.ok);
  // After JSON.parse the values will be strings (the template wraps them in ""),
  // but they must equal the original strings.
  assert.equal(result.body.sample_rate, "16000");
  assert.equal(result.body.channels, "1");
});
