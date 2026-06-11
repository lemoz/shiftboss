import assert from "node:assert/strict";
import { test } from "node:test";

const {
  buildNormalizedSlackPersonIdentifier,
  parseSlackPersonIdentifier,
} = await import("./slack_identity.ts");

test("buildNormalizedSlackPersonIdentifier canonicalizes team and user values", () => {
  const normalized = buildNormalizedSlackPersonIdentifier({
    teamId: " T123 ",
    userId: " U456 ",
  });
  assert.equal(normalized, "slack:t123:u456");
});

test("parseSlackPersonIdentifier accepts canonical slack identity values", () => {
  const parsed = parseSlackPersonIdentifier("slack:T123:U456");
  assert.deepEqual(parsed, { teamId: "T123", userId: "U456" });
});

test("parseSlackPersonIdentifier rejects malformed values", () => {
  assert.equal(parseSlackPersonIdentifier("slack:T123"), null);
  assert.equal(parseSlackPersonIdentifier("email:test@example.com"), null);
});
