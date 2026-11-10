import { expect, test } from "@playwright/test";

// Fictional identities: one staff-only, one stopped.
const identities = [
  { code: "general", name: "一般", is_active: true, public_selectable: true },
  { code: "child", name: "兒童", is_active: true, public_selectable: true },
  { code: "preschool", name: "兒童（學齡前）", is_active: true, public_selectable: true },
  { code: "volunteer", name: "志工", is_active: true, public_selectable: false },
  { code: "retired", name: "舊身分", is_active: false, public_selectable: true },
];

test("the public form hides staff-only and stopped identities, picks 兒童 for a child, and keeps a stored identity", async ({ page }) => {
  await page.goto("/");
  await page.setContent('<form><input type="radio" name="activity_1" value="true" checked></form>');
  await page.addScriptTag({ url: "/meals.js" });
  const sync = (context) => page.evaluate((context) => Meals.sync(document.querySelector("form"), window.meals, context), context);
  await page.evaluate((items) => {
    window.meals = [{ id: 1, category: "meal" }];
    Meals.configure(items);
    Meals.render(document.querySelector("form"), window.meals);
  }, identities);
  await sync({});
  await expect(page.getByLabel("一般", { exact: true })).toBeVisible();
  await expect(page.getByLabel("志工", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("舊身分", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("兒童", { exact: true })).toBeHidden();

  await sync({ isChild: true });
  await expect(page.getByLabel("兒童", { exact: true })).toBeChecked();
  expect(await page.evaluate(() => Meals.readIdentity(document.querySelector("form")))).toBe("child");
  await sync({ isChild: true, childType: "preschool" });
  await expect(page.getByLabel("兒童（學齡前）", { exact: true })).toBeChecked();
  expect(await page.evaluate(() => Meals.readIdentity(document.querySelector("form")))).toBe("preschool");
  await sync({});
  await expect(page.getByLabel("一般", { exact: true })).toBeChecked();

  // A registration that has the stopped identity still sees it, chosen.
  await page.evaluate(() => {
    document.querySelector(".meal-identity").remove();
    Meals.render(document.querySelector("form"), window.meals, "retired");
  });
  await sync({});
  await expect(page.getByLabel("舊身分", { exact: true })).toBeChecked();

  // No meal attended: the question hides and sends nothing.
  await page.locator('[name="activity_1"]').evaluate((input) => { input.checked = false; });
  await sync({});
  await expect(page.locator(".meal-identity")).toBeHidden();
  expect(await page.evaluate(() => Meals.readIdentity(document.querySelector("form")))).toBeNull();
});
