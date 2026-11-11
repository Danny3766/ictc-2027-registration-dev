import assert from "node:assert/strict";
import test from "node:test";
import { readRequestJson, clientIp, isUuid, sourceKey, validChild, validMealIdentity, formErrorResponse } from "./index.ts";

test("JSON bodies enforce the byte limit while reading", async () => {
  const payload = '"' + "a".repeat(63_998) + '"';
  const request = (body, headers = {}) => new Request("https://example.test", { method: "POST", body, headers });
  assert.equal(await readRequestJson(request(payload)), "a".repeat(63_998));
  assert.equal(await readRequestJson(request('"' + "名".repeat(21_332) + '"')), "名".repeat(21_332));
  await assert.rejects(readRequestJson(request(payload + " ")), { message: "REQUEST_TOO_LARGE" });
  await assert.rejects(readRequestJson(request(payload + " ", { "content-length": "1" })), { message: "REQUEST_TOO_LARGE" });
  await assert.rejects(readRequestJson(request("{")), SyntaxError);
  await assert.rejects(readRequestJson(new Request("https://example.test", { method: "POST" })), SyntaxError);
});

test("oversized bodies cancel the stream without consuming the rest", async () => {
  for (const declaredLength of [undefined, "64001"]) {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(32_001));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const headers = declaredLength ? { "content-length": declaredLength } : {};
    const request = new Request("https://example.test", { method: "POST", body, headers, duplex: "half" });
    await assert.rejects(readRequestJson(request), { message: "REQUEST_TOO_LARGE" });
    assert.equal(cancelled, true);
    assert.equal(reads, declaredLength ? 0 : 2);
    assert.equal(body.locked, false);
  }
});

test("JSON decoding preserves UTF-8 characters split across chunks", async () => {
  const bytes = new TextEncoder().encode('{"name":"名"}');
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  assert.deepEqual(await readRequestJson(new Request("https://example.test", {
    method: "POST", body, duplex: "half",
  })), { name: "名" });
});

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

test("a meal identity is left out, null, or a well-formed code; the database checks that it exists", () => {
  for (const value of [undefined, null, "general", "student", "child", "identity_0a1b", "a".repeat(64)]) assert.equal(validMealIdentity(value), true);
  for (const value of ["", "Student", "bad code", "a".repeat(65), 1, true, {}, ["student"]]) assert.equal(validMealIdentity(value), false);
});

test("a child needs a parent name of 1 to 20 characters; any other child type is refused", () => {
  for (const [childType, parentName] of [[undefined, undefined], [null, "x"], ["", undefined], ["", ""],
    ["elementary", "王爸爸"], ["preschool", "  Michael Chen Wang L  "], ["elementary", "名".repeat(20)], ["elementary", "𠀀".repeat(20)]]) {
    assert.equal(validChild(childType, parentName), true, String([childType, parentName]));
  }
  for (const [childType, parentName] of [[true, "parent"], [false, "parent"], ["invalid", "parent"], ["preschool", ""], ["elementary", undefined], ["elementary", null], ["elementary", ""], ["elementary", "   "],
    ["elementary", "名".repeat(21)], ["elementary", 1], ["true", "王爸爸"], [1, "王爸爸"], [{}, "王爸爸"]]) {
    assert.equal(validChild(childType, parentName), false, String([childType, parentName]));
  }
});

test("create and update map database errors alike; a survey that opened carries its current description", async () => {
  const database = (row, error = null) => ({ from: () => ({ select: () => ({ single: async () => ({ data: row, error }) }) }) });
  const mapped = async (message, db = database(null), code) => {
    const reply = await formErrorResponse({ message, code }, db);
    return reply && { status: reply.status, body: await reply.json() };
  };
  assert.deepEqual(await mapped("PICKUP_REQUIRED", database({ pickup_description: "說明" })),
    { status: 409, body: { error: "接機接待調查已開放，請回答是否可以接機；看不到接機欄位時請重新整理頁面", code: "PICKUP_REQUIRED", pickup_description: "說明", survey_settings: { pickup_description: "說明" } } });
  const settings = { hosting_identity_codes: ["general"], pickup_identity_codes: ["student"], is_hosting_open: true, is_pickup_open: true };
  const denied = await mapped("PICKUP_NOT_ALLOWED", database(settings));
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, "PICKUP_NOT_ALLOWED");
  assert.deepEqual(denied.body.survey_settings, settings);
  assert.equal((await mapped("HOSTING_REQUIRED", database({ hosting_description: "說明" }))).body.hosting_description, "說明");
  // A failed read leaves the description out, so the page keeps the one it has.
  assert.equal("pickup_description" in (await mapped("PICKUP_REQUIRED", database(null, { message: "down" }))).body, false);
  assert.deepEqual(await mapped("HOSTING_CLOSED"), { status: 409, body: { error: "開家接待調查已關閉", code: "HOSTING_CLOSED" } });
  assert.equal((await mapped("AUDIENCE_RESTRICTED")).status, 400);
  assert.equal((await mapped("anything", undefined, "22023")).status, 400);
  assert.equal(await mapped("NAME_TAKEN"), null);
  assert.equal(await formErrorResponse(null, database(null)), null);
});
