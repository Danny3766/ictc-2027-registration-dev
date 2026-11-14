// site/meals.js runs in the browser without modules, so it is loaded into a VM context here.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// Each context has its own configure() state.
const loadMeals = () => vm.runInNewContext(`${readFileSync(new URL("../site/meals.js", import.meta.url), "utf8")}; Meals`);
const Meals = loadMeals();
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

test("the price text leaves out identities nobody can pick and unset prices", () => {
  assert.equal(Meals.priceText({ fee_amount: 120, activity_identity_prices: [
    { identity_code: "volunteer", fee_amount: 0 }, { identity_code: "child", fee_amount: 90 },
  ] }), "一般 NT$120／人，兒童 NT$90／人");
  assert.equal(Meals.priceText({ fee_amount: 120, activity_identity_prices: [{ identity_code: "volunteer", fee_amount: 0 }] }),
    "一般 NT$120／人");
  assert.equal(Meals.priceText({ fee_amount: null, activity_identity_prices: [] }), "");
});

test("free identities are joined at the end, and 免費 alone needs every identity priced 0", () => {
  const Free = loadMeals();
  const codes = ["general", "friend", "student", "child", "preschool"];
  Free.configure(["聖徒", "親友", "學生", "兒童（國小）", "兒童（學齡前）"]
    .map((name, index) => ({ code: codes[index], name, is_active: true, public_selectable: true })));
  // Amounts in 身分別 order; null leaves the price unset. The prices arrive in another order on purpose.
  const priced = (general, ...others) => ({ fee_amount: general, activity_identity_prices: others
    .map((amount, index) => ({ identity_code: codes[index + 1], fee_amount: amount }))
    .filter((price) => price.fee_amount != null).reverse() });
  assert.equal(Free.priceText(priced(400, 400, 200, 0, 0)),
    "聖徒、親友 NT$400／人，學生 NT$200／人，兒童（國小）、兒童（學齡前）免費");
  // Same-priced identities that are not next to each other join where the first one stands.
  assert.equal(Free.priceText(priced(500, 300, 500, null, null)), "聖徒、學生 NT$500／人，親友 NT$300／人");
  assert.equal(Free.priceText(priced(400, 0, 200, 0, null)), "聖徒 NT$400／人，學生 NT$200／人，親友、兒童（國小）免費");
  assert.equal(Free.priceText(priced(0, 0, 0, 0, 0)), "免費");
  assert.equal(Free.priceText(priced(0, 0, 0, 0, null)), "聖徒、親友、學生、兒童（國小）免費");
  assert.equal(Free.priceText(priced(null, 0, 0, 0, 0)), "親友、學生、兒童（國小）、兒童（學齡前）免費");
});

test("paid prices follow the 身分別 order even when 一般 is not first", () => {
  const Moved = loadMeals();
  Moved.configure([["student", "學生"], ["general", "聖徒"], ["child", "兒童"]]
    .map(([code, name]) => ({ code, name, is_active: true, public_selectable: true })));
  assert.equal(Moved.priceText({ fee_amount: 400, activity_identity_prices: [
    { identity_code: "child", fee_amount: 0 }, { identity_code: "student", fee_amount: 200 },
  ] }), "學生 NT$200／人，聖徒 NT$400／人，兒童免費");
});

test("the back office also lists staff-only identities, the public page does not", () => {
  const Scoped = loadMeals();
  const items = [{ code: "general", name: "一般", is_active: true, public_selectable: true },
    { code: "helper", name: "服事者", is_active: true, public_selectable: false }];
  const activity = { fee_amount: 0, activity_identity_prices: [{ identity_code: "helper", fee_amount: 50 }] };
  Scoped.configure(items);
  assert.equal(Scoped.priceText(activity), "免費");
  Scoped.configure(items, true);
  assert.equal(Scoped.priceText(activity), "服事者 NT$50／人，一般免費");
});

test("一般 priced 0 counts as free", () => {
  assert.equal(Meals.priceText({ fee_amount: 0, activity_identity_prices: [{ identity_code: "child", fee_amount: 90 }] }),
    "兒童 NT$90／人，一般免費");
  assert.equal(Meals.priceText({ fee_amount: 0, activity_identity_prices: [{ identity_code: "child", fee_amount: 0 }] }), "免費");
  // A stopped identity is not listed, so its price does not keep 免費 from standing alone.
  assert.equal(Meals.priceText({ fee_amount: 0, activity_identity_prices: [
    { identity_code: "child", fee_amount: 0 }, { identity_code: "volunteer", fee_amount: 50 },
  ] }), "免費");
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
