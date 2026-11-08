import assert from "node:assert/strict";
import test from "node:test";
import { isWeakPassword, nameKey, sameUser, validPassword, validUsername, validMealIdentity, validDistrictFilter, validChild, childrenByParent } from "./index.ts";

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

test("親子 lists each active adult's active children in the same district; children and void rows get none", () => {
  const rows = [
    { serial_no: 1, district_id: 1, name_key: "王爸爸", record_status: "active", is_child: false },
    { serial_no: 2, district_id: 2, name_key: "王爸爸", record_status: "active", is_child: false },
    { serial_no: 3, district_id: 1, name_key: "王大明", record_status: "active", is_child: true },
    { serial_no: 4, district_id: 1, name_key: "王大明", record_status: "void", is_child: false },
  ];
  const children = [
    { district_id: 1, parent_name_key: "王爸爸", serial_no: 3, full_name: "王大明" },
    { district_id: 1, parent_name_key: "王爸爸", serial_no: 5, full_name: "王小明" },
    { district_id: 1, parent_name_key: "王大明", serial_no: 6, full_name: "王小華" },
  ];
  childrenByParent(rows, children);
  assert.deepEqual(rows.map((row) => row.children), [
    [{ serial_no: 3, full_name: "王大明" }, { serial_no: 5, full_name: "王小明" }], [], undefined, undefined,
  ]);
});
