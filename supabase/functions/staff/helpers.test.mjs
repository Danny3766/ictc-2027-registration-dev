import assert from "node:assert/strict";
import test from "node:test";
import { isWeakPassword, nameKey, sameUser, validPassword, validUsername, validMealIdentity, validDistrictFilter } from "./index.ts";

test("staff password length is bounded before privileged update", () => {
  assert.equal(validPassword("a".repeat(11)), false);
  assert.equal(validPassword("a".repeat(12)), true);
  assert.equal(validPassword("a".repeat(72)), true);
  assert.equal(validPassword("a".repeat(73)), false);
  assert.equal(validPassword(null), false);
  assert.equal(validPassword("密".repeat(24)), true);
  assert.equal(validPassword("密".repeat(25)), false);
});

test("staff usernames have a stable internal identity format", () => {
  assert.equal(validUsername("lin_sen_01"), true);
  assert.equal(validUsername("ABCD"), false);
  assert.equal(validUsername("a"), false);
  assert.equal(validUsername("abc@somewhere"), false);
});

test("staff search uses the same name key as the database lookup", () => {
  // Expected values match public.registration_name_key in the local PostgreSQL checks.
  assert.equal(nameKey(" David  Wang "), "davidwang");
  assert.equal(nameKey("王　小明"), "王小明");
  assert.equal(nameKey("Ｊｏｈｎ Smith"), "johnsmith");
  assert.equal(nameKey("王\u200B小明\uFEFF"), "王小明");
});

test("an admin cannot set their own password by changing the UUID's letter case", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(sameUser(id.toUpperCase(), id), true);
  assert.equal(sameUser(id, "323e4567-e89b-42d3-a456-426614174000"), false);
  assert.equal(sameUser(undefined, id), false);
});

test("only Auth's weak_password code counts as a weak password", () => {
  assert.equal(isWeakPassword({ code: "weak_password", status: 422 }), true);
  assert.equal(isWeakPassword({ code: "validation_failed", status: 422 }), false);
  assert.equal(isWeakPassword(null), false);
});

test("a meal identity is left out, null, or one of the two codes", () => {
  for (const value of [undefined, null, "general", "student"]) assert.equal(validMealIdentity(value), true);
  for (const value of ["", "Student", "teacher", 1, true, {}, ["student"]]) assert.equal(validMealIdentity(value), false);
});

test("the registration list's district filter is left out, null, or a positive integer id", () => {
  for (const value of [undefined, null, 1, 4]) assert.equal(validDistrictFilter(value), true);
  for (const value of [0, -1, 1.5, "1", "", NaN, Infinity, 2 ** 53, true, {}, [1]]) assert.equal(validDistrictFilter(value), false);
});
