import { expect, test } from "@playwright/test";

async function expectEqualIdentityColumns(fields) {
  // 身分別 wraps to its own row on phones, so only name and 區 are compared as the two equal columns.
  const boxes = await fields.locator(":scope > label:not(.identity-select)").evaluateAll((labels) => labels.map((label) => {
    const { x, y, width } = label.getBoundingClientRect();
    return { x, y, width };
  }));
  expect(boxes).toHaveLength(2);
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(1);
  expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThan(1);
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
}

const openPage = (open = true) => ({
  settings: { event_name: "測試活動", venue: "", address: "", is_registration_open: open, registration_deadline_at: null },
  districts: [{ id: 1, name: "測試區" }, { id: 2, name: "第二區" }],
  activities: [{ id: 1, title: "測試活動", description: null }],
  program: [],
});

const queried = (canChange) => ({
  full_name: "測試登記", district_id: 1, can_change: canChange,
  choices: [{ activity_id: 1, title: "測試活動", attending: true }],
});

// An invalid form is what keeps a submit from being sent, so check it rather than a request count alone.
const registrationFormValid = (page) => page.locator("#registration-form").evaluate((form) => form.checkValidity());

async function query(page, name = "測試登記", district = "1") {
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await page.locator('#query-form input[name="full_name"]').fill(name);
  await page.locator('#query-form select[name="district_id"]').selectOption(district);
  await page.getByRole("button", { name: "查詢" }).click();
}

test("returning to the page starts both name fields empty, so a shared device does not show the previous name", async ({ page }) => {
  await page.route("**/functions/v1/registration", (route) => route.fulfill({ json: openPage() }));
  await page.goto("/");
  await page.locator('#registration-form input[name="full_name"]').fill("前一位登記者");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await page.locator('#query-form input[name="full_name"]').fill("前一位查詢者");
  // Leaving and pressing 上一頁 makes the browser refill the form, as a reload does in real browsers
  // (page.reload() in tests does not).
  await page.goto("/admin/");
  await page.goBack();
  await expect(page.locator("#activities .activity")).not.toHaveCount(0);
  await expect(page.locator('#registration-form input[name="full_name"]')).toHaveValue("");
  await expect(page.locator('#query-form input[name="full_name"]')).toHaveValue("");
  // A page restored whole from the back/forward cache (which tests cannot force) clears the names too.
  await page.locator('#registration-form input[name="full_name"]').fill("前一位登記者");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await page.locator('#query-form input[name="full_name"]').fill("前一位查詢者");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator('#registration-form input[name="full_name"]')).toHaveValue("");
  await expect(page.locator('#query-form input[name="full_name"]')).toHaveValue("");
});

test("an activity's map link opens in a new tab, and only http(s) links are shown", async ({ page }) => {
  await page.route("**/functions/v1/registration", (route) => route.fulfill({ json: { ...openPage(), activities: [
    { id: 1, title: "有地圖", map_url: "https://share.google/abc123" },
    { id: 2, title: "壞連結", map_url: "javascript:alert(1)" },
  ] } }));
  await page.goto("/");
  const links = page.locator("#activities a");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveText("查看地圖");
  await expect(links).toHaveAttribute("href", "https://share.google/abc123");
  await expect(links).toHaveAttribute("target", "_blank");
});

test("the query tab does not show map links, in the summary or while editing", async ({ page }) => {
  const activities = [{ id: 1, title: "測試活動", map_url: "https://share.google/abc123" }];
  await page.route("**/functions/v1/registration", (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === "query") return route.fulfill({ json: queried(true) });
    return route.fulfill({ json: { ...openPage(), activities } });
  });
  await page.goto("/");
  await expect(page.locator("#activities a")).toHaveText("查看地圖");
  await query(page);
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");
  await expect(page.locator("#edit-activities a")).toHaveCount(0);
  await page.locator("#start-edit").click();
  await expect(page.locator('#edit-activities input[name="activity_1"]').first()).toBeVisible();
  await expect(page.locator("#edit-activities a")).toHaveCount(0);
});

test("closed registration remains queryable by name and district and disables edits", async ({ page }) => {
  const bodies = [];
  await page.route("**/functions/v1/registration", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({ json: { ...openPage(false), program: [
        { event_date: "2027-02-20", start_time: "12:30:00", end_time: "14:00:00", title: "第一堂聚會", note: null },
        { event_date: "2027-02-21", start_time: "09:00:00", end_time: null, title: "第四堂聚會", note: null },
      ] } });
    }
    bodies.push(request.postDataJSON());
    return route.fulfill({ json: queried(false) });
  });

  await page.goto("/");
  await expect(page.locator(".program-day")).toHaveCount(2);
  await expect(page.locator(".program-day").first()).toContainText(/2月20日\s*星期六/);
  await expect(page.locator(".program-day").first()).toContainText("12:30–14:00");
  await expect(page.locator('#registration-form button[type="submit"]')).toBeDisabled();
  await query(page, "  測試登記  ");

  await expect(page.locator("#edit-form")).toBeVisible();
  // Name and 區 show in read-only boxes; nothing in the form can be changed.
  await expect(page.locator("#edit-full-name")).toHaveValue("測試登記");
  await expect(page.locator("#edit-district")).toHaveValue("測試區");
  await expect(page.locator('#edit-form input[name="full_name"]')).toHaveCount(0);
  await expect(page.locator("#edit-form select:not([disabled])")).toHaveCount(0);
  await expect(page.locator("#edit-form input:not([readonly]):not([disabled])")).toHaveCount(0);
  await expect(page.locator("#edit-form").getByRole("combobox", { name: "身分別", exact: true })).toHaveValue("general");
  await expect(page.getByRole("button", { name: "修改登記內容" })).toBeHidden();
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");
  await expect(page.locator("#page-message")).toHaveText("目前只能查看，無法修改登記內容。");
  expect(bodies).toEqual([{ action: "query", full_name: "測試登記", district_id: 1 }]);
  await expectEqualIdentityColumns(page.locator("#query-form .identity-fields"));

  for (const width of [360, 768, 1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px horizontal overflow`).toBeLessThanOrEqual(width);
    await expect(page.locator("#program-section")).toBeVisible();
    await expect(page.locator("#query-form")).toBeVisible();
  }
});

test("a passed deadline closes the form even while registration is switched on", async ({ page }) => {
  const settings = (deadline) => ({ ...openPage(), settings: { ...openPage().settings, registration_deadline_at: deadline } });
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  let deadline = past;
  await page.route("**/functions/v1/registration", (route) => route.fulfill({ json: settings(deadline) }));

  await page.goto("/");
  await expect(page.locator('#registration-form button[type="submit"]')).toBeDisabled();
  await expect(page.locator("#page-message")).toHaveText("登記已截止。");

  deadline = future;
  await page.reload();
  await expect(page.locator('#registration-form button[type="submit"]')).toBeEnabled();
  await expect(page.locator("#page-message")).not.toHaveText("登記已截止。");
});

test("a query that finds nothing shows the server message", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: openPage() });
    return route.fulfill({ status: 404, json: { error: "查無登記資料，請確認姓名寫法與區和登記時相同" } });
  });
  await page.goto("/");
  await query(page, "不存在");
  await expect(page.locator("#page-message")).toHaveText("查無登記資料，請確認姓名寫法與區和登記時相同");
  await expect(page.locator("#edit-form")).toBeHidden();
});

test("query is read-only until editing and returns to confirmation after saving", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: openPage() });
    const body = request.postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: queried(true) });
    return route.fulfill({ json: { success: true } });
  });

  await page.goto("/");
  await query(page);
  await expect(page.locator("#page-message")).toHaveText("以下為目前登記內容。");
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const attending = page.locator('#edit-form input[name="activity_1"][value="true"]');
  const notAttending = page.locator('#edit-form input[name="activity_1"][value="false"]');
  const save = page.getByRole("button", { name: "儲存修改" });
  await expect(save).toBeDisabled();
  await notAttending.check();
  await expect(save).toBeEnabled();
  await attending.check();
  await expect(save).toBeDisabled();
  expect(requests.map(({ action }) => action)).toEqual(["query"]);

  await notAttending.check();
  await save.click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[1]).toEqual({
    action: "update", full_name: "測試登記", district_id: 1, choices: [{ activity_id: 1, attending: false }],
    meal_identity: "general", is_child: false, child_type: "", parent_name: null,
  });
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：不參加");
  await expect(page.getByRole("button", { name: "修改登記內容" })).toBeVisible();
  expect(requests.map(({ action }) => action)).toEqual(["query", "update"]);
});

test("cancel, tab changes, and another query protect unsaved edits", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: openPage() });
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ json: queried(true) });
  });

  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await page.locator('#edit-form input[name="activity_1"][value="false"]').check();

  page.once("dialog", async (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "取消修改" }).click();
  await expect(page.locator('#edit-form input[name="activity_1"][value="false"]')).toBeChecked();

  page.once("dialog", async (dialog) => dialog.dismiss());
  await page.getByRole("tab", { name: "登記參加" }).click();
  await expect(page.getByRole("tab", { name: "查詢或修改登記" })).toHaveAttribute("aria-selected", "true");

  await page.locator('#query-form input[name="full_name"]').fill("另一個人");
  page.once("dialog", async (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "查詢" }).click();
  expect(requests).toHaveLength(1);
  await expect(page.locator('#edit-form input[name="activity_1"][value="false"]')).toBeChecked();
  expect(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);

  page.once("dialog", async (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消修改" }).click();
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");

  await page.getByRole("button", { name: "修改登記內容" }).click();
  await page.locator('#edit-form input[name="activity_1"][value="false"]').check();
  page.once("dialog", async (dialog) => dialog.accept());
  await page.getByRole("tab", { name: "登記參加" }).click();
  await expect(page.getByRole("tab", { name: "登記參加" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");

  await page.getByRole("button", { name: "修改登記內容" }).click();
  await page.locator('#edit-form input[name="activity_1"][value="false"]').check();
  page.once("dialog", async (dialog) => dialog.accept());
  await page.getByRole("button", { name: "查詢" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);
});

test("an unanswered activity stays explicit until the registrant chooses", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: openPage() });
    return route.fulfill({ json: {
      ...queried(true), choices: [{ activity_id: 1, title: "測試活動", attending: null }],
    } });
  });

  await page.goto("/");
  await query(page);
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：未回覆");
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeDisabled();
  await page.locator('#edit-form input[name="activity_1"][value="false"]').check();
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeEnabled();
});

test("temporary save errors keep edits while a closed registration returns to confirmation", async ({ page }) => {
  let updateCount = 0;
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: openPage() });
    const body = route.request().postDataJSON();
    if (body.action === "query") return route.fulfill({ json: queried(true) });
    updateCount += 1;
    return updateCount === 1
      ? route.fulfill({ status: 503, json: { error: "服務暫時無法使用" } })
      : route.fulfill({ status: 409, json: { error: "登記已截止，資料只能查看" } });
  });

  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const notAttending = page.locator('#edit-form input[name="activity_1"][value="false"]');
  await notAttending.check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("服務暫時無法使用");
  await expect(notAttending).toBeChecked();
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeEnabled();

  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("登記已截止，資料只能查看");
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");
  await expect(page.getByRole("button", { name: "修改登記內容" })).toBeHidden();
});

test("starting a new query prevents the previous form from being saved", async ({ page }) => {
  const requests = [];
  let releasePendingQuery;
  let queryCount = 0;
  await page.route("**/functions/v1/registration", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: openPage() });
    const body = request.postDataJSON();
    requests.push(body);
    if (body.action === "query") {
      queryCount += 1;
      if (queryCount === 2) await new Promise((resolve) => { releasePendingQuery = resolve; });
      return route.fulfill({ json: queried(true) });
    }
    return route.fulfill({ json: { success: true } });
  });

  await page.goto("/");
  await query(page);
  await expect(page.locator("#edit-form")).toBeVisible();

  await page.locator('#query-form input[name="full_name"]').fill("另一個人");
  await page.getByRole("button", { name: "查詢" }).click();
  await expect(page.locator("#edit-form")).toBeHidden();
  await page.locator("#edit-form").dispatchEvent("submit");
  await expect(page.locator("#page-message")).toHaveText("請先查詢登記資料。");
  expect(requests.map(({ action }) => action)).toEqual(["query", "query"]);

  releasePendingQuery();
  await expect(page.locator("#edit-form")).toBeVisible();
});

test("a name and district already registered is refused with the server message", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: openPage() });
    return route.fulfill({ status: 409, json: { error: "此姓名與區已經登記過，如需查看或修改，請使用「查詢或修改登記」" } });
  });
  await page.goto("/");
  await page.locator('#registration-form input[name="full_name"]').fill("測試登記");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page.locator("#page-message")).toHaveText("此姓名與區已經登記過，如需查看或修改，請使用「查詢或修改登記」");
  await expect(page).not.toHaveURL(/success\.html$/);
});

test("registration tabs and success page show what was submitted", async ({ page }) => {
  let submitted;
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { ...openPage(), activities: [
        { id: 1, title: "測試活動", starts_at: "2027-02-21T00:00:00+08:00", starts_at_has_time: false, description: null },
        {
          id: 2, title: "週六午餐", starts_at: "2027-02-20T12:30:00+08:00", starts_at_has_time: true,
          ends_at: "2027-02-20T14:00:00+08:00", ends_at_has_time: true,
          venue: "測試餐廳", address: "測試地址", fee_amount: 250, description: "用餐時間待確認",
        },
      ] } });
    }
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { success: true } });
  });

  await page.goto("/");
  await expect(page.getByRole("tab", { name: "登記參加" })).toHaveAttribute("aria-selected", "true");
  await expectEqualIdentityColumns(page.locator("#registration-form .identity-fields"));
  await expect(page.locator("#query-form")).toBeHidden();
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await expect(page.locator("#query-form")).toBeVisible();
  await expect(page.locator('#query-form select[name="district_id"] option')).toHaveCount(3);
  await page.getByRole("tab", { name: "登記參加" }).click();
  await expect(page.locator("#hosting-section")).toBeHidden();
  await expect(page.locator("#activities .activity").first()).toContainText("時間：2/21");
  await expect(page.locator("#activities .activity").first()).not.toContainText("00:00");
  await expect(page.locator("#activities .activity").nth(1)).toContainText("時間：2/20 12:30–14:00");
  await expect(page.locator("#activities")).toContainText("負擔費用：NT$250／人");
  await page.locator('#registration-form input[name="full_name"]').fill(" David Wang ");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("2");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.locator('#registration-form input[name="activity_2"][value="false"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();

  await expect(page).toHaveURL(/success\.html$/);
  expect(submitted.hosting).toBeUndefined();
  expect(submitted.choices).toEqual([
    { activity_id: 1, attending: true },
    { activity_id: 2, attending: false },
  ]);
  await expect(page.locator("#summary-identity")).toHaveText("David Wang｜第二區");
  await expect(page.locator("#summary-choices li")).toHaveText(["測試活動：參加", "週六午餐：不參加", "身分別：一般"]);
  await expect(page.getByText("查詢碼")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "回登記頁" })).toBeEnabled();
  // A reload (for example mobile Safari restoring the tab) keeps the summary.
  await page.reload();
  await expect(page.locator("#summary-identity")).toHaveText("David Wang｜第二區");
  // Going back to the form clears it, so the next person on a shared device cannot reopen it.
  await page.getByRole("link", { name: "回登記頁" }).click();
  // The button is static HTML; the rendered activities show app.js has run and cleared the summary.
  await expect(page.locator("#activities .activity")).toHaveCount(2);
  await page.goto("/success.html");
  await expect(page).not.toHaveURL(/success\.html$/);
});

const hostingPage = (open) => ({
  ...openPage(),
  settings: { ...openPage().settings, is_hosting_open: open, hosting_description: "接待期間 2/19（五）～2/22（一）" },
});
const brothers = { status: "hosting", guest_type: "brother", guest_count: 2 };

test("公開接待區塊只顯示一個開家標題，接機問題使用相同字體", async ({ page }) => {
  let pickupOpen = false;
  await page.route("**/functions/v1/registration", (route) => route.fulfill({ json: {
    ...hostingPage(true), settings: { ...hostingPage(true).settings, is_pickup_open: pickupOpen },
  } }));
  await page.goto("/");
  const section = page.locator("#hosting-section");
  await expect(section.locator("legend")).toHaveText("開家接待");
  await expect(section.locator(".hosting-survey > .hosting-question")).toHaveCount(0);
  await expect(section.locator(".pickup-survey")).toBeHidden();

  pickupOpen = true;
  await page.reload();
  await expect(section.locator("legend")).toHaveText("開家接待");
  await expect(section.locator(".hosting-survey > .hosting-question")).toHaveCount(0);
  await expect(section.locator(".pickup-heading")).toHaveText("接機接待");
  await expect(section.locator(".pickup-heading")).toBeVisible();
  await expect(section.locator(".pickup-survey")).toHaveCSS("border-top-style", "solid");
  await expect(section.locator(".pickup-survey")).toHaveCSS("margin-top", "28px");
  await expect(section.locator(".pickup-question")).toHaveText("2/19 或之前可以配搭接機幾位？");
  const styles = await section.evaluate((element) => {
    const legend = getComputedStyle(element.querySelector("legend"));
    const pickup = getComputedStyle(element.querySelector(".pickup-question"));
    return [legend.fontFamily, legend.fontSize, legend.fontWeight, pickup.fontFamily, pickup.fontSize, pickup.fontWeight];
  });
  expect(styles.slice(0, 3)).toEqual(styles.slice(3));
  await expect(section.locator(".pickup-heading")).toHaveCSS("font-weight", styles[2]);
});

test("接機獨立開放時，沒有開家的人能填寫並在查詢頁修改", async ({ page }) => {
  const requests = [];
  const settings = { ...hostingPage(false).settings, is_pickup_open: true, pickup_description: "同車只填一人" };
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ...openPage(), settings } });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: null, pickup: { status: "yes", count: 2 } } });
    return route.fulfill({ status: body.action === "create" ? 201 : 200, json: { success: true } });
  });
  await page.goto("/");
  const section = page.locator("#hosting-section");
  await expect(section.locator("legend")).toHaveText("接機接待");
  await expect(section.locator(".hosting-survey")).toBeHidden();
  await expect(section.locator(".pickup-heading")).toBeHidden();
  await expect(section.locator(".pickup-survey")).toHaveCSS("border-top-style", "none");
  await expect(section.locator(".pickup-question")).toHaveCSS("font-weight", "400");
  await expect(section).toContainText("同車只填一人");
  await page.locator('#registration-form input[name="full_name"]').fill("接機測試");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(requests).toHaveLength(0);
  await section.locator('[name="pickup_status"][value="yes"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(requests).toHaveLength(0);
  await section.locator('[name="pickup_count"]').selectOption("2");
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(requests[0].hosting).toBeUndefined();
  expect(requests[0].pickup).toEqual({ status: "yes", count: 2 });
  await expect(page.locator("#summary-choices")).toContainText("接機接待：是，可接機 2 位");
  await page.goto("/");
  await query(page);
  await expect(page.locator("#edit-hosting-section")).toContainText("接機接待：是，可接機 2 位");
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await page.locator('#edit-pickup [name="pickup_status"][value="no"]').check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  expect(requests.at(-1).pickup).toEqual({ status: "no", count: 0 });
  expect(requests.at(-1).hosting).toBeUndefined();
});

test("while hosting is open, a new registration must answer it and the success page shows it", async ({ page }) => {
  const submitted = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(true) });
    submitted.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const section = page.locator("#hosting-section");
  await expect(section).toContainText("接待期間 2/19（五）～2/22（一）");
  await expect(section).toContainText("同一家只需一人登記開家接待");
  // On both forms the hosting section comes before the activity choices.
  expect(await page.evaluate(() => [["#hosting-section", "#activities"], ["#edit-hosting-section", "#edit-activities"]]
    .every(([hosting, activities]) => document.querySelector(hosting)
      .compareDocumentPosition(document.querySelector(activities)) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.locator('#registration-form input[name="full_name"]').fill("接待測試");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(await registrationFormValid(page)).toBe(false);
  expect(submitted).toHaveLength(0);

  await expect(section.getByRole("radiogroup", { name: "是否可以開家接待？" })).toBeVisible();
  await expect(section.locator(".hosting-details")).toBeHidden();
  await section.getByLabel("否", { exact: true }).check();
  await section.getByLabel("是", { exact: true }).check();
  await expect(section.locator(".hosting-details")).toBeVisible();
  await expect(section.locator("textarea")).toHaveCount(0);
  const count = section.getByLabel("可以接待幾位？");
  await expect(count.locator("option")).toHaveText(["請選擇", ...Array.from({ length: 10 }, (_, index) => `${index + 1} 位`)]);
  await expect(section.getByLabel("接待對象").locator("option")).toHaveText(["請選擇", "夫婦", "弟兄", "姊妹", "不拘"]);
  // Both dropdowns start at 請選擇, so neither can be sent without a choice.
  await count.selectOption("3");
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(await registrationFormValid(page)).toBe(false);
  expect(submitted).toHaveLength(0);

  await section.getByLabel("接待對象").selectOption({ label: "夫婦" });
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(submitted[0].hosting).toEqual({ status: "hosting", guest_type: "couple", guest_count: 3 });
  expect(submitted[0].pickup).toBeUndefined();
  await expect(page.locator("#summary-choices li").last()).toHaveText("開家接待：是，可接待 3 位（夫婦）");
});

test("an open hosting answer is confirmed first and saved with the registration", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(true) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: brothers } });
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  const hosting = page.locator("#edit-hosting-section");
  await expect(hosting).toContainText("開家接待：是，可接待 2 位（弟兄）");
  await expect(hosting.locator("input, select")).toHaveCount(0);
  // The description asks for an answer, so it appears only once the answer can be changed.
  await expect(hosting.locator(".hosting-description")).toBeHidden();

  await page.getByRole("button", { name: "修改登記內容" }).click();
  const save = page.getByRole("button", { name: "儲存修改" });
  await expect(hosting.locator(".hosting-description")).toHaveText("接待期間 2/19（五）～2/22（一）");
  await expect(hosting.getByLabel("是", { exact: true })).toBeChecked();
  await expect(hosting.getByLabel("接待對象")).toHaveValue("brother");
  await expect(hosting.getByLabel("可以接待幾位？")).toHaveValue("2");
  await hosting.getByLabel("可以接待幾位？").selectOption("3");
  await expect(save).toBeEnabled();
  await hosting.getByLabel("可以接待幾位？").selectOption("2");
  await expect(save).toBeDisabled();
  await hosting.getByLabel("否", { exact: true }).check();
  await expect(hosting.locator(".hosting-details")).toBeHidden();
  await save.click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[1].hosting).toEqual({ status: "not_hosting", guest_type: null, guest_count: null });
  await expect(hosting).toContainText("開家接待：否");
});

test("while hosting is closed, the lookup shows the answer read-only and saves activities without it", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(false) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: brothers } });
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await expect(page.locator("#hosting-section")).toBeHidden();
  await query(page);
  const hosting = page.locator("#edit-hosting-section");
  await expect(hosting).toContainText("開家接待：是，可接待 2 位（弟兄）");
  await expect(hosting).toContainText("開家接待調查已關閉，如需調整請聯絡服事者");
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await expect(hosting.locator("input, select")).toHaveCount(0);
  await page.locator('#edit-form input[name="activity_1"][value="false"]').check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[1]).toEqual({ action: "update", full_name: "測試登記", district_id: 1, choices: [{ activity_id: 1, attending: false }],
    meal_identity: "general", is_child: false, child_type: "", parent_name: null });
});

test("a lookup without a hosting answer hides the section while hosting is closed", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(false) });
    return route.fulfill({ json: { ...queried(true), hosting: null } });
  });
  await page.goto("/");
  await query(page);
  await expect(page.locator("#edit-activities")).toContainText("登記狀態：參加");
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
});

const hostingRequired = { status: 409, json: { error: "開家接待調查已開放，請回答開家接待；看不到接待欄位時請重新整理頁面", code: "HOSTING_REQUIRED" } };
const hostingClosed = { status: 409, json: { error: "開家接待調查已關閉", code: "HOSTING_CLOSED" } };
const hostingRequiredWithDescription = { ...hostingRequired, json: { ...hostingRequired.json, hosting_description: "接待期間 2/19（五）～2/22（一）" } };
const closedWithoutDescription = { ...openPage(), settings: { ...openPage().settings, is_hosting_open: false, hosting_description: null } };

test("hosting opened after the page loaded shows its fields instead of failing every retry", async ({ page }) => {
  const submitted = [];
  await page.route("**/functions/v1/registration", async (route) => {
    // The page loads before the admin writes the description and opens the switch.
    if (route.request().method() === "GET") return route.fulfill({ json: closedWithoutDescription });
    submitted.push(route.request().postDataJSON());
    if (submitted.length > 1) return route.fulfill({ status: 201, json: { success: true } });
    return route.fulfill(hostingRequiredWithDescription);
  });
  await page.goto("/");
  const section = page.locator("#hosting-section");
  await expect(section).toBeHidden();
  await page.locator('#registration-form input[name="full_name"]').fill("接待測試");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page.locator("#page-message")).toHaveText("開家接待調查已開放，請回答開家接待後再按「送出登記」。");
  await expect(section).toBeVisible();
  await expect(section).toContainText("接待期間 2/19（五）～2/22（一）");
  await expect(page.locator('#registration-form input[name="full_name"]')).toHaveValue("接待測試");
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(await registrationFormValid(page)).toBe(false);
  expect(submitted).toHaveLength(1);
  await section.getByLabel("否", { exact: true }).check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(submitted[1].hosting).toEqual({ status: "not_hosting", guest_type: null, guest_count: null });
});

test("hosting closed during an edit keeps the activity edits and drops only the hosting change", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(true) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: brothers } });
    return route.fulfill(requests.length === 2 ? hostingClosed : { json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const notAttending = page.locator('#edit-form input[name="activity_1"][value="false"]');
  await notAttending.check();
  const hosting = page.locator("#edit-hosting-section");
  await hosting.getByLabel("可以接待幾位？").selectOption("3");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("開家接待調查已關閉，接待內容維持原樣，請再按一次「儲存修改」。");
  await expect(notAttending).toBeChecked();
  await expect(hosting.locator("input, select")).toHaveCount(0);
  await expect(hosting).toContainText("開家接待：是，可接待 2 位（弟兄）");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[2]).toEqual({ action: "update", full_name: "測試登記", district_id: 1, choices: [{ activity_id: 1, attending: false }],
    meal_identity: "general", is_child: false, child_type: "", parent_name: null });
  await page.getByRole("tab", { name: "登記參加" }).click();
  await expect(page.locator("#hosting-section")).toBeHidden();
  await expect(page.locator('#hosting-fields input, #hosting-fields select')).toHaveCount(0);
});

test("hosting opened during an edit asks for the answer and keeps the activity edits", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(false) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: null } });
    return route.fulfill(requests.length === 2 ? hostingRequired : { json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const notAttending = page.locator('#edit-form input[name="activity_1"][value="false"]');
  await notAttending.check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("開家接待調查已開放，請回答開家接待後再按「儲存修改」。");
  await expect(notAttending).toBeChecked();
  const hosting = page.locator("#edit-hosting-section");
  await expect(hosting).toBeVisible();
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeDisabled();
  await hosting.getByLabel("家人已登記開家接待").check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[2].choices).toEqual([{ activity_id: 1, attending: false }]);
  expect(requests[2].hosting).toEqual({ status: "family_registered", guest_type: null, guest_count: null });
});

test("hosting closed during an edit that changed only hosting returns to confirmation", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(true) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: brothers } });
    return route.fulfill(hostingClosed);
  });
  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await page.locator("#edit-hosting-section").getByLabel("可以接待幾位？").selectOption("3");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("開家接待調查已關閉，接待內容維持原樣。");
  await expect(page.locator("#page-message")).not.toHaveClass(/error/);
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);
  await expect(page.locator("#edit-hosting-section")).toContainText("開家接待：是，可接待 2 位（弟兄）");
  await expect(page.getByRole("button", { name: "修改登記內容" })).toBeVisible();
  expect(requests).toHaveLength(2);
});

test("a lookup in the other tab updates its hosting hint when the switch is found changed", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(false) });
    const body = route.request().postDataJSON();
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: brothers } });
    return route.fulfill(hostingRequired);
  });
  await page.goto("/");
  await query(page);
  const hosting = page.locator("#edit-hosting-section");
  await expect(hosting).toContainText("開家接待調查已關閉，如需調整請聯絡服事者");
  await page.getByRole("tab", { name: "登記參加" }).click();
  await page.locator('#registration-form input[name="full_name"]').fill("家人登記");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page.locator("#hosting-section")).toBeVisible();
  await page.getByRole("tab", { name: "查詢或修改登記" }).click();
  await expect(hosting).toContainText("開家接待：是，可接待 2 位（弟兄）");
  await expect(hosting).not.toContainText("開家接待調查已關閉");
});

test("hosting closed before a new registration is sent says the answer is dropped", async ({ page }) => {
  const submitted = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(true) });
    submitted.push(route.request().postDataJSON());
    return route.fulfill(submitted.length === 1 ? hostingClosed : { status: 201, json: { success: true } });
  });
  await page.goto("/");
  await page.locator('#registration-form input[name="full_name"]').fill("接待測試");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_1"][value="true"]').check();
  await page.locator("#hosting-section").getByLabel("否", { exact: true }).check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page.locator("#page-message")).toHaveText("開家接待調查已關閉，接待回答不會送出；請再按一次「送出登記」。");
  await expect(page.locator("#hosting-section")).toBeHidden();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(submitted[1].hosting).toBeUndefined();
});

test("hosting closed while answering it for the first time keeps activity edits and leaves nothing required", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: hostingPage(true) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: null } });
    return route.fulfill(requests.length === 2 ? hostingClosed : { json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  await expect(page.locator("#edit-hosting-section")).toContainText("開家接待：未回覆");
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const notAttending = page.locator('#edit-form input[name="activity_1"][value="false"]');
  await notAttending.check();
  await page.locator("#edit-hosting-section").getByLabel("家人已登記開家接待").check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("開家接待調查已關閉，接待內容維持原樣，請再按一次「儲存修改」。");
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
  await expect(page.locator('#edit-form input[name="hosting_status"]')).toHaveCount(0);
  await expect(notAttending).toBeChecked();
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeEnabled();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[2]).toEqual({ action: "update", full_name: "測試登記", district_id: 1, choices: [{ activity_id: 1, attending: false }],
    meal_identity: "general", is_child: false, child_type: "", parent_name: null });
});

test("a description sent while editing shows in the edit view and the registration tab", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: closedWithoutDescription });
    const body = route.request().postDataJSON();
    if (body.action === "query") return route.fulfill({ json: { ...queried(true), hosting: null } });
    return route.fulfill(hostingRequiredWithDescription);
  });
  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const notAttending = page.locator('#edit-form input[name="activity_1"][value="false"]');
  await notAttending.check();
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator('#edit-hosting-section input[name="hosting_status"]')).toHaveCount(3);
  await expect(page.locator("#edit-hosting-section")).toContainText("接待期間 2/19（五）～2/22（一）");
  await expect(notAttending).toBeChecked();
  let asked = false;
  page.once("dialog", (dialog) => { asked = true; return dialog.accept(); });
  await page.getByRole("tab", { name: "登記參加" }).click();
  // The kept activity edit is still unsaved, so leaving asks first.
  expect(asked).toBe(true);
  await expect(page.locator("#hosting-section")).toContainText("接待期間 2/19（五）～2/22（一）");
});

test("hosting options stay readable when there is no description", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { ...openPage(), settings: { ...openPage().settings, is_hosting_open: true, hosting_description: null } } });
    }
    return route.fulfill({ json: { ...queried(true), hosting: brothers } });
  });
  // Each choice sits on one line under the legend, starting at the legend's left edge.
  const readable = async (section) => {
    const labels = section.locator(".hosting-options label");
    const [box, first, longest] = await Promise.all([section.locator("legend").boundingBox(), labels.first().boundingBox(), labels.last().boundingBox()]);
    expect(first.x - box.x).toBeLessThan(8);
    // 家人已登記開家接待 stays on one line instead of wrapping character by character.
    expect(longest.height).toBeLessThan(40);
    expect(longest.width).toBeGreaterThan(120);
  };
  await page.goto("/");
  await readable(page.locator("#hosting-section"));
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await readable(page.locator("#edit-hosting-section"));
});

test("the site note shows under the address as text with only https links clickable", async ({ page }) => {
  // Chinese text written right after the link is not part of it.
  const note = "捷運國父紀念館站 5 號出口\n地圖：https://maps.app.goo.gl/abc123停車請見 B2.<b>不是粗體</b> javascript:alert(1)";
  await page.route("**/functions/v1/registration", (route) => route.fulfill({
    json: { ...openPage(), settings: { ...openPage().settings, address: "台北市信義區", event_note: note } },
  }));
  await page.goto("/");
  const shown = page.locator("#event-note");
  await expect(shown).toHaveText(note);
  await expect(shown.locator("b")).toHaveCount(0);
  const links = shown.locator("a");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute("href", "https://maps.app.goo.gl/abc123");
  await expect(links).toHaveAttribute("target", "_blank");
  // The note follows the venue and address line.
  expect(await page.locator("#event-meta + #event-note").count()).toBe(1);
});

test("the site note turns [label](https://...) into a link that shows the label", async ({ page }) => {
  const note = "大眾運輸：[交通資訊](https://example.org/transport/guide_1/)\n[不安全](javascript:alert(1)) [http 不轉](http://example.org/) 地圖 https://maps.app.goo.gl/abc123";
  await page.route("**/functions/v1/registration", (route) => route.fulfill({
    json: { ...openPage(), settings: { ...openPage().settings, event_note: note } },
  }));
  await page.goto("/");
  const shown = page.locator("#event-note");
  const links = shown.locator("a");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveText("交通資訊");
  await expect(links.nth(0)).toHaveAttribute("href", "https://example.org/transport/guide_1/");
  await expect(links.nth(1)).toHaveAttribute("href", "https://maps.app.goo.gl/abc123");
  // Only https links become links; the other bracket forms stay as written.
  await expect(shown).toContainText("大眾運輸：交通資訊");
  await expect(shown).toContainText("[不安全](javascript:alert(1)) [http 不轉](http://example.org/)");
});

test("an empty site note leaves nothing under the address", async ({ page }) => {
  await page.route("**/functions/v1/registration", (route) => route.fulfill({ json: openPage() }));
  await page.goto("/");
  await expect(page.locator("#activities .activity")).toHaveCount(1);
  await expect(page.locator("#event-note")).toBeHidden();
});

test("changing only pickup on an unanswered registration still asks before discarding", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: {
      ...hostingPage(false), settings: { ...hostingPage(false).settings, is_pickup_open: true },
    } });
    return route.fulfill({ json: { ...queried(true), hosting: null, pickup: null } });
  });
  await page.goto("/");
  await query(page);
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const pickup = page.locator("#edit-pickup");
  await pickup.locator('[name="pickup_status"][value="yes"]').check();
  await pickup.locator('[name="pickup_count"]').selectOption("2");
  let asked = false;
  page.once("dialog", (dialog) => { asked = true; return dialog.dismiss(); });
  await page.getByRole("button", { name: "取消修改" }).click();
  expect(asked).toBe(true);
  await expect(pickup.locator('[name="pickup_count"]')).toHaveValue("2");
});

const mealPage = (activities, settings = {}) => ({ ...openPage(), settings: { ...openPage().settings, ...settings }, activities });
const studentDinner = { id: 2, title: "測試晚餐", category: "meal", fee_amount: 100, student_fee_amount: 60, audience: "all" };
const restrictedLunch = { id: 1, title: "測試午餐", category: "meal", fee_amount: 120, student_fee_amount: 70, audience: "hosting", audience_note: null };

test("pickup audience follows its own answer and leaves an empty note hidden", async ({ page }) => {
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: mealPage([
      { id: 1, title: "接機限定活動", category: "meeting", audience: "pickup", audience_note: null },
    ], { is_pickup_open: true, is_hosting_open: false }) });
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const activity = page.locator('#activities [data-activity="1"]');
  const yes = activity.locator('input[value="true"]');
  await expect(yes).toBeDisabled();
  await expect(activity.locator(".audience-note")).toHaveCount(0);
  await page.locator("#pickup-fields").getByLabel("是", { exact: true }).check();
  await expect(yes).toBeEnabled();
  await yes.check();
  await page.locator("#pickup-fields").getByLabel("否", { exact: true }).check();
  await expect(yes).toBeDisabled();
  await page.locator("#pickup-fields").getByLabel("是", { exact: true }).check();
  await expect(yes).toBeChecked();
});

test("activity audience follows a published prerequisite and restores its answer", async ({ page }) => {
  const prerequisite = { id: 2, title: "第一天", category: "meeting", audience: "all" };
  const dependent = { id: 1, title: "第二天", category: "meeting", audience: "activity:2" };
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: mealPage([dependent, prerequisite]) });
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const secondYes = page.locator('#activities input[name="activity_1"][value="true"]');
  await expect(secondYes).toBeDisabled();
  await page.locator('#activities input[name="activity_2"][value="true"]').check();
  await secondYes.check();
  await page.locator('#activities input[name="activity_2"][value="false"]').check();
  await expect(secondYes).toBeDisabled();
  await page.locator('#activities input[name="activity_2"][value="true"]').check();
  await expect(secondYes).toBeChecked();
});

test("identity is required even without meals and appears once above activities", async ({ page }) => {
  let submitted;
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: openPage() });
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const form = page.locator("#registration-form");
  await form.locator('[name="full_name"]').fill("Student verification");
  await form.locator('[name="district_id"]').selectOption("1");
  await form.locator('[name="activity_1"][value="false"]').check();
  expect(await registrationFormValid(page)).toBe(false);
  await expect(form.locator(".meal-identity")).toHaveCount(0);
  await form.locator('[name="meal_identity"]').selectOption("student");
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(submitted.meal_identity).toBe("student");
  expect(submitted.child_type).toBe("");
});

test("unticking the meal still sends the chosen identity, shown on the success page", async ({ page }) => {
  let submitted;
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: mealPage([studentDinner]) });
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  await page.locator('#registration-form input[name="full_name"]').fill("一般測試");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_2"][value="true"]').check();
  await page.locator('#registration-form input[name="activity_2"][value="false"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(submitted.meal_identity).toBe("general");
  await expect(page.locator("#summary-choices li").last()).toHaveText("身分別：一般");
});

test("a restricted activity opens and closes with the hosting answer on screen", async ({ page }) => {
  let submitted;
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: mealPage([restrictedLunch, studentDinner], { is_hosting_open: true }) });
    }
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const lunch = page.locator('#activities [data-activity="1"]');
  const yes = lunch.locator('input[value="true"]');
  const no = lunch.locator('input[value="false"]');
  const reverted = lunch.locator(".audience-reverted");
  const hosting = page.locator("#hosting-section");
  const note = lunch.locator(".activity-options .audience-note");
  await expect(note).toHaveCount(0);
  // No hosting answer yet: the activity shows, locked to 不參加, with nothing to answer.
  await expect(no).toBeChecked();
  await expect(yes).toBeDisabled();
  await expect(reverted).toBeHidden();
  await hosting.getByLabel("否", { exact: true }).check();
  await expect(yes).toBeDisabled();
  await hosting.getByLabel("家人已登記開家接待").check();
  await expect(yes).toBeEnabled();
  await yes.check();
  await expect(page.locator('#registration-form [name="meal_identity"]')).toBeVisible();

  await hosting.getByLabel("否", { exact: true }).check();
  await expect(no).toBeChecked();
  await expect(yes).toBeDisabled();
  await expect(reverted).toHaveText("不符報名對象，已改為不參加。");
  await expect(page.locator("#activities .meal-identity")).toBeHidden();
  // Becoming eligible again on the same screen brings the 參加 back.
  await hosting.getByLabel("是", { exact: true }).check();
  await expect(yes).toBeChecked();
  await expect(reverted).toBeHidden();

  await hosting.getByLabel("否", { exact: true }).check();
  await page.locator('#registration-form input[name="full_name"]').fill("限定測試");
  await page.locator('#registration-form select[name="meal_identity"]').selectOption("general");
  await page.locator('#registration-form select[name="district_id"]').selectOption("1");
  await page.locator('#registration-form input[name="activity_2"][value="false"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  // The locked choice is still sent, as 不參加.
  expect(submitted.choices).toEqual([{ activity_id: 1, attending: false }, { activity_id: 2, attending: false }]);
});

test("a sign-up from before a restriction is kept until the person saves another change", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: mealPage([{ ...restrictedLunch, audience_note: "限有開家接待的家庭" }, studentDinner]) });
    }
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") {
      return route.fulfill({ json: { ...queried(true), hosting: null, meal_identity: "student", choices: [
        { activity_id: 1, title: "測試午餐", attending: true }, { activity_id: 2, title: "測試晚餐", attending: true },
      ] } });
    }
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  await expect(page.locator('#edit-form [name="meal_identity"]')).toHaveValue("student");
  await expect(page.locator('#edit-form [name="meal_identity"]')).toBeDisabled();
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const lunch = page.locator('#edit-activities [data-activity="1"]');
  await expect(lunch).toContainText("限有開家接待的家庭");
  await expect(lunch.locator('input[value="false"]')).toBeChecked();
  await expect(lunch.locator('input[value="true"]')).toBeDisabled();
  await expect(lunch.locator(".audience-reverted")).toBeVisible();
  await expect(page.locator('#edit-form [name="meal_identity"]')).toHaveValue("student");
  // Opening the form changed nothing the person did, so there is nothing to save or confirm.
  const save = page.getByRole("button", { name: "儲存修改" });
  await expect(save).toBeDisabled();
  let asked = false;
  page.once("dialog", (dialog) => { asked = true; return dialog.dismiss(); });
  await page.getByRole("button", { name: "取消修改" }).click();
  expect(asked).toBe(false);
  await expect(page.locator("#edit-form input[type=radio]")).toHaveCount(0);

  await page.getByRole("button", { name: "修改登記內容" }).click();
  await page.locator('#edit-form select[name="meal_identity"]').selectOption("general");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[1]).toEqual({
    action: "update", full_name: "測試登記", district_id: 1, meal_identity: "general",
    choices: [{ activity_id: 1, attending: false }, { activity_id: 2, attending: true }], is_child: false, child_type: "", parent_name: null,
  });
  await expect(page.locator('#edit-form [name="meal_identity"]')).toHaveValue("general");
});

test("a meal identity remains visible after its student price is removed", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: mealPage([{ ...studentDinner, student_fee_amount: null }]) });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") {
      return route.fulfill({ json: { ...queried(true), meal_identity: "student",
        choices: [{ activity_id: 2, title: "測試晚餐", attending: true }] } });
    }
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  await expect(page.locator('#edit-form [name="meal_identity"]')).toHaveValue("student");
  await page.getByRole("button", { name: "修改登記內容" }).click();
  const save = page.getByRole("button", { name: "儲存修改" });
  await expect(save).toBeDisabled();
  await page.locator('#edit-form input[name="activity_2"][value="false"]').check();
  await save.click();
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  expect(requests[1].meal_identity).toBe("student");
});

// The page may be older than an admin's price or audience change; the server's 400 keeps the edit open.
for (const [refusal, error] of [
  ["meal identity", "請選擇身分別；看不到這一題時請重新整理頁面"],
  ["audience", "有活動限有開家接待的聖徒報名，請確認開家接待的回答；畫面不符時請重新整理頁面"],
]) {
  test(`a refused ${refusal} keeps the edit open with the server message`, async ({ page }) => {
    await page.route("**/functions/v1/registration", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: mealPage([studentDinner]) });
      const body = route.request().postDataJSON();
      if (body.action === "query") {
        return route.fulfill({ json: { ...queried(true), choices: [{ activity_id: 2, title: "測試晚餐", attending: false }] } });
      }
      return route.fulfill({ status: 400, json: { error } });
    });
    await page.goto("/");
    await query(page);
    await page.getByRole("button", { name: "修改登記內容" }).click();
    await page.locator('#edit-form input[name="activity_2"][value="true"]').check();
    await page.locator('#edit-form select[name="meal_identity"]').selectOption("student");
    await page.getByRole("button", { name: "儲存修改" }).click();
    await expect(page.locator("#page-message")).toHaveText(error);
    await expect(page.locator('#edit-form input[name="activity_2"][value="true"]')).toBeChecked();
    await expect(page.getByRole("button", { name: "儲存修改" })).toBeVisible();
  });
}

test("link previews read the page description and never the test-site banner", async ({ page, request }) => {
  for (const path of ["/", "/success.html", "/admin/"]) {
    const response = await request.get(path);
    // A missing page would also lack the banner text, so check that the real page came back.
    expect(response.ok(), path).toBe(true);
    const html = await response.text();
    expect(html, path).toContain('id="test-banner"');
    expect(html, path).not.toContain("測試站");
    if (path !== "/admin/") expect(html, path).toContain('property="og:description" content="38 會所聖徒登記報名：聚會時間、住宿、用餐、接送一次填寫。"');
  }
  // The test site still shows the banner, filled in by the script.
  await page.route("**/functions/v1/registration", (route) => route.fulfill({ json: openPage() }));
  await page.goto("/");
  await expect(page.locator("#test-banner")).toHaveText("測試站｜請勿填寫正式登記資料");
  await expect(page.locator("#test-banner")).toBeVisible();
});

// 兒童 (2026-11-09): both surveys open, so hiding them for a child is visible; activity 2 is for hosting households only.
test("preschool selection shows the age and height rule and keeps the parent field required", async ({ page }) => {
  await page.route("**/functions/v1/registration**", (route) => route.fulfill({ json: childPage() }));
  await page.goto("/");
  const form = page.locator("#registration-form");
  await form.locator('[name="meal_identity"]').selectOption("preschool");
  await expect(form.locator(".preschool-hint")).toHaveText("6 歲（含）以內且身高 115 公分以下，年齡以特會當天為準");
  await expect(form.locator(".preschool-hint")).toBeVisible();
  await expect(form.locator(".parent-name")).toBeVisible();
  await expect(page.locator("#hosting-section")).toBeHidden();
  await form.locator('[name="meal_identity"]').selectOption("child");
  await expect(form.locator(".preschool-hint")).toBeHidden();
  await expect(form.locator(".parent-name")).toBeVisible();
});

const childPage = () => mealPage([
  { id: 1, title: "測試活動", audience: "all" },
  { id: 2, title: "接待家庭聚餐", audience: "hosting", audience_note: null },
], { is_hosting_open: true, is_pickup_open: true });

test("a child skips both surveys, may join a hosting-only activity, and must give a parent's name at the bottom", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: childPage() });
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const form = page.locator("#registration-form");
  const child = form.getByRole("combobox", { name: "身分別", exact: true });
  const parent = form.locator('input[name="parent_name"]');
  // 兒童 sits right of 區 on a wide screen and on its own row on a phone.
  const boxes = () => form.locator(".identity-fields > label").evaluateAll((labels) =>
    labels.map((label) => label.getBoundingClientRect()).map(({ x, bottom }) => ({ x, bottom })));
  await page.setViewportSize({ width: 1280, height: 900 });
  let [, district, check] = await boxes();
  expect(check.x).toBeGreaterThan(district.x);
  expect(Math.abs(check.bottom - district.bottom)).toBeLessThan(2);
  await page.setViewportSize({ width: 390, height: 900 });
  [, district, check] = await boxes();
  expect(check.bottom).toBeGreaterThan(district.bottom + 10);
  await expect(form.locator(".child-hint")).toBeHidden();
  await expect(form.locator(".parent-name")).toBeHidden();
  await expect(form.locator('input[name="activity_2"][value="true"]')).toBeDisabled();

  await child.selectOption("child");
  await expect(form.locator(".child-hint")).toHaveText("兒童報名請在表單最下方填寫家長姓名。");
  await expect(page.locator("#hosting-section")).toBeHidden();
  await expect(form.locator('input[name="activity_2"][value="true"]')).toBeEnabled();
  // The parent's name comes last, right above 送出登記.
  expect(await form.evaluate((element) => [...element.children].filter((item) => item.checkVisibility() && !item.classList.contains("honeypot"))
    .slice(-2).map((item) => item.className || item.tagName))).toEqual(["parent-name", "BUTTON"]);
  await form.locator('input[name="full_name"]').fill("王小明");
  await form.locator('select[name="district_id"]').selectOption("1");
  await form.locator('input[name="activity_1"][value="true"]').check();
  await form.locator('input[name="activity_2"][value="true"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  expect(await registrationFormValid(page)).toBe(false);
  await parent.fill("   ");
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page.locator("#page-message")).toHaveText("請填寫家長姓名");
  expect(requests).toHaveLength(0);
  await expect(parent).toHaveAttribute("maxlength", "20");

  await parent.fill(" 王爸爸 ");
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(requests[0]).toMatchObject({ action: "create", full_name: "王小明", is_child: true, child_type: "elementary", parent_name: "王爸爸",
    choices: [{ activity_id: 1, attending: true }, { activity_id: 2, attending: true }] });
  expect(requests[0]).not.toHaveProperty("hosting");
  expect(requests[0]).not.toHaveProperty("pickup");
  await expect(page.locator("#summary-identity")).toHaveText("王小明｜測試區｜兒童（家長：王爸爸）");
});

test("unticking 兒童 brings the surveys back and sends no parent name", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: childPage() });
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { success: true } });
  });
  await page.goto("/");
  const form = page.locator("#registration-form");
  await form.getByRole("combobox", { name: "身分別", exact: true }).selectOption("child");
  await form.locator('input[name="parent_name"]').fill("王爸爸");
  await form.getByRole("combobox", { name: "身分別", exact: true }).selectOption("general");
  await expect(page.locator("#hosting-section")).toBeVisible();
  await expect(form.locator(".parent-name")).toBeHidden();
  await form.locator('input[name="full_name"]').fill("王大明");
  await form.locator('select[name="district_id"]').selectOption("1");
  await form.locator('input[name="activity_1"][value="true"]').check();
  await form.locator('input[name="activity_2"][value="false"]').check();
  await page.locator('#hosting-fields [name="hosting_status"][value="not_hosting"]').check();
  await page.locator('#pickup-fields [name="pickup_status"][value="no"]').check();
  await page.getByRole("button", { name: "送出登記" }).click();
  await expect(page).toHaveURL(/success\.html$/);
  expect(requests[0]).toMatchObject({ is_child: false, pickup: { status: "no", count: 0 } });
  expect(requests[0]).not.toHaveProperty("parent_name");
  expect(requests[0].hosting.status).toBe("not_hosting");
  await expect(page.locator("#summary-identity")).toHaveText("王大明｜測試區");
});

test("the lookup shows name, 區 and 兒童 in one row, and a child's parent name can be corrected or removed", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: childPage() });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true),
      choices: [{ activity_id: 1, title: "測試活動", attending: true }, { activity_id: 2, title: "接待家庭聚餐", attending: true }],
      hosting: { status: "not_hosting" }, pickup: { status: "no", count: 0 }, is_child: true, child_type: "elementary", parent_name: "王爸爸" } });
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  const edit = page.locator("#edit-form");
  await expect(page.locator("#edit-full-name")).toHaveValue("測試登記");
  await expect(page.locator("#edit-district")).toHaveValue("測試區");
  await expect(edit.getByRole("combobox", { name: "身分別", exact: true })).toHaveValue("child");
  await expect(edit.getByRole("combobox", { name: "身分別", exact: true })).toBeDisabled();
  await expect(edit.locator('input[name="parent_name"]')).toHaveValue("王爸爸");
  await expect(edit.locator('input[name="parent_name"]')).not.toBeEditable();
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
  await expect(edit.locator(".child-hint")).toBeHidden();

  await page.getByRole("button", { name: "修改登記內容" }).click();
  await expect(edit.locator(".child-hint")).toBeVisible();
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
  await edit.locator('input[name="parent_name"]').fill("王媽媽");
  await page.getByRole("button", { name: "儲存修改" }).click();
  expect(requests.at(-1)).toMatchObject({ action: "update", is_child: true, child_type: "elementary", parent_name: "王媽媽" });
  expect(requests.at(-1)).not.toHaveProperty("hosting");
  expect(requests.at(-1)).not.toHaveProperty("pickup");
  await expect(edit.locator('input[name="parent_name"]')).toHaveValue("王媽媽");

  // No longer a child: both surveys come back with 否 chosen, and the restricted activity locks.
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await edit.getByRole("combobox", { name: "身分別", exact: true }).selectOption("general");
  await expect(page.locator("#edit-hosting-section")).toBeVisible();
  await expect(page.locator('#edit-hosting [name="hosting_status"][value="not_hosting"]')).toBeChecked();
  await expect(page.locator('#edit-pickup [name="pickup_status"][value="no"]')).toBeChecked();
  await expect(edit.locator(".parent-name")).toBeHidden();
  await expect(edit.locator('input[name="activity_2"][value="false"]')).toBeChecked();
  await page.getByRole("button", { name: "儲存修改" }).click();
  expect(requests.at(-1)).toMatchObject({ meal_identity: "general", is_child: false, child_type: "", parent_name: null, pickup: { status: "no", count: 0 },
    choices: [{ activity_id: 1, attending: true }, { activity_id: 2, attending: false }] });
  expect(requests.at(-1).hosting.status).toBe("not_hosting");
});

test("an adult becoming a child must give the parent's name before saving", async ({ page }) => {
  const requests = [];
  await page.route("**/functions/v1/registration", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: childPage() });
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.action === "query") return route.fulfill({ json: { ...queried(true),
      choices: [{ activity_id: 1, title: "測試活動", attending: true }, { activity_id: 2, title: "接待家庭聚餐", attending: false }],
      hosting: { status: "hosting", guest_type: "any", guest_count: 2 }, pickup: { status: "yes", count: 3 },
      meal_identity: "general", is_child: false, child_type: "", parent_name: null } });
    return route.fulfill({ json: { success: true } });
  });
  await page.goto("/");
  await query(page);
  const edit = page.locator("#edit-form");
  await expect(edit.getByRole("combobox", { name: "身分別", exact: true })).toHaveValue("general");
  await expect(edit.locator(".parent-name")).toBeHidden();
  await page.getByRole("button", { name: "修改登記內容" }).click();
  await edit.getByRole("combobox", { name: "身分別", exact: true }).selectOption("child");
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
  await expect(edit.locator(".parent-name")).toBeVisible();
  // An empty required name leaves 儲存修改 disabled; spaces alone pass the browser check but not ours.
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeDisabled();
  await edit.locator('input[name="parent_name"]').fill("  ");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.locator("#page-message")).toHaveText("請填寫家長姓名");
  expect(requests.filter((body) => body.action === "update")).toHaveLength(0);
  await edit.locator('input[name="parent_name"]').fill("王爸爸");
  await page.getByRole("button", { name: "儲存修改" }).click();
  expect(requests.at(-1)).toMatchObject({ action: "update", is_child: true, child_type: "elementary", parent_name: "王爸爸" });
  expect(requests.at(-1)).not.toHaveProperty("hosting");
  await expect(page.locator("#page-message")).toHaveText("修改已儲存，以下為目前登記內容。");
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
});
