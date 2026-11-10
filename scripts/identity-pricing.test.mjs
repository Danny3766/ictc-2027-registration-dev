// site/meals.js runs in the browser without modules, so it is loaded into a VM context here.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const Meals = vm.runInNewContext(`${readFileSync(new URL("../site/meals.js", import.meta.url), "utf8")}; Meals`);
Meals.configure([
  { code: "general", name: "一般", is_active: true, public_selectable: true },
  { code: "child", name: "兒童", is_active: true, public_selectable: true },
  { code: "volunteer", name: "志工", is_active: false, public_selectable: false },
]);

test("identity prices use the current price, keep 0, and preserve unset prices", () => {
  const activity = { fee_amount: 120, activity_identity_prices: [
    { identity_code: "child", fee_amount: 80 }, { identity_code: "volunteer", fee_amount: 0 },
  ] };
  assert.equal(Meals.fee(activity, "child"), 80);
  assert.equal(Meals.fee(activity, "volunteer"), 0);
  assert.equal(Meals.fee(activity, "student"), null);
  assert.equal(Meals.fee(activity, null), null);
  activity.activity_identity_prices[0].fee_amount = 90;
  assert.equal(Meals.fee(activity, "child"), 90);
});

test("the price text leaves out identities nobody can pick and names 一般 only beside another price", () => {
  assert.equal(Meals.priceText({ fee_amount: 120, activity_identity_prices: [
    { identity_code: "child", fee_amount: 90 }, { identity_code: "volunteer", fee_amount: 0 },
  ] }), "一般 NT$120／人，兒童 NT$90／人");
  assert.equal(Meals.priceText({ fee_amount: 120, activity_identity_prices: [{ identity_code: "volunteer", fee_amount: 0 }] }),
    "一般 NT$120／人");
  assert.equal(Meals.priceText({ fee_amount: null, activity_identity_prices: [] }), "");
});

test("the identity counts toward fees only while a published meal is attended", () => {
  const attending = [{ activity_id: 1, attending: true }];
  assert.equal(Meals.needsIdentity([{ id: 1, category: "meal" }], attending), true);
  assert.equal(Meals.needsIdentity([{ id: 1, category: "meeting" }], attending), false);
  assert.equal(Meals.needsIdentity([{ id: 1, category: "meal", is_published: false }], attending), false);
});

test("unset fees are left out of totals but counted, and zero remains free", () => {
  assert.equal(Meals.fee({ fee_amount: null }, "general"), null);
  assert.equal(Meals.fee({ fee_amount: 0 }, "general"), 0);
  assert.deepEqual({ ...Meals.addFees([80, null, 0]) }, { sum: 80, known: 2, missing: 1 });
  assert.deepEqual({ ...Meals.addFees([]) }, { sum: 0, known: 0, missing: 0 });
});
