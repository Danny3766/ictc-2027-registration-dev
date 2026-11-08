import assert from "node:assert/strict";
import test from "node:test";
import { clientIp, isUuid, sourceKey, validChild, validMealIdentity } from "./index.ts";

test("request identifiers are validated", () => {
  assert.equal(isUuid("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(isUuid("123e4567-e89b-12d3-a456-426614174000"), false);
});

test("rate limits use the first forwarded address and share one bucket without it", () => {
  const forwarded = new Request("https://example.test", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
  assert.equal(clientIp(forwarded), "203.0.113.7");
  assert.equal(clientIp(new Request("https://example.test")), "unknown");
});

test("source keys are keyed hashes, so the stored value never contains the IP", async () => {
  const first = await sourceKey("203.0.113.7", "a".repeat(32));
  assert.equal(first, await sourceKey("203.0.113.7", "a".repeat(32)));
  assert.notEqual(first, await sourceKey("203.0.113.7", "b".repeat(32)));
  assert.notEqual(first, await sourceKey("203.0.113.8", "a".repeat(32)));
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("a meal identity is left out, null, or one of the two codes", () => {
  for (const value of [undefined, null, "general", "student"]) assert.equal(validMealIdentity(value), true);
  for (const value of ["", "Student", "teacher", 1, true, {}, ["student"]]) assert.equal(validMealIdentity(value), false);
});

test("a child needs a parent name of 1 to 20 characters; anything else about the flag is refused", () => {
  for (const [isChild, parentName] of [[undefined, undefined], [null, "x"], [false, undefined], [false, ""],
    [true, "王爸爸"], [true, "  Michael Chen Wang L  "], [true, "名".repeat(20)], [true, "𠀀".repeat(20)]]) {
    assert.equal(validChild(isChild, parentName), true, String([isChild, parentName]));
  }
  for (const [isChild, parentName] of [[true, undefined], [true, null], [true, ""], [true, "   "],
    [true, "名".repeat(21)], [true, 1], ["true", "王爸爸"], [1, "王爸爸"], [{}, "王爸爸"]]) {
    assert.equal(validChild(isChild, parentName), false, String([isChild, parentName]));
  }
});
