import { expect, test } from "@playwright/test";

test.skip(process.env.RUN_LIVE_REGISTRATION_TEST !== "1", "Creates a remote registration; run only with test-data cleanup ready.");

test("建立、以姓名與區查詢並儲存登記", async ({ page }) => {
  const name = `自動測試 ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "送出登記" })).toBeEnabled();
  await page.locator('#registration-form input[name="full_name"]').fill(name);
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  for (const activity of await page.locator("#registration-form .activity").all()) {
    await activity.locator('input[value="false"]').check();
  }
  await page.waitForTimeout(3_100);
  await page.getByRole("button", { name: "送出登記" }).click();

  await expect(page).toHaveURL(/success\.html$/);
  await expect(page.locator("#summary-identity")).toContainText(name);
  await page.getByRole("link", { name: "回登記頁" }).click();

  // Same name typed with different case and spacing must still find the record.
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await page.locator('#query-form input[name="full_name"]').fill(` ${name.replace(" ", "  ")} `);
  await page.locator('#query-form select[name="district_id"]').selectOption("1");
  await page.getByRole("button", { name: "查詢" }).click();
  await expect(page.locator("#edit-identity")).toContainText(name);

  await page.locator("#edit-form .activity").first().locator('input[value="true"]').check();
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator("#page-message")).toHaveText("登記資料已儲存。");

  await page.getByRole("tab", { name: "登記參加" }).click();
  await page.locator('#registration-form input[name="full_name"]').fill(name);
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  for (const activity of await page.locator("#registration-form .activity").all()) {
    await activity.locator('input[value="false"]').check();
  }
  // The page reload above restarted the minimum fill time, so wait again before submitting.
  await page.waitForTimeout(3_100);
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page.locator("#page-message")).toContainText("已經登記過");
});
