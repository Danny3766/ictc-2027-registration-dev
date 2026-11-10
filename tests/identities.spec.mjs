import { expect, test } from "@playwright/test";

// Fictional identities: one staff-only, one stopped.
const identities = [
  { code: "general", name: "一般", is_active: true, public_selectable: true },
  { code: "child", name: "兒童", is_active: true, public_selectable: true },
  { code: "preschool", name: "兒童（學齡前）", is_active: true, public_selectable: true },
  { code: "volunteer", name: "志工", is_active: true, public_selectable: false },
  { code: "retired", name: "舊身分", is_active: false, public_selectable: true },
];

test("identity dropdown preserves stored restricted identities and supports children without meals", async ({ page }) => {
  await page.goto("/");
  await page.setContent('<form><select name="meal_identity" required></select></form>');
  await page.addScriptTag({ url: "/meals.js" });
  await page.evaluate((items) => {
    Meals.configure(items);
    Meals.renderIdentity(document.querySelector("select"));
  }, identities);
  const select = page.locator("select");
  await expect(select.locator("option")).toHaveText(["請選擇", "一般", "兒童", "兒童（學齡前）"]);
  expect(await page.locator("form").evaluate((form) => form.checkValidity())).toBe(false);
  await select.selectOption("preschool");
  expect(await page.evaluate(() => Meals.childType(Meals.readIdentity(document.querySelector("form"))))).toBe("preschool");
  await page.evaluate(() => Meals.renderIdentity(document.querySelector("select"), "retired"));
  await expect(select).toHaveValue("retired");
  await select.selectOption("general");
  expect(await page.evaluate(() => Meals.childType(Meals.readIdentity(document.querySelector("form"))))).toBe("");
});
