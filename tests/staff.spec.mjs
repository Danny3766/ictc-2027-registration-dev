import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { statisticsFixture } from "./statistics-fixture.mjs";

// The Edge Function sends the identities and each activity's identity prices; fixtures written
// before them get the defaults (an activity's student price becomes its student identity price).
function migrateReference(data) {
  if (!data.activities) return;
  data.identities ??= [["general", "一般"], ["student", "學生"], ["child", "兒童（國小）"], ["preschool", "兒童（學齡前）"]]
    .map(([code, name]) => ({ code, name, is_active: true, public_selectable: true }));
  for (const identity of data.identities) {
    identity.show_badge ??= ["student", "child", "preschool"].includes(identity.code);
    identity.badge_color ??= ({ student: "#eee5fa", preschool: "#fce4ec" })[identity.code] ?? "#e1effe";
  }
  for (const activity of data.activities) {
    activity.activity_identity_prices ??= activity.student_fee_amount == null ? []
      : [{ identity_code: "student", fee_amount: activity.student_fee_amount }];
  }
}

async function mockStaff(page, role, onRequest = () => {}, registrationName = "測試登記", replies = {}) {
  let lastReference, lastRegistrations;
  await page.route("**/auth/v1/token?grant_type=password", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.email).toBe("tester@accounts.invalid");
    await route.fulfill({ json: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 } });
  });
  await page.route("**/auth/v1/logout?scope=local", (route) => route.fulfill({ status: 204 }));
  await page.route("**/functions/v1/staff", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-access");
    const payload = route.request().postDataJSON();
    const { action } = payload;
    onRequest(payload);
    if (action === "get_registration" && !replies[action]) return route.fulfill({ json: {
      registration: lastRegistrations.find((r) => r.id === payload.registration_id),
    } });
    if (action === "registration_statistics" && !replies[action]) {
      const records = replies.list_registrations?.({ before_serial: Number.MAX_SAFE_INTEGER })?.json?.registrations ?? lastRegistrations;
      return route.fulfill({ json: { statistics: statisticsFixture(records, lastReference.activities, lastReference.settings) } });
    }
    const reply = replies[action]?.(payload);
    if ((action === "list_reference" || action === "me" && reply?.json?.settings) && reply?.json && !reply.json.error) {
      migrateReference(reply.json);
      lastReference = reply.json;
    }
    if (action === "list_registrations" && reply?.json) lastRegistrations = reply.json.registrations;
    if (reply) return route.fulfill(reply);
    const result = {
      me: { profile: { auth_user_id: "123e4567-e89b-42d3-a456-426614174000", display_name: "測試服事者", role, must_change_password: false } },
      list_reference: { settings: { event_name: "測試", is_registration_open: false }, districts: [{ id: 1, name: "林森", sort_order: 1 }], activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }], program: [] },
      list_registrations: { count: 1, registrations: [{ id: "223e4567-e89b-42d3-a456-426614174000", serial_no: 1, full_name: registrationName, district_id: 1, record_status: "active", import_status: "pending", registration_choices: [{ activity_id: 1, attending: false }], updated_at: "2026-11-04T00:00:00Z" }] },
      list_staff: { staff: [] },
      save_registration: { success: true },
      save_reference: { saved: {} },
    }[action];
    if (action === "list_reference" && result) {
      migrateReference(result);
      lastReference = result;
    }
    if (action === "list_registrations" && result) lastRegistrations = result.registrations;
    await route.fulfill({ status: result ? 200 : 400, json: result ?? { error: "INVALID_ACTION" } });
  });
}

// Only one view shows at a time, so a test opens the one it works in from the navigation.
const go = (page, view) => page.locator(".staff-nav").getByRole("link", { name: view, exact: true }).click();

test("staff registration edit sends all published activity choices", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; });
  await page.goto("/admin/");
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await page.getByRole("button", { name: "查看／處理" }).click();
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await page.locator('#edit-registration-form input[name="full_name"]').fill("修改後姓名");
  await page.locator('#edit-registration-form input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  expect(saved.registration_id).toBe("223e4567-e89b-42d3-a456-426614174000");
  expect(saved.choices).toEqual([{ activity_id: 1, attending: true }]);
});

test("registration save acknowledges before refresh and prevents duplicate submissions", async ({ page }) => {
  await mockStaff(page, "staff");
  await page.goto("/admin/");
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await page.getByRole("button", { name: "查看／處理" }).click();
  await page.getByRole("button", { name: "修改登記資料" }).click();
  let saveRoute, refreshRoute;
  let saves = 0;
  await page.route("**/functions/v1/staff", async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === "save_registration") { saves++; saveRoute = route; return; }
    if (action === "list_registrations") { refreshRoute = route; return; }
    await route.fallback();
  });
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect.poll(() => Boolean(saveRoute)).toBe(true);
  await expect(page.getByRole("button", { name: "儲存中…" })).toBeDisabled();
  await page.locator("#edit-registration-form").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await saveRoute.fulfill({ json: { success: true } });
  await expect.poll(() => Boolean(refreshRoute)).toBe(true);
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  expect(saves).toBe(1);
  await refreshRoute.fulfill({ status: 503, json: { error: "測試刷新失敗" } });
  await expect(page.locator("#message")).toHaveText("登記資料已儲存，但畫面未能重新整理：測試刷新失敗");
  await expect(page.getByRole("button", { name: "儲存登記" })).toBeEnabled();
  await expect(page.locator("#edit-registration-form")).not.toHaveAttribute("aria-busy");
});

test("slim list loads detail on demand and save reuses canonical data without recounting", async ({ page }) => {
  const requests = [];
  const person = { id: "223e4567-e89b-42d3-a456-426614174000", serial_no: 1, full_name: "測試登記", district_id: 1,
    record_status: "active", import_status: "pending", meal_identity: "general", registration_choices: [], children: [] };
  const saved = { ...person, meal_identity: "student" };
  await mockStaff(page, "staff", (body) => requests.push(body), "測試登記", {
    me: () => ({ json: { profile: { display_name: "服事者", role: "staff", must_change_password: false },
      settings: { event_name: "測試" }, districts: [{ id: 1, name: "林森" }], activities: [], program: [],
      identities: [{ code: "general", name: "一般", is_active: true }, { code: "student", name: "學生", is_active: true }] } }),
    list_registrations: () => ({ json: { count: 1, registrations: [{ ...person, registration_choices: undefined }] } }),
    get_registration: () => ({ json: { registration: person } }),
    save_registration: () => ({ json: { success: true, registration: saved } }),
  });
  await login(page);
  expect(requests.filter((r) => r.action === "list_reference")).toHaveLength(0);
  expect(requests.filter((r) => r.action === "get_registration")).toHaveLength(0);
  await page.getByRole("button", { name: "查看／處理" }).click();
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await page.locator('#edit-registration-form [name="meal_identity"]').selectOption("student");
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  await expect(page.getByRole("button", { name: "修改登記資料" })).toBeVisible();
  expect(requests.filter((r) => r.action === "get_registration")).toHaveLength(1);
  await expect.poll(() => requests.filter((r) => r.action === "list_registrations").at(-1)?.skip_count).toBe(true);
  await expect(page.locator('#edit-registration-form [name="meal_identity"]')).toHaveValue("student");
});

test("a slower earlier detail load cannot replace or fail the record opened after it", async ({ page }) => {
  const people = ["甲", "乙"].map((full_name, index) => ({ id: `${index + 3}23e4567-e89b-42d3-a456-426614174000`, serial_no: index + 1,
    full_name, district_id: 1, record_status: "active", import_status: "pending", registration_choices: [], updated_at: "2026-11-04T00:00:00Z" }));
  await mockStaff(page, "staff", () => {}, "測試登記", { list_registrations: () => ({ json: { count: 2, registrations: people } }) });
  await login(page);
  let slow;
  await page.route("**/functions/v1/staff", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "get_registration" && body.registration_id === people[0].id) { slow = route; return; }
    await route.fallback();
  });
  const open = page.getByRole("button", { name: "查看／處理" });
  await open.nth(0).click();
  await expect.poll(() => Boolean(slow)).toBe(true);
  await open.nth(1).click();
  await expect(page.locator("#detail-title")).toContainText("乙");
  const stale = page.waitForResponse((response) => response.request().postDataJSON()?.registration_id === people[0].id);
  await slow.fulfill({ status: 404, json: { error: "找不到登記紀錄" } });
  await stale;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#detail-title")).toContainText("乙");
  await expect(page.locator("#message")).not.toHaveText("找不到登記紀錄");
});

test("statistics render a million registrations using aggregates without downloading registrations", async ({ page }) => {
  const requests = [];
  await mockStaff(page, "staff", (body) => requests.push(body), "測試登記", {
    registration_statistics: () => ({ json: { statistics: {
      people: [{ district_id: 1, meal_identity: "general", child_type: null, count: 1_000_000, no_identity: 0 }],
      choices: [{ district_id: 1, meal_identity: "general", child_type: null, activity_id: 1, attending: true, eligible: true, count: 1_000_000 }],
      hosting: [{ status: null, guest_type: null, registrations: 1_000_000, people: 0 }],
      pickup: [{ status: null, registrations: 1_000_000, people: 0 }],
    } } }),
  });
  await login(page, "統計與匯出");
  const listsBefore = requests.filter((r) => r.action === "list_registrations").length;
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#stats-summary")).toContainText("有效登記 1000000 筆；預估費用 NT$0");
  expect(requests.filter((r) => r.action === "list_registrations")).toHaveLength(listsBefore);
  expect(requests.filter((r) => r.action === "registration_statistics")).toHaveLength(1);
});

test("invalid survey history stays out of statistics and CSV capacities", async ({ page }, testInfo) => {
  const records = [
    { id: "223e4567-e89b-42d3-a456-426614174000", serial_no: 1, full_name: "需重答", district_id: 1, meal_identity: "general", record_status: "active", import_status: "pending",
      registration_choices: [{ activity_id: 1, attending: false }], registration_hosting: { status: "hosting", guest_type: "any", guest_count: 5, answer_valid: false }, registration_pickup: { status: "yes", count: 6, answer_valid: false } },
    { id: "323e4567-e89b-42d3-a456-426614174000", serial_no: 2, full_name: "不適用者", district_id: 1, meal_identity: "student", record_status: "active", import_status: "pending",
      registration_choices: [{ activity_id: 1, attending: false }], registration_hosting: null, registration_pickup: null },
  ];
  await mockStaff(page, "staff", () => {}, "需重答", { list_registrations: () => ({ json: { registrations: records, count: 2 } }) });
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#hosting-status-stats-rows").getByRole("row", { name: "未回覆 1", exact: true })).toBeVisible();
  await expect(page.locator("#hosting-status-stats-rows").getByRole("row", { name: "不適用 1", exact: true })).toBeVisible();
  await expect(page.locator("#hosting-pickup-stats-rows").getByRole("row", { name: "是 0 0", exact: true })).toBeVisible();
  if (testInfo.project.name !== "desktop-chromium") return;
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載報名登記 CSV" }).click();
  const csv = await readFile(await (await download).path(), "utf8");
  const stale = csv.split("\r\n").find((line) => line.includes("需重答"));
  expect(stale).toContain('"未回覆"');
  expect(stale).not.toContain('"5"'); expect(stale).not.toContain('"6"');
  expect(csv.split("\r\n").find((line) => line.includes("不適用者"))).toContain('"不適用"');
});

test("CSV neutralizes spreadsheet formulas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await mockStaff(page, "staff", () => {}, "=1+1");
  await page.goto("/admin/");
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await go(page, "統計與匯出");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載報名登記 CSV" }).click();
  const csv = await readFile(await (await download).path(), "utf8");
  expect(csv).toContain("'\u003d1+1");
  expect(csv).toContain('"待匯入"');
});

for (const role of ["staff", "admin"]) {
  test(`${role} login loads only its permitted back-office sections`, async ({ page }) => {
    await mockStaff(page, role);
    await page.goto("/admin/");
    await page.locator("#login-form").getByLabel("帳號", { exact: true }).fill("tester");
    await page.locator("#login-form").getByLabel("密碼", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page.getByText("測試登記")).toBeVisible();
    await expect(page.locator("#login-panel")).toBeHidden();
    if (role === "admin") {
      await go(page, "帳號");
      await expect(page.locator("#admin-accounts")).toBeVisible();
    } else {
      await expect(page.locator('.staff-nav a[href="#admin-accounts"]')).toBeHidden();
      await expect(page.locator("#admin-accounts")).toBeHidden();
    }
    await expect(page.locator('#new-registration-form select[name="district_id"] option')).toHaveCount(2);
    await expect(page.locator('#new-registration-choices input[name="activity_1"]')).toHaveCount(2);
    await page.getByRole("button", { name: "登出" }).click();
    await expect(page.locator("#staff-panel")).toBeHidden();
    await expect(page.locator("#admin-accounts")).toBeHidden();
    await expect(page.locator("#registration-rows tr")).toHaveCount(0);
  });
}

test("the navigation shows one view at a time, kept across a refresh until 登出", async ({ page }) => {
  await mockStaff(page, "admin");
  await login(page);
  const shown = () => page.locator("#staff-panel > section.card").evaluateAll((sections) =>
    sections.filter((section) => section.checkVisibility()).map((section) => section.id));
  const current = page.locator('.staff-nav a[aria-current="page"]');
  await expect(page.getByText("測試登記")).toBeVisible();
  await expect.poll(shown).toEqual(["section-registrations"]);
  await expect(current).toHaveText("登記名單");

  // Switching hides the other views but keeps what was typed in them.
  await go(page, "協助登記");
  await page.locator('#new-registration-form input[name="full_name"]').fill("填到一半");
  await go(page, "網站設定");
  await expect.poll(shown).toEqual(["admin-settings"]);
  await expect(current).toHaveText("網站設定");
  expect(await page.evaluate(() => location.hash)).toBe("");
  await go(page, "協助登記");
  await expect(page.locator('#new-registration-form input[name="full_name"]')).toHaveValue("填到一半");

  await go(page, "網站設定");
  await page.reload();
  await expect.poll(shown).toEqual(["admin-settings"]);
  await expect(current).toHaveText("網站設定");

  // The next person to sign in starts at 登記名單.
  await page.getByRole("button", { name: "登出" }).click();
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect.poll(shown).toEqual(["section-registrations"]);
});

test("staff with an admin view kept from before land on 登記名單", async ({ page }) => {
  await mockStaff(page, "staff");
  await page.addInitScript(() => sessionStorage.setItem("ictc_staff_view", "admin-settings"));
  await login(page);
  await expect(page.getByText("測試登記")).toBeVisible();
  await expect(page.locator("#section-registrations")).toBeVisible();
  await expect(page.locator("#admin-settings")).toBeHidden();
  await expect(page.locator('.staff-nav a[aria-current="page"]')).toHaveText("登記名單");
});

test("an admin view kept across a refresh falls back to 登記名單 when loading fails", async ({ page }) => {
  let outage = false;
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => (outage ? { status: 503, json: { error: "後台資料載入失敗" } } : undefined),
  });
  await login(page, "網站設定");
  await expect(page.locator("#admin-settings")).toBeVisible();
  outage = true;
  await page.reload();
  await expect(page.locator("#message")).toHaveText("後台資料載入失敗");
  await expect(page.locator("#section-registrations")).toBeVisible();
  await expect(page.locator('.staff-nav a[aria-current="page"]')).toHaveText("登記名單");
});

async function login(page, view) {
  await page.goto("/admin/");
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  if (view) await go(page, view);
}

test("activity import setting loads and sends both checked and unchecked values", async ({ page }) => {
  const saved = [];
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved.push(payload.data); }, "測試登記", {
    list_reference: () => {
      const result = threeActivities.list_reference();
      result.json.activities.forEach((activity) => { activity.affects_conference_import = true; });
      return result;
    },
  });
  await login(page, "活動");
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).first().click();
  const setting = page.getByLabel("影響大會匯入狀態", { exact: true });
  await expect(setting).toBeChecked();
  await setting.uncheck();
  await page.locator("#activity-form").getByRole("button", { name: /^儲存活動/ }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].affects_conference_import).toBe(false);
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).first().click();
  await setting.check();
  await page.locator("#activity-form").getByRole("button", { name: /^儲存活動/ }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1].affects_conference_import).toBe(true);
});

test("activity sort is preserved when editing and defaults to the end when creating", async ({ page }) => {
  const saved = [];
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved.push(payload.data); }, "測試登記", threeActivities);
  await login(page, "活動");
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).first().click();
  await page.locator('#activity-form input[name="sort_order"]').fill("");
  await page.locator("#activity-form").getByRole("button", { name: /^儲存活動/ }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  await page.locator('#activity-form input[name="title"]').fill("新活動");
  await page.getByRole("button", { name: "儲存活動" }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[0].id).toBe("1");
  expect(saved[0].sort_order).toBe(1);
  expect(saved[1].id).toBeUndefined();
  expect(saved[1].sort_order).toBe(4);
});

test("activity dates allow an optional Taiwan time", async ({ page }) => {
  let saved;
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved = payload.data; }, "測試登記", {
    list_reference: () => ({ json: {
      settings: { event_name: "測試", is_registration_open: false },
      districts: [{ id: 1, name: "林森", sort_order: 1 }],
      activities: [{
        id: 1, title: "日期活動", category: "meeting", starts_at: "2027-02-20T00:00:00+08:00",
        starts_at_has_time: false, ends_at: null, ends_at_has_time: false, is_published: true, sort_order: 1,
      }],
      program: [],
    } }),
  });
  await login(page, "活動");
  // Only the 開始 column: the row also holds the collapsed details' 時間 line.
  const startCell = page.locator("#activity-rows tr").first().locator("td").nth(2);
  await expect(startCell).toHaveText("2/20");
  await page.locator("#activity-rows").getByText("日期活動").click();
  await expect(page.locator("#activity-rows dl")).toHaveText("時間2/20");
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).click();
  const form = page.locator("#activity-form");
  await expect(form.locator('input[name="starts_on"]')).toHaveValue("2027-02-20");
  await expect(form.locator('input[name="starts_time"]')).toHaveValue("");
  await form.locator('input[name="starts_time"]').fill("12:30");
  await form.getByRole("button", { name: /^儲存活動/ }).click();
  await expect.poll(() => saved).toBeTruthy();
  expect(saved.starts_at).toBe("2027-02-20T12:30:00+08:00");
  expect(saved.starts_at_has_time).toBe(true);
  expect(saved.ends_at).toBeNull();
  expect(saved.ends_at_has_time).toBe(false);
});

test("clicking an activity title shows its content without editing", async ({ page }) => {
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: {
      settings: { event_name: "測試", is_registration_open: false },
      districts: [{ id: 1, name: "林森", sort_order: 1 }],
      activities: [
        { id: 1, title: "週六午餐", category: "meal", starts_at: "2027-02-20T10:30:00+08:00", starts_at_has_time: true,
          ends_at: "2027-02-20T13:00:00+08:00", ends_at_has_time: true, venue: "京星", map_url: "https://maps.example/a",
          fee_amount: 400, student_fee_amount: 200, cost_amount: 450, audience: "hosting",
          description: "第一行\n第二行", is_published: false, sort_order: 1 },
        { id: 2, title: "空白活動", category: "other", audience: "activity:1", is_published: true, sort_order: 2 },
        { id: 3, title: "舊限定活動", category: "other", audience: "activity:99", map_url: "goo.gl/x",
          is_published: true, sort_order: 3 },
      ],
      program: [],
    } }),
  });
  await login(page, "活動");
  const first = page.locator("#activity-rows tr").first();
  await expect(first.locator("dl")).toBeHidden();
  await first.getByText("週六午餐").click();
  const details = first.locator("dl");
  await expect(details).toBeVisible();
  // Same text as the public page's 時間 line: a same-day end shows only its time.
  await expect(details).toContainText("2/20 10:30–13:00");
  await expect(details).toContainText("京星");
  await expect(details.getByRole("link", { name: "https://maps.example/a" })).toHaveAttribute("href", "https://maps.example/a");
  await expect(details).toContainText("一般 NT$400／人，學生 NT$200／人");
  await expect(details).toContainText("NT$450／人");
  await expect(details).toContainText("有開家接待的聖徒");
  expect(await details.locator("dd").last().innerText()).toBe("第一行\n第二行");
  await expect(page.locator("#activity-form input[name=\"title\"]")).toHaveValue("");

  const second = page.locator("#activity-rows tr").nth(1);
  await second.getByText("空白活動").click();
  await expect(second.locator("dl")).toContainText("參加「週六午餐（未公開）」的人");
  const third = page.locator("#activity-rows tr").nth(2);
  await third.getByText("舊限定活動").click();
  await expect(third.locator("dl")).toContainText("參加已刪除活動的人");
  await expect(third.locator("dl")).toContainText("goo.gl/x（格式不正確，公開頁不會顯示）");

  await second.getByText("空白活動").click();
  await expect(second.locator("dl")).toBeHidden();

  // Open details would make the rows tall while dragging, so reordering hides them, and a title
  // click there changes nothing.
  await page.getByRole("button", { name: "調整排序" }).click();
  await expect(details).toBeHidden();
  await expect(second.locator("details")).toHaveJSProperty("inert", true);
  await second.getByText("空白活動").click({ force: true });
  // The redraw after 取消 keeps what was expanded, and only that.
  await page.locator("#cancel-reorder").click();
  await expect(page.locator("#activity-rows tr").first().locator("dl")).toBeVisible();
  await expect(page.locator("#activity-rows tr").nth(1).locator("dl")).toBeHidden();
});

test("an open activity keeps the table width and its buttons on screen", async ({ page }) => {
  const long = "很長的說明文字".repeat(40);
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: {
      settings: { event_name: "測試", is_registration_open: false },
      districts: [{ id: 1, name: "林森", sort_order: 1 }],
      activities: [
        { id: 1, title: "午餐", category: "meal", address: long, description: long, is_published: true, sort_order: 1 },
        { id: 2, title: "華語特會（第二天，含擘餅）", category: "meeting", is_published: true, sort_order: 2 },
      ],
      program: [],
    } }),
  });
  await login(page, "活動");
  const scroll = page.locator("#admin-activities .table-scroll");
  const width = () => scroll.evaluate((element) => element.scrollWidth);
  const title = page.locator("#activity-rows").getByText("午餐", { exact: true });
  await expect(title).toBeVisible();
  const before = await width();
  await title.click();
  await expect(page.locator("#activity-rows dl").first()).toBeVisible();
  // The long text wraps inside the title column instead of widening the table.
  expect(await width()).toBeLessThanOrEqual(before + 1);
  const dl = await page.locator("#activity-rows dl").first().boundingBox();
  expect(dl.width).toBeGreaterThanOrEqual(12 * 16 - 1);
  const reorder = await page.getByRole("button", { name: "調整排序" }).boundingBox();
  expect(reorder.x + reorder.width).toBeLessThanOrEqual(page.viewportSize().width);
});

test("cancelling an edit makes the next save create a new row", async ({ page }) => {
  const saved = [];
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved.push(payload.data); }, "測試登記", threeActivities);
  await login(page, "活動");
  const form = page.locator("#activity-form");
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).first().click();
  await expect(form.locator('button[type="submit"]')).toHaveText("儲存活動（編輯：活動甲）");
  await form.getByRole("button", { name: "取消編輯" }).click();
  await expect(form.locator('button[type="submit"]')).toHaveText("儲存活動");
  await form.locator('input[name="title"]').fill("新活動");
  await form.locator('input[name="sort_order"]').fill("9");
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].id).toBeUndefined();
  expect(saved[0].title).toBe("新活動");
});

test("a temporary back-office outage on reload keeps the login", async ({ page }) => {
  let outage = false;
  await mockStaff(page, "staff", () => {}, "測試登記", {
    list_reference: () => (outage ? { status: 503, json: { error: "後台資料載入失敗" } } : undefined),
  });
  await login(page);
  await expect(page.getByText("測試登記")).toBeVisible();
  outage = true;
  await page.reload();
  await expect(page.locator("#message")).toHaveText("後台資料載入失敗");
  expect(await page.evaluate(() => sessionStorage.getItem("ictc_staff_session"))).not.toBeNull();
});

test("retrying a failed back-office registration reuses its request id", async ({ page }) => {
  const ids = [];
  await mockStaff(page, "staff", () => {}, "測試登記", {
    create_registration: (payload) => {
      ids.push(payload.create_request_id);
      return ids.length === 1 ? { status: 503, json: { error: "協助登記失敗，請稍後再試" } }
        : { status: 201, json: { serial_no: 2 } };
    },
  });
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  await form.locator('input[name="full_name"]').fill("協助測試");
  await form.locator('[name="meal_identity"]').selectOption("general");
  await form.locator('select[name="district_id"]').selectOption("1");
  await form.locator('input[name="activity_1"][value="true"]').check();
  await form.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#message")).toHaveText("協助登記失敗，請稍後再試");
  await form.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#new-registration-code")).toHaveText("已建立流水號 2。本人日後可用相同的姓名與區查詢。");
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

const self = "123e4567-e89b-42d3-a456-426614174000";
const other = "323e4567-e89b-42d3-a456-426614174000";
const twoAccounts = () => ({ json: { staff: [
  { auth_user_id: self, username: "tester", display_name: "測試服事者", role: "admin", is_active: true },
  { auth_user_id: other, username: "other", display_name: "其他", role: "staff", is_active: true },
] } });

test("admins set another account's password, but change their own with the current one", async ({ page }) => {
  const sent = [];
  await mockStaff(page, "admin", (payload) => { if (payload.action === "set_staff_password") sent.push(payload); }, "測試登記", {
    list_staff: twoAccounts,
    set_staff_password: () => ({ json: { success: true } }),
  });
  page.on("dialog", (dialog) => dialog.accept());
  await login(page, "帳號");
  const rows = page.locator("#staff-rows tr");
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "重設密碼" })).toHaveCount(0);

  await rows.nth(0).getByRole("button", { name: "修改" }).click();
  await expect(page.locator("#staff-password-form")).toBeHidden();
  await expect(page.locator("#staff-password-self")).toBeVisible();

  await rows.nth(1).getByRole("button", { name: "修改" }).click();
  const passwordForm = page.locator("#staff-password-form");
  await expect(passwordForm).toBeVisible();
  await passwordForm.locator('input[name="password"]').fill("short");
  await passwordForm.getByRole("button", { name: "設定密碼" }).click();
  expect(sent).toHaveLength(0);
  await passwordForm.locator('input[name="password"]').fill("new-staff-password-1");
  await passwordForm.getByRole("button", { name: "設定密碼" }).click();
  await expect(page.locator("#message")).toHaveText("密碼已設定。請以安全方式私下交付。");
  expect(sent).toEqual([{ action: "set_staff_password", user_id: other, password: "new-staff-password-1" }]);
  await expect(passwordForm.locator('input[name="password"]')).toHaveValue("");
});

test("admins create accounts with a password and no district, and rename them", async ({ page }) => {
  const sent = [];
  await mockStaff(page, "admin", (payload) => { if (["create_staff", "update_staff"].includes(payload.action)) sent.push(payload); }, "測試登記", {
    list_staff: twoAccounts,
    create_staff: () => ({ status: 201, json: { success: true } }),
    update_staff: () => ({ json: { success: true } }),
  });
  await login(page, "帳號");
  const create = page.locator("#create-staff-form");
  await expect(create.locator('select[name="district_id"]')).toHaveCount(0);
  await create.locator('input[name="username"]').fill("newhelper");
  await create.locator('input[name="display_name"]').fill("新服事者");
  await create.locator('input[name="password"]').fill("new-staff-password-1");
  await create.getByRole("button", { name: "建立帳號" }).click();
  await expect(page.locator("#message")).toHaveText("帳號已建立。請以安全方式私下交付密碼。");
  expect(sent[0]).toEqual({ action: "create_staff", username: "newhelper", display_name: "新服事者", role: "staff", password: "new-staff-password-1" });
  await expect(create.locator('input[name="password"]')).toHaveValue("");

  await page.locator("#staff-rows tr").nth(1).getByRole("button", { name: "修改" }).click();
  const edit = page.locator("#edit-staff-form");
  await expect(edit.locator('input[name="username"]')).toHaveValue("other");
  await edit.locator('input[name="username"]').fill("renamed");
  await edit.locator('input[name="display_name"]').fill("改名後");
  await edit.getByRole("button", { name: "儲存帳號" }).click();
  await expect(page.locator("#message")).toHaveText("帳號已更新，之後請用新帳號名稱登入。");
  expect(sent[1]).toEqual({ action: "update_staff", user_id: other, username: "renamed", display_name: "改名後" });
  await page.getByRole("button", { name: "關閉", exact: true }).click();
  await expect(page.locator("#staff-editor")).toBeHidden();
});

test("anyone signed in can change their own password from the navigation", async ({ page }) => {
  let sent;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "change_password") sent = payload; }, "測試登記", {
    change_password: () => ({ json: { success: true } }),
  });
  await login(page);
  await expect(page.locator("#change-password-panel")).toBeHidden();
  await page.locator(".staff-nav").getByRole("button", { name: "更改密碼" }).click();
  const panel = page.locator("#change-password-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("更改密碼");
  await panel.getByRole("button", { name: "取消" }).click();
  await expect(panel).toBeHidden();

  await page.locator(".staff-nav").getByRole("button", { name: "更改密碼" }).click();
  await panel.locator('input[name="current_password"]').fill("old-test-password-1");
  await panel.locator('input[name="password"]').fill("new-test-password-1");
  await panel.locator('button[type="submit"]').click();
  await expect(page.locator("#message")).toHaveText("密碼已更改，請使用新密碼重新登入。");
  expect(sent).toEqual({ action: "change_password", current_password: "old-test-password-1", password: "new-test-password-1" });
  await expect(page.locator("#login-panel")).toBeVisible();
  await expect(page.locator("#staff-panel")).toBeHidden();
});

test("a token refresh keeps the login on an Auth outage and ends it when rejected", async ({ page }) => {
  await mockStaff(page, "staff");
  // Expires within the 60s refresh margin, so the first back-office call refreshes the token.
  await page.route("**/auth/v1/token?grant_type=password", (route) =>
    route.fulfill({ json: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 30 } }));
  let refreshStatus = 503;
  await page.route("**/auth/v1/token?grant_type=refresh_token", (route) => route.fulfill({ status: refreshStatus, json: {} }));
  await login(page);
  await expect(page.locator("#message")).toHaveText("暫時無法連線，請稍後再試");
  expect(await page.evaluate(() => sessionStorage.getItem("ictc_staff_session"))).not.toBeNull();
  refreshStatus = 400;
  await page.reload();
  await expect(page.locator("#message")).toHaveText("登入已過期，請重新登入");
  expect(await page.evaluate(() => sessionStorage.getItem("ictc_staff_session"))).toBeNull();
});

const twoActivities = {
  list_reference: () => ({ json: {
    settings: { event_name: "測試", is_registration_open: false },
    districts: [{ id: 1, name: "林森", sort_order: 1 }],
    activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }, { id: 2, title: "新增活動", is_published: true, fee_amount: 100 }],
    program: [],
  } }),
};

test("editing an old registration leaves a newer activity unanswered", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; }, "測試登記", twoActivities);
  await login(page);
  await page.getByRole("button", { name: "查看／處理" }).click();
  await expect(page.locator("#detail-choices")).toContainText("（未回覆，可留空）");
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await page.locator('#edit-registration-form input[name="full_name"]').fill("修改後姓名");
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  expect(saved.choices).toEqual([{ activity_id: 1, attending: false }]);
});

test("statistics show one card per district, with its activities and a district total", async ({ page }) => {
  const reference = twoActivities.list_reference().json;
  const registration = (id, districtId, choices) => ({ id, serial_no: Number(id.at(-1)), full_name: "測試登記",
    district_id: districtId, record_status: "active", import_status: "pending", registration_choices: choices,
    updated_at: "2026-11-04T00:00:00Z" });
  await mockStaff(page, "staff", () => {}, "測試登記", {
    list_reference: () => ({ json: { ...reference, districts: [...reference.districts,
      { id: 2, name: "測試二區", sort_order: 2 }, { id: 3, name: "測試三區", sort_order: 3 }] } }),
    list_registrations: () => ({ json: { count: 2, registrations: [
      registration("223e4567-e89b-42d3-a456-426614174002", 3,
        [{ activity_id: 1, attending: true }, { activity_id: 2, attending: false }]),
      registration("223e4567-e89b-42d3-a456-426614174001", 1, [{ activity_id: 1, attending: false }]),
    ] } }),
  });
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  const cards = page.locator("#district-activity-cards > .mini-card");
  await expect(cards).toHaveCount(4);
  // 全會所 comes first and adds up every district (林森 and 測試三區 here).
  await expect(cards.nth(0).locator("h3")).toHaveText("全會所 有效登記 2 人");
  await expect(cards.nth(0).locator("tbody tr td")).toHaveText(["測試聚會", "1", "1", "0", "新增活動", "0", "1", "1"]);
  await expect(cards.nth(3).locator("h3")).toHaveText("測試三區 有效登記 1 人");
  await expect(cards.nth(1).locator("h3")).toHaveText("林森 有效登記 1 人");
  await expect(cards.nth(1).locator("thead th")).toHaveText(["活動", "參加", "不參加", "未回覆"]);
  // No 合計 row: one person attends several activities, so a sum would count them twice.
  const rows = cards.nth(1).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td")).toHaveText(["測試聚會", "0", "1", "0"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["新增活動", "0", "0", "1"]);
  // A district nobody has signed up from still shows, with zeros.
  await expect(cards.nth(2).locator("h3")).toHaveText("測試二區 有效登記 0 人");
  await expect(cards.nth(2).locator("tbody tr").nth(0).locator("td")).toHaveText(["測試聚會", "0", "0", "0"]);
  await expect(page.locator("#district-stats-rows tr.total td")).toHaveText(["合計", "2", "—", "0", "—"]);
});

test("voiding a registration requires a reason and sends it", async ({ page }) => {
  let voided;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "void_registration") voided = payload; }, "測試登記", {
    void_registration: () => ({ json: { success: true } }),
  });
  page.on("dialog", (dialog) => dialog.accept());
  await login(page);
  await page.getByRole("button", { name: "查看／處理" }).click();
  const form = page.locator("#void-form");
  await form.getByRole("button", { name: "作廢此登記" }).click();
  expect(voided).toBeUndefined();
  await form.locator('input[name="reason"]').fill("  填錯了  ");
  await form.getByRole("button", { name: "作廢此登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記已作廢。");
  expect(voided).toEqual({ action: "void_registration", registration_id: "223e4567-e89b-42d3-a456-426614174000", reason: "填錯了" });
});

test("a message from before login is cleared once login succeeds", async ({ page }) => {
  await mockStaff(page, "staff");
  await page.goto("/admin/");
  await page.locator('#login-form input[name="username"]').fill("X");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.locator("#message")).toHaveText("請檢查帳號格式");
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.getByText("測試登記")).toBeVisible();
  await expect(page.locator("#message")).toBeHidden();
});

test("admin layout fits phones, tablets and desktops without page-level horizontal scrolling", async ({ page }) => {
  // Every view at every width: 48 view switches.
  test.slow();
  await mockStaff(page, "admin");
  await login(page);
  await expect(page.getByText("測試登記")).toBeVisible();
  for (const width of [360, 390, 768, 1024, 1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["登記名單", "協助登記", "統計與匯出", "帳號", "網站設定", "開家與接機接待", "活動", "時間表"]) {
      await go(page, view);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px ${view} page overflow`).toBeLessThanOrEqual(width);
      // Wide tables scroll inside their own box instead of widening the page.
      for (const box of await page.locator(".table-scroll").all()) {
        if (!await box.isVisible()) continue;
        const { right } = await box.evaluate((element) => element.getBoundingClientRect());
        expect(right, `${width}px ${view} table box inside viewport`).toBeLessThanOrEqual(width);
      }
    }
    await expect(page.locator(".staff-nav")).toBeVisible();
    const logout = await page.getByRole("button", { name: "登出" }).boundingBox();
    expect(logout.x + logout.width, `${width}px logout inside viewport`).toBeLessThanOrEqual(width);
    // Check boxes and row buttons keep their natural size instead of the public form's full width.
    await go(page, "協助登記");
    const radio = await page.locator('#new-registration-choices input[type="radio"]').first().boundingBox();
    expect(radio.width, `${width}px radio size`).toBeLessThan(32);
    await go(page, "登記名單");
    const rowButton = await page.getByRole("button", { name: "查看／處理" }).first().boundingBox();
    expect(rowButton.width, `${width}px row button size`).toBeLessThan(160);
  }
});

const threeActivities = {
  list_reference: () => ({ json: {
    settings: { event_name: "測試", is_registration_open: false },
    districts: [{ id: 1, name: "林森", sort_order: 1 }],
    activities: [
      { id: 1, title: "活動甲", category: "meeting", is_published: true, sort_order: 1 },
      { id: 2, title: "活動乙", category: "meal", is_published: true, sort_order: 2 },
      { id: 3, title: "活動丙", category: "other", is_published: true, sort_order: 3 },
    ],
    program: [],
  } }),
};
const activityTitles = (page) => page.locator("#activity-rows tr td:first-child summary").allTextContents();

test("identity reorder moves reserved and inactive identities, cancels and persists", async ({ page }) => {
  let saved;
  const data = threeActivities.list_reference().json;
  migrateReference(data);
  data.identities.push({ code: "inactive", name: "停用身分", is_active: false, public_selectable: false });
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: data }),
    reorder_identities: (payload) => {
      saved = payload.identity_codes;
      data.identities = saved.map((code) => data.identities.find((item) => item.code === code));
      return { json: { success: true } };
    },
  });
  await login(page, "身分別");
  const handles = page.locator("#identity-rows .drag-handle");
  const titleBox = await page.locator("#admin-identities h2").boundingBox();
  const reorderBox = await page.locator("#reorder-identities").boundingBox();
  const phone = await page.locator("#admin-identities .reorder-buttons").evaluate((element) => getComputedStyle(element).position === "absolute");
  if (phone) expect(Math.abs(titleBox.y - reorderBox.y)).toBeLessThan(35);
  await expect(handles.first()).toBeHidden();
  await page.locator("#reorder-identities").click();
  await expect(page.locator("#identity-form")).toHaveJSProperty("inert", true);
  const box = await handles.first().boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await handles.first().press("ArrowDown");
  await page.locator("#cancel-identity-reorder").click();
  expect(saved).toBeUndefined();
  await expect(page.locator("#identity-rows tr").first()).toHaveAttribute("data-code", "general");
  await page.locator("#reorder-identities").click();
  await handles.last().press("ArrowUp");
  await handles.first().press("ArrowDown");
  await page.locator("#identity-rows").evaluate((element) => element.scrollIntoView({ block: "center" }));
  const from = await handles.nth(2).boundingBox();
  const to = await page.locator("#identity-rows tr").first().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 3, { steps: 8 });
  await page.mouse.up();
  const expected = await page.locator("#identity-rows tr").evaluateAll((rows) => rows.map((row) => row.dataset.code));
  expect(expected).toEqual(["child", "student", "general", "inactive", "preschool"]);
  // An unsaved tick in 接待設定 survives the redraw that brings the new order there.
  await page.locator('#hosting-identities input[value="student"]').evaluate((input) => { input.checked = true; });
  await page.locator("#reorder-identities").click();
  await expect(page.locator("#message")).toHaveText("身分排序已儲存。");
  expect(saved).toEqual(expected);
  expect(await page.locator("#hosting-identities input").evaluateAll((inputs) => inputs.map((input) => [input.value, input.checked])))
    .toEqual([["child", false], ["student", true], ["general", true], ["preschool", false]]);
  expect(await page.locator('#new-registration-form select[name="meal_identity"] option').evaluateAll((options) => options.map((option) => option.value)))
    .toEqual(["", "child", "student", "general", "preschool"]);
  await page.reload();
  await go(page, "身分別");
  await expect(page.locator("#identity-rows tr").first()).toHaveAttribute("data-code", "child");
  await expect(page.locator('#new-registration-form select[name="meal_identity"] option').filter({ hasText: "停用身分" })).toHaveCount(0);
});

test("an activity's 費用 follows the identity order once an activity reorder ends", async ({ page }) => {
  const data = threeActivities.list_reference().json;
  data.activities[1] = { ...data.activities[1], fee_amount: 100, activity_identity_prices: [
    { identity_code: "student", fee_amount: 50 }, { identity_code: "child", fee_amount: 0 },
  ] };
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: data }),
    reorder_identities: () => ({ json: { success: true } }),
  });
  await login(page, "身分別");
  const fee = page.locator('#activity-rows tr[data-id="2"] dl');
  // Moves the first identity down one place and waits for the save and its redraw.
  const moveFirstIdentityDown = async () => {
    await page.locator("#reorder-identities").click();
    await page.locator("#identity-rows .drag-handle").first().press("ArrowDown");
    await page.locator("#reorder-identities").click();
    await expect(page.locator("#reorder-identities")).toHaveText("調整排序");
  };
  await expect(fee).toContainText("一般 NT$100／人，學生 NT$50／人，兒童（國小）免費");
  await moveFirstIdentityDown();
  await expect(fee).toContainText("學生 NT$50／人，一般 NT$100／人，兒童（國小）免費");
  // While the activities are being reordered their rows wait, then redraw on 取消.
  await go(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await go(page, "身分別");
  await moveFirstIdentityDown();
  await expect(fee).toContainText("學生 NT$50／人，一般 NT$100／人");
  await go(page, "活動");
  await page.locator("#cancel-reorder").click();
  await expect(fee).toContainText("一般 NT$100／人，學生 NT$50／人，兒童（國小）免費");
});

for (const status of [503, 409]) {
  test(`identity reorder handles ${status} without losing a retry or stale-list recovery`, async ({ page }) => {
    let attempts = 0;
    await mockStaff(page, "admin", () => {}, "測試登記", {
      reorder_identities: () => ++attempts === 1
        ? { status, json: { error: "排序儲存失敗" } } : { json: { success: true } },
    });
    await login(page, "身分別");
    await page.locator("#reorder-identities").click();
    await page.locator("#identity-rows .drag-handle").first().press("ArrowDown");
    await page.locator("#reorder-identities").click();
    if (status === 503) {
      await expect(page.locator("#message")).toHaveText("排序儲存失敗");
      await expect(page.locator("#reorder-identities")).toHaveText("完成排序");
      await page.locator("#reorder-identities").click();
      await expect(page.locator("#message")).toHaveText("身分排序已儲存。");
    } else {
      await expect(page.locator("#message")).toContainText("已重新載入");
      await expect(page.locator("#reorder-identities")).toHaveText("調整排序");
      await expect(page.locator("#identity-rows tr").first()).toHaveAttribute("data-code", "general");
    }
  });
}

test("identity reorder supports touch pointers and locks rows during save", async ({ page }) => {
  await mockStaff(page, "admin");
  await login(page, "身分別");
  await page.locator("#reorder-identities").click();
  await page.locator("#identity-rows").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.locator("#identity-rows .drag-handle").last().evaluate((handle) => {
    const target = document.querySelector("#identity-rows tr").getBoundingClientRect();
    const x = handle.getBoundingClientRect().x + 10;
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 9, isPrimary: true, button: 0, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerType: "touch", pointerId: 9, buttons: 1, clientX: x, clientY: target.y + 2 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", pointerId: 9 }));
  });
  await expect(page.locator("#identity-rows tr").first()).toHaveAttribute("data-code", "preschool");
  let saveRoute;
  await page.route("**/functions/v1/staff", async (route) => {
    if (route.request().postDataJSON().action === "reorder_identities") saveRoute = route;
    else await route.fallback();
  });
  await page.locator("#reorder-identities").click();
  await expect(page.locator("#identity-rows")).toHaveJSProperty("inert", true);
  await expect(page.locator("#cancel-identity-reorder")).toBeDisabled();
  await expect.poll(() => Boolean(saveRoute)).toBe(true);
  await saveRoute.fulfill({ json: { success: true } });
  await expect(page.locator("#message")).toHaveText("身分排序已儲存。");
});

test("activities can be reordered by dragging or arrow keys and saved together", async ({ page }) => {
  let saved;
  await mockStaff(page, "admin", (payload) => { if (payload.action === "reorder_activities") saved = payload; }, "測試登記", {
    ...threeActivities,
    reorder_activities: () => ({ json: { success: true } }),
  });
  await login(page, "活動");
  const handles = page.locator("#activity-rows .drag-handle");
  const numbers = page.locator("#activity-rows .sort-number");
  await expect(handles.first()).toBeHidden();
  await expect(numbers).toHaveText(["1", "2", "3"]);
  await page.getByRole("button", { name: "調整排序" }).click();
  await expect(handles.first()).toBeVisible();
  await expect(numbers.first()).toBeHidden();
  // 完成排序 and 取消 sit side by side.
  const done = await page.getByRole("button", { name: "完成排序" }).boundingBox();
  const cancel = await page.getByRole("button", { name: "取消", exact: true }).boundingBox();
  expect(Math.abs(done.y - cancel.y)).toBeLessThan(4);
  // The handle must be on screen without scrolling the table sideways, including on phones.
  const handleBox = await handles.first().boundingBox();
  expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(page.viewportSize().width);
  // On phones the edit column is hidden while reordering, so check the button itself, not by role.
  await expect(page.locator("#activity-rows button:not(.drag-handle)").first()).toBeDisabled();

  await handles.nth(0).focus();
  await page.keyboard.press("ArrowDown");
  expect(await activityTitles(page)).toEqual(["活動乙", "活動甲", "活動丙"]);

  // Drag 活動丙 above the first row with pointer moves. Center the table first so the sticky
  // navigation bar does not cover the rows.
  await page.locator("#activity-rows").evaluate((element) => element.scrollIntoView({ block: "center" }));
  const from = await handles.nth(2).boundingBox();
  const to = await page.locator("#activity-rows tr").first().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 8 });
  await page.mouse.up();
  expect(await activityTitles(page)).toEqual(["活動丙", "活動乙", "活動甲"]);

  await page.getByRole("button", { name: "完成排序" }).click();
  await expect(page.locator("#message")).toHaveText("活動排序已儲存。");
  expect(saved.activity_ids).toEqual([3, 2, 1]);
  await expect(page.getByRole("button", { name: "調整排序" })).toBeVisible();
  await expect(numbers).toHaveText(["1", "2", "3"]);
});

test("cancelling a reorder restores the order without saving", async ({ page }) => {
  let saved = false;
  await mockStaff(page, "admin", (payload) => { if (payload.action === "reorder_activities") saved = true; }, "測試登記", threeActivities);
  await login(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator("#activity-rows .drag-handle").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(await activityTitles(page)).toEqual(["活動甲", "活動乙", "活動丙"]);
  await expect(page.locator("#activity-rows .drag-handle").first()).toBeHidden();
  expect(saved).toBe(false);
});

test("saving a reorder updates the sort order of an activity edit that is already open", async ({ page }) => {
  await mockStaff(page, "admin", () => {}, "測試登記", { ...threeActivities, reorder_activities: () => ({ json: { success: true } }) });
  await login(page, "活動");
  await page.locator("#activity-rows tr").first().getByRole("button", { name: "編輯" }).click();
  await expect(page.locator('#activity-form input[name="sort_order"]')).toHaveValue("1");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator("#activity-rows .drag-handle").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "完成排序" }).click();
  await expect(page.locator("#message")).toHaveText("活動排序已儲存。");
  await expect(page.locator('#activity-form input[name="sort_order"]')).toHaveValue("2");
});


test("while reordering, settings still save and keep the drag order, activities wait, and cancelling keeps 協助登記 input", async ({ page }) => {
  const saves = [];
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saves.push(payload.kind); }, "測試登記", threeActivities);
  await login(page, "協助登記");
  const newForm = page.locator("#new-registration-form");
  await newForm.locator('input[name="full_name"]').fill("協助測試");
  await newForm.locator('[name="meal_identity"]').selectOption("general");
  await newForm.locator('select[name="district_id"]').selectOption("1");
  await newForm.locator('input[name="activity_2"][value="true"]').check();

  await go(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator("#activity-rows .drag-handle").first().focus();
  await page.keyboard.press("ArrowDown");
  await go(page, "網站設定");
  await page.getByRole("button", { name: "儲存網站設定" }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  await go(page, "活動");
  expect(await activityTitles(page)).toEqual(["活動乙", "活動甲", "活動丙"]);
  await expect(page.getByRole("button", { name: "完成排序" })).toBeVisible();

  await page.locator('#activity-form input[name="title"]').fill("新活動");
  await page.locator('#activity-form input[name="sort_order"]').fill("9");
  await page.locator("#activity-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#message")).toHaveText("請先完成或取消活動排序，再儲存活動。");
  expect(saves).toEqual(["settings"]);

  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(await activityTitles(page)).toEqual(["活動甲", "活動乙", "活動丙"]);
  await expect(newForm.locator('input[name="full_name"]')).toHaveValue("協助測試");
  await expect(newForm.locator('select[name="district_id"]')).toHaveValue("1");
  await expect(newForm.locator('input[name="activity_2"][value="true"]')).toBeChecked();
});

test("a saved reorder updates the page without reloading the reference data", async ({ page }) => {
  let referenceLoads = 0;
  await mockStaff(page, "admin", (payload) => { if (payload.action === "list_reference") referenceLoads += 1; }, "測試登記", {
    ...threeActivities,
    reorder_activities: () => ({ json: { success: true } }),
  });
  await login(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator("#activity-rows .drag-handle").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "完成排序" }).click();
  await expect(page.locator("#message")).toHaveText("活動排序已儲存。");
  expect(await activityTitles(page)).toEqual(["活動乙", "活動甲", "活動丙"]);
  await expect(page.locator("#new-registration-choices [data-activity] strong")).toHaveText(["活動乙", "活動甲", "活動丙"]);
  expect(referenceLoads).toBe(1);
});

test("a reorder rejected because the list changed reloads the activities and leaves reorder mode", async ({ page }) => {
  let rejected = false;
  const changed = structuredClone(threeActivities.list_reference().json);
  changed.activities.push({ id: 4, title: "活動丁", category: "other", is_published: true, sort_order: 4 });
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: rejected ? changed : threeActivities.list_reference().json }),
    reorder_activities: () => { rejected = true; return { status: 409, json: { error: "活動清單已有變動，請重新整理後再排序" } }; },
  });
  await login(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator("#activity-rows .drag-handle").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "完成排序" }).click();
  await expect(page.locator("#message")).toHaveText("活動清單已有變動，已重新載入，請再調整一次排序。");
  expect(await activityTitles(page)).toEqual(["活動甲", "活動乙", "活動丙", "活動丁"]);
  await expect(page.getByRole("button", { name: "調整排序" })).toBeVisible();
});

test("leaving reorder mode in the middle of a drag ends the drag", async ({ page }) => {
  await mockStaff(page, "admin", () => {}, "測試登記", threeActivities);
  await login(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator("#activity-rows").evaluate((element) => element.scrollIntoView({ block: "center" }));
  const from = await page.locator("#activity-rows .drag-handle").first().boundingBox();
  const last = await page.locator("#activity-rows tr").last().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Another finger taps 取消 while the first one is still dragging.
  await page.locator("#cancel-reorder").dispatchEvent("click");
  await page.mouse.move(from.x + from.width / 2, last.y + last.height - 2, { steps: 8 });
  await page.mouse.up();
  expect(await activityTitles(page)).toEqual(["活動甲", "活動乙", "活動丙"]);
  await expect(page.locator("#activity-rows tr.dragging")).toHaveCount(0);
});

test("the reorder buttons are fully on screen: in the table header on wide screens, beside the title on phones", async ({ page }) => {
  await mockStaff(page, "admin", () => {}, "測試登記", threeActivities);
  await login(page, "活動");
  const { width } = page.viewportSize();
  // toBeVisible ignores clipping by the table's scroll box, so check the button's box against the screen.
  const onScreen = async (name) => {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(width);
    return box;
  };
  await page.locator("#admin-activities").scrollIntoViewIfNeeded();
  const button = await onScreen("調整排序");
  const phoneLayout = await page.locator("#admin-activities .reorder-buttons").evaluate((element) => getComputedStyle(element).position === "absolute");
  if (!phoneLayout) {
    const row = await page.locator("#admin-activities thead tr").boundingBox();
    expect(row.x + row.width - (button.x + button.width)).toBeLessThan(24);
  }
  await page.getByRole("button", { name: "調整排序" }).click();
  await onScreen("完成排序");
  await onScreen("取消");
});

test("success messages float at the bottom and leave after 5 seconds; errors stay until closed", async ({ page }) => {
  await page.clock.install();
  await mockStaff(page, "admin", () => {}, "測試登記", threeActivities);
  await login(page, "網站設定");
  await page.getByRole("button", { name: "儲存網站設定" }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  await expect(page.getByRole("status")).toHaveText("設定已儲存。");
  const box = await page.locator("#toast").boundingBox();
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize().height - 40);
  await page.clock.fastForward(6000);
  await expect(page.locator("#message")).toBeHidden();

  await go(page, "活動");
  await page.getByRole("button", { name: "調整排序" }).click();
  await page.locator('#activity-form input[name="title"]').fill("新活動");
  await page.locator('#activity-form input[name="sort_order"]').fill("9");
  await page.locator("#activity-form").evaluate((form) => form.requestSubmit());
  await page.clock.fastForward(6000);
  await expect(page.locator("#message")).toHaveText("請先完成或取消活動排序，再儲存活動。");
  await page.getByRole("button", { name: "關閉訊息" }).click();
  await expect(page.locator("#message")).toBeHidden();
});

test("the note after a password change stays until the user acts on it", async ({ page }) => {
  await page.clock.install();
  await mockStaff(page, "staff", () => {}, "測試登記", {
    me: () => ({ json: { profile: { auth_user_id: "123e4567-e89b-42d3-a456-426614174000", display_name: "測試服事者", role: "staff", must_change_password: true } } }),
    change_password: () => ({ json: { success: true } }),
  });
  await login(page);
  const form = page.locator("#change-password-form");
  for (const input of await form.locator('input[type="password"]').all()) await input.fill("new-test-password-123");
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#message")).toHaveText("密碼已更改，請使用新密碼重新登入。");
  await page.clock.fastForward(10000);
  await expect(page.locator("#message")).toBeVisible();
});

const hostedRegistrations = {
  list_reference: () => ({ json: { settings: { event_name: "測試", is_registration_open: false, is_hosting_open: true, is_pickup_open: true },
    districts: [{ id: 1, name: "林森", sort_order: 1 }], activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }], program: [] } }),
  list_registrations: () => ({ json: { count: 4, registrations: [
    { id: "223e4567-e89b-42d3-a456-426614174001", serial_no: 4, full_name: "接待弟兄", district_id: 1, record_status: "active", import_status: "imported",
      registration_choices: [{ activity_id: 1, attending: true }], updated_at: "2026-11-05T00:00:00Z",
      registration_hosting: { status: "hosting", guest_type: "brother", guest_count: 2 }, registration_pickup: { status: "yes", count: 1 } },
    { id: "223e4567-e89b-42d3-a456-426614174002", serial_no: 3, full_name: "接待夫婦", district_id: 1, record_status: "active", import_status: "pending",
      registration_choices: [{ activity_id: 1, attending: true }], updated_at: "2026-11-05T00:00:00Z",
      registration_hosting: { status: "hosting", guest_type: "couple", guest_count: 4 }, registration_pickup: null },
    { id: "223e4567-e89b-42d3-a456-426614174003", serial_no: 2, full_name: "家人已登記", district_id: 1, record_status: "active", import_status: "pending",
      registration_choices: [{ activity_id: 1, attending: false }], updated_at: "2026-11-05T00:00:00Z",
      registration_hosting: { status: "family_registered", guest_type: null, guest_count: null }, registration_pickup: { status: "yes", count: 2 } },
    { id: "223e4567-e89b-42d3-a456-426614174004", serial_no: 1, full_name: "未回覆接待", district_id: 1, record_status: "active", import_status: "pending",
      registration_choices: [{ activity_id: 1, attending: false }], updated_at: "2026-11-05T00:00:00Z", registration_hosting: null, registration_pickup: { status: "no", count: 0 } },
  ] } }),
};

test("staff edit a hosting answer, and an existing answer cannot be cleared", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; }, "測試登記", hostedRegistrations);
  await login(page);
  await page.getByRole("row", { name: /接待弟兄/ }).getByRole("button", { name: "查看／處理" }).click();
  const hosting = page.locator("#detail-hosting");
  await expect(hosting.getByLabel("是", { exact: true })).toBeChecked();
  await expect(hosting.getByLabel("可以接待幾位？")).toHaveValue("2");
  await expect(hosting.getByLabel("接待對象")).toHaveValue("brother");
  const pickup = page.locator("#detail-pickup");
  await expect(pickup.locator('[name="pickup_count"]')).toHaveValue("1");
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await hosting.getByLabel("可以接待幾位？").selectOption("4");
  await hosting.getByLabel("接待對象").selectOption({ label: "夫婦" });
  await pickup.locator('[name="pickup_count"]').selectOption("5");
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  expect(saved.hosting).toEqual({ status: "hosting", guest_type: "couple", guest_count: 4 });
  expect(saved.pickup).toEqual({ status: "yes", count: 5 });
  await expect(hosting.locator('input[name="hosting_status"]').first()).toHaveAttribute("required", "");

  // An unanswered hosting registration may stay unanswered, independently of pickup.
  await page.getByRole("row", { name: /未回覆接待/ }).getByRole("button", { name: "查看／處理" }).click();
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await expect(hosting.locator('input[name="hosting_status"]').first()).not.toHaveAttribute("required", "");
  await expect(pickup.locator('[name="pickup_status"][value="no"]')).toBeChecked();
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect.poll(() => saved.registration_id).toBe("223e4567-e89b-42d3-a456-426614174004");
  expect(saved.hosting).toBeNull();
  expect(saved.pickup).toEqual({ status: "no", count: 0 });
});

test("a void registration shows its hosting answer with every control disabled", async ({ page }) => {
  const voided = { list_reference: hostedRegistrations.list_reference, list_registrations: () => {
    const result = hostedRegistrations.list_registrations();
    result.json.registrations[0] = { ...result.json.registrations[0], record_status: "void" };
    return result;
  } };
  await mockStaff(page, "staff", () => {}, "測試登記", voided);
  await login(page);
  await page.getByRole("row", { name: /接待弟兄/ }).getByRole("button", { name: "查看／處理" }).click();
  const hosting = page.locator("#detail-hosting");
  await expect(hosting.getByLabel("可以接待幾位？")).toHaveValue("2");
  await expect(hosting.getByLabel("可以接待幾位？")).toBeDisabled();
  await expect(hosting.getByLabel("接待對象")).toBeDisabled();
  // A void registration can only be viewed.
  await expect(page.getByRole("button", { name: "修改登記資料" })).toBeHidden();
  // An active registration opened next can be edited again.
  await page.getByRole("row", { name: /接待夫婦/ }).getByRole("button", { name: "查看／處理" }).click();
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await expect(hosting.getByLabel("接待對象")).toBeEnabled();
});

test("a record opens locked for viewing; 修改登記資料 unlocks it and 取消修改 restores it", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; }, "測試登記", hostedRegistrations);
  await login(page);
  await page.getByRole("row", { name: /接待弟兄/ }).getByRole("button", { name: "查看／處理" }).click();
  const form = page.locator("#edit-registration-form");
  const name = form.locator('input[name="full_name"]');
  const attend = form.locator('input[name="activity_1"][value="true"]');
  const guests = page.locator("#detail-hosting").getByLabel("可以接待幾位？");
  for (const control of [name, form.locator('select[name="district_id"]'), attend, guests]) await expect(control).toBeDisabled();
  await expect(page.getByRole("button", { name: "儲存登記" })).toBeHidden();
  // 大會匯入狀態 and 作廢 stay usable while viewing.
  await expect(page.locator('#import-form select[name="status"]')).toBeEnabled();
  await expect(page.locator('#void-form input[name="reason"]')).toBeEnabled();

  const startEdit = page.getByRole("button", { name: "修改登記資料" });
  await startEdit.click();
  await expect(startEdit).toBeHidden();
  // The pressed button hides, so focus moves to the first field rather than the top of the page.
  await expect(name).toBeFocused();
  await name.fill("改到一半");
  await guests.selectOption("5");
  await page.getByRole("button", { name: "取消修改" }).click();
  await expect(startEdit).toBeFocused();
  await expect(name).toHaveValue("接待弟兄");
  await expect(name).toBeDisabled();
  await expect(guests).toHaveValue("2");
  await expect(page.getByRole("button", { name: "儲存登記" })).toBeHidden();
  expect(saved).toBeUndefined();

  // Saving goes back to viewing.
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  await expect(name).toBeDisabled();
  await expect(startEdit).toBeVisible();
  await expect(startEdit).toBeFocused();
});

test("the registration list shows 10 rows a page and names the import column 匯入大會", async ({ page }) => {
  const pages = [];
  await mockStaff(page, "staff", (payload) => {
    // before_serial requests are the full export for statistics, not the paged list.
    if (payload.action === "list_registrations" && payload.before_serial === undefined) pages.push(payload.page);
  }, "測試登記", {
    list_registrations: () => ({ json: { count: 11, registrations: [] } }),
  });
  await login(page);
  await expect(page.locator("#registration-table th").nth(4)).toHaveText("匯入大會");
  await expect(page.locator("#next-page")).toBeEnabled();
  await page.locator("#next-page").click();
  await expect(page.locator("#page-number")).toHaveText("第 2 頁");
  await expect(page.locator("#next-page")).toBeDisabled();
  expect(pages).toEqual([0, 1]);
});

test("the registration list filters by 區 together with the name, keeps both while paging, and 清除條件 clears them", async ({ page }) => {
  const lists = [];
  let failNext = false;
  await mockStaff(page, "staff", () => {}, "測試登記", {
    list_reference: () => ({ json: {
      settings: { event_name: "測試", is_registration_open: false },
      districts: [{ id: 1, name: "林森", sort_order: 1 }, { id: 2, name: "第二區", sort_order: 2 }],
      activities: [], program: [],
    } }),
    list_registrations: (payload) => {
      // before_serial requests are the full export for statistics, not the paged list.
      if (payload.before_serial !== undefined) return { json: { registrations: [] } };
      lists.push(payload);
      if (failNext) {
        failNext = false;
        return { status: 503, json: { error: "名單載入失敗" } };
      }
      return { json: { count: 11, registrations: [] } };
    },
  });
  await login(page);
  const form = page.locator("#search-form");
  const name = form.locator('input[name="search"]');
  const district = form.locator('select[name="district_id"]');
  const clear = page.getByRole("button", { name: "清除條件" });
  await expect(district.locator("option")).toHaveText(["全部區", "林森", "第二區"]);
  await expect(clear).toBeDisabled();
  // A typed name is enough to clear, before 搜尋.
  await name.fill("王");
  await expect(clear).toBeEnabled();
  await district.selectOption({ label: "第二區" });
  await page.getByRole("button", { name: "搜尋" }).click();
  await expect.poll(() => lists.length).toBe(2);
  await page.locator("#next-page").click();
  await expect(page.locator("#page-number")).toHaveText("第 2 頁");
  expect(lists).toEqual([
    { action: "list_registrations", summary: true, page: 0, search: "" },
    { action: "list_registrations", summary: true, page: 0, search: "王", district_id: 2 },
    { action: "list_registrations", summary: true, page: 1, search: "王", district_id: 2 },
  ]);

  // A failed load keeps the conditions from before 清除條件, in the fields and on the list.
  failNext = true;
  await clear.click();
  await expect(page.locator("#message")).toHaveText("名單載入失敗");
  await page.locator("#message-close").click();
  await expect(name).toHaveValue("王");
  await expect(district).toHaveValue("2");
  await expect(page.locator("#page-number")).toHaveText("第 2 頁");

  // Emptied fields leave the applied filter on the list, so 清除條件 stays usable.
  await name.fill("");
  await district.selectOption({ label: "全部區" });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(page.locator("#page-number")).toHaveText("第 1 頁");
  expect(lists.at(-1)).toEqual({ action: "list_registrations", summary: true, page: 0, search: "" });
  await expect(clear).toBeDisabled();

  // 登出 clears the conditions for the next login on the same page.
  await name.fill("王");
  await district.selectOption({ label: "第二區" });
  await page.getByRole("button", { name: "搜尋" }).click();
  await expect.poll(() => lists.at(-1).district_id).toBe(2);
  await page.getByRole("button", { name: "登出" }).click();
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect.poll(() => lists.at(-1)).toEqual({ action: "list_registrations", summary: true, page: 0, search: "" });
  await expect(name).toHaveValue("");
  await expect(district).toHaveValue("");
  await expect(clear).toBeDisabled();
  // A chosen 區 alone is also enough to clear, before 搜尋.
  await district.selectOption({ label: "林森" });
  await expect(clear).toBeEnabled();
});

test("an expired login while paging a 區 search does not hand the conditions to the next login", async ({ page }) => {
  const lists = [];
  await mockStaff(page, "staff", () => {}, "測試登記", {
    list_registrations: (payload) => {
      if (payload.before_serial !== undefined) return { json: { registrations: [] } };
      lists.push(payload);
      // The search works; the next page meets an expired login, while the search is the applied condition.
      if (payload.page === 1) return { status: 401, json: { error: "登入已過期，請重新登入" } };
      return { json: { count: 11, registrations: [] } };
    },
  });
  await login(page);
  const form = page.locator("#search-form");
  await form.locator('input[name="search"]').fill("王");
  await form.locator('select[name="district_id"]').selectOption({ label: "林森" });
  await page.getByRole("button", { name: "搜尋" }).click();
  await expect.poll(() => lists.length).toBe(2);
  await page.locator("#next-page").click();
  await expect(page.locator("#login-panel")).toBeVisible();
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect.poll(() => lists.length).toBe(4);
  expect(lists.at(-1)).toEqual({ action: "list_registrations", summary: true, page: 0, search: "" });
  await expect(form.locator('input[name="search"]')).toHaveValue("");
  await expect(form.locator('select[name="district_id"]')).toHaveValue("");
  await expect(page.getByRole("button", { name: "清除條件" })).toBeDisabled();
});

test("協助登記 must answer hosting while the public survey is open", async ({ page }) => {
  let created;
  await mockStaff(page, "staff", () => {}, "測試登記", {
    list_reference: () => ({ json: {
      settings: { event_name: "測試", is_registration_open: true, is_hosting_open: true },
      districts: [{ id: 1, name: "林森", sort_order: 1 }],
      activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }], program: [],
    } }),
    create_registration: (payload) => { created = payload; return { status: 201, json: { serial_no: 2 } }; },
  });
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  await form.locator('input[name="full_name"]').fill("協助接待");
  await form.locator('[name="meal_identity"]').selectOption("general");
  await form.locator('select[name="district_id"]').selectOption("1");
  await form.locator('input[name="activity_1"][value="false"]').check();
  await form.getByRole("button", { name: "建立協助登記" }).click();
  expect(created).toBeUndefined();
  const hosting = page.locator("#new-registration-hosting");
  await hosting.getByLabel("是", { exact: true }).check();
  await hosting.getByLabel("接待對象").selectOption({ label: "姊妹" });
  await hosting.getByLabel("可以接待幾位？").selectOption("2");
  await form.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#new-registration-code")).toHaveText("已建立流水號 2。本人日後可用相同的姓名與區查詢。");
  expect(created.hosting).toEqual({ status: "hosting", guest_type: "sister", guest_count: 2 });
  await expect(hosting.locator('input[name="hosting_status"]:checked')).toHaveCount(0);
});

test("statistics count hosting answers and capacity", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", hostedRegistrations);
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  const answers = page.locator("#hosting-status-stats-rows tr");
  await expect(answers).toHaveCount(4);
  await expect(answers.nth(0).locator("td")).toHaveText(["是", "2"]);
  await expect(answers.nth(1).locator("td")).toHaveText(["否", "0"]);
  await expect(answers.nth(2).locator("td")).toHaveText(["未回覆", "1"]);
  await expect(answers.nth(3)).toHaveClass("total");
  await expect(answers.nth(3).locator("td")).toHaveText(["合計", "4"]);
  await expect(page.locator("#hosting-status-note")).toHaveText("合計含未列出的接待回答。");
  const capacity = page.locator("#hosting-capacity-stats-rows tr");
  await expect(capacity).toHaveCount(5);
  await expect(capacity.nth(0).locator("td")).toHaveText(["夫婦", "1", "4"]);
  await expect(capacity.nth(1).locator("td")).toHaveText(["弟兄", "1", "2"]);
  await expect(capacity.nth(2).locator("td")).toHaveText(["姊妹", "0", "0"]);
  await expect(capacity.nth(3).locator("td")).toHaveText(["不拘", "0", "0"]);
  await expect(capacity.nth(4)).toHaveClass("total");
  await expect(capacity.nth(4).locator("td")).toHaveText(["合計", "2", "6"]);
  await expect(page.locator("#hosting-pickup-stats-rows tr td")).toHaveText([
    "是", "2", "3", "否", "1", "0", "未回覆", "1", "0", "合計", "4", "3",
  ]);
});

test("statistics CSV includes the visible sections and omits the family hosting count", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await mockStaff(page, "staff", () => {}, "測試登記", hostedRegistrations);
  await login(page, "統計與匯出");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載統計 CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("registration-statistics.csv");
  const csv = await readFile(await file.path(), "utf8");
  expect(csv).toContain('"統計摘要"\r\n"有效登記 4 筆');
  // No student identity is chosen yet, so the CSV carries the same reminder as the page.
  expect(csv).toContain('\r\n"請先到身分別設定選擇學生統計身分"\r\n');
  expect(csv).toContain('"各活動"\r\n"活動","參加","其中學生","其中兒童","不參加","未回覆"');
  expect(csv).toContain('"測試聚會","2","—","0","2","0","—","—","—"');
  expect(csv).toContain('"各區"\r\n"區","有效登記","其中學生","其中兒童","預估費用"\r\n"林森","4","—","0","—"\r\n"合計","4","—","0","—"');
  expect(csv).toContain('"開家接待回覆"\r\n"回覆","登記數"\r\n"是","2"\r\n"否","0"\r\n"未回覆","1"\r\n"合計","4"\r\n"合計含未列出的接待回答。"');
  expect(csv).not.toContain("家人已登記開家接待");
  expect(csv).toContain('"接待對象"\r\n"接待對象","登記數","人數"');
  expect(csv).toContain('"接機"\r\n"接機","登記數","可載人數"');
  expect(csv).toContain('"各區各活動"\r\n\r\n"全會所 有效登記 4 人"\r\n"活動","參加","不參加","未回覆"\r\n"測試聚會","2","2","0"\r\n\r\n"林森 有效登記 4 人"');
  await expect(page.locator("#stats-rows tr")).toHaveCount(1);
});

test("CSV adds the hosting and meal columns", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await mockStaff(page, "staff", () => {}, "測試登記", hostedRegistrations);
  await login(page, "統計與匯出");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載報名登記 CSV" }).click();
  const lines = (await readFile(await (await download).path(), "utf8")).split("\r\n");
  expect(lines[0]).toMatch(/"開家接待","接待對象","可接待人數","是否可以接機","可接機人數","用餐身分","預估應付餐費","餐費未計入的活動"$/);
  expect(lines[1]).toMatch(/"是","弟兄","2","是","1","","未設定","測試聚會"$/);
  expect(lines[2]).toMatch(/"是","夫婦","4","","","","未設定","測試聚會"$/);
  expect(lines[3]).toMatch(/"家人已登記開家接待","","","是","2","","0",""$/);
  expect(lines[4]).toMatch(/"未回覆","","","否","0","","0",""$/);
});

test("admins save the hosting switch and description from their own card", async ({ page }) => {
  let saved;
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved = payload; });
  page.on("dialog", (dialog) => dialog.accept());
  await login(page, "開家與接機接待");
  const form = page.locator("#hosting-settings-form");
  await form.getByLabel("開放開家接待調查").check();
  await form.locator('textarea[name="hosting_description"]').fill("接待期間 2/19～2/22");
  await form.getByRole("button", { name: "儲存接待設定" }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  expect(saved).toEqual({ action: "save_reference", kind: "hosting", data: {
    is_hosting_open: true, hosting_description: "接待期間 2/19～2/22", is_pickup_open: false, pickup_description: "",
    hosting_identity_codes: ["general"], pickup_identity_codes: ["general"],
  } });
});

test("a 協助登記 pickup answer survives a settings save", async ({ page }) => {
  const openReference = () => ({ json: {
    settings: { event_name: "測試", is_registration_open: true, is_hosting_open: false, is_pickup_open: true },
    districts: [{ id: 1, name: "林森", sort_order: 1 }],
    activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }], program: [],
  } });
  await mockStaff(page, "admin", () => {}, "測試登記", { list_reference: openReference });
  await login(page, "協助登記");
  await page.locator('#new-registration-form [name="meal_identity"]').selectOption("general");
  const pickup = page.locator("#new-registration-pickup");
  await pickup.locator('[name="pickup_status"][value="yes"]').check();
  await pickup.locator('[name="pickup_count"]').selectOption("4");
  await go(page, "網站設定");
  await page.locator("#settings-form").getByRole("button", { name: "儲存網站設定" }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  await expect(pickup.locator('[name="pickup_count"]')).toHaveValue("4");
});

test("admins save the site note from the right side of the settings card", async ({ page }) => {
  let saved;
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved = payload; });
  await login(page, "網站設定");
  const form = page.locator("#settings-form");
  const note = form.locator('textarea[name="event_note"]');
  await expect(note).toHaveAttribute("maxlength", "500");
  await note.fill("捷運國父紀念館站 5 號出口 https://maps.app.goo.gl/abc123");
  await form.getByRole("button", { name: "儲存網站設定" }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  expect(saved.data.event_note).toBe("捷運國父紀念館站 5 號出口 https://maps.app.goo.gl/abc123");

  const { width } = page.viewportSize();
  const [left, right] = await form.evaluate((element) =>
    [".registration-main", ".registration-columns > label"].map((selector) => {
      const { x, y, width: w, height } = element.querySelector(selector).getBoundingClientRect();
      return { x, y, width: w, height };
    }));
  if (width >= 896) {
    expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  } else {
    expect(right.y).toBeGreaterThan(left.y + left.height - 1);
  }
  expect(right.x + right.width).toBeLessThanOrEqual(width);
});

test("staff do not see the hosting settings card", async ({ page }) => {
  await mockStaff(page, "staff");
  await login(page);
  await expect(page.getByText("測試登記")).toBeVisible();
  await expect(page.locator("#admin-hosting")).toBeHidden();
});

test("姓名｜區 and hosting sit left of the activity choices on wide screens and above them on phones", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", hostedRegistrations);
  await login(page);
  await page.getByRole("row", { name: /接待弟兄/ }).getByRole("button", { name: "查看／處理" }).click();
  const { width } = page.viewportSize();
  // All boxes in one call: opening the record scrolls smoothly, so separate reads would disagree.
  const [left, right, name, district, hosting] = await page.locator("#edit-registration-form").evaluate((form) =>
    [".registration-main", ".activity-panel", 'input[name="full_name"]', 'select[name="district_id"]', ".hosting-panel"].map((selector) => {
      const { x, y, width: w, height } = form.querySelector(selector).getBoundingClientRect();
      return { x, y, width: w, height };
    }));
  // 區 sits beside 姓名, and hosting follows them in the same column.
  expect(Math.abs(district.y + district.height / 2 - (name.y + name.height / 2))).toBeLessThan(4);
  expect(district.x).toBeGreaterThan(name.x + name.width - 1);
  expect(hosting.y).toBeGreaterThan(name.y + name.height - 1);
  if (width >= 896) {
    expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  } else {
    expect(right.y).toBeGreaterThan(left.y + left.height - 1);
  }
  expect(right.x + right.width).toBeLessThanOrEqual(width);
});

test("協助登記 may leave hosting unanswered while the survey is closed, until the server says it opened", async ({ page }) => {
  const created = [];
  await mockStaff(page, "staff", () => {}, "測試登記", {
    create_registration: (payload) => {
      created.push(payload);
      return created.length === 1
        ? { status: 409, json: { error: "開家接待調查已開放，請回答開家接待後再建立協助登記；看不到接待欄位時請重新整理頁面", code: "HOSTING_REQUIRED" } }
        : { status: 201, json: { serial_no: 2 } };
    },
  });
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  await form.locator('input[name="full_name"]').fill("協助未答");
  await form.locator('[name="meal_identity"]').selectOption("general");
  await form.locator('select[name="district_id"]').selectOption("1");
  await form.locator('input[name="activity_1"][value="false"]').check();
  await form.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#message")).toHaveText("開家接待調查已開放，請回答開家接待後再建立協助登記；看不到接待欄位時請重新整理頁面");
  expect(created[0].hosting).toBeNull();
  const hosting = page.locator("#new-registration-hosting");
  await expect(hosting.locator('input[name="hosting_status"]').first()).toHaveAttribute("required", "");
  await expect(form.locator('input[name="full_name"]')).toHaveValue("協助未答");
  await hosting.getByLabel("否", { exact: true }).check();
  await form.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#new-registration-code")).toHaveText("已建立流水號 2。本人日後可用相同的姓名與區查詢。");
  expect(created[1].hosting).toEqual({ status: "not_hosting", guest_type: null, guest_count: null });
});

test("a password set for another admin must be changed at their next login", async ({ page }) => {
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_staff: () => ({ json: { staff: [
      { auth_user_id: self, username: "tester", display_name: "測試服事者", role: "admin", is_active: true },
      { auth_user_id: other, username: "backup", display_name: "備援管理員", role: "admin", is_active: true },
    ] } }),
    set_staff_password: () => ({ json: { success: true, must_change_password: true } }),
  });
  page.on("dialog", (dialog) => dialog.accept());
  await login(page, "帳號");
  await page.locator("#staff-rows tr").nth(1).getByRole("button", { name: "修改" }).click();
  const form = page.locator("#staff-password-form");
  await form.locator('input[name="password"]').fill("new-admin-password-1");
  await form.getByRole("button", { name: "設定密碼" }).click();
  await expect(page.locator("#message")).toHaveText("密碼已設定。對方是管理員，下次登入時須改成自己的密碼；請以安全方式私下交付。");
});

const mealRegistration = (serial, name, choices, hosting, mealIdentity = null) => ({
  id: `223e4567-e89b-42d3-a456-42661417010${serial}`, serial_no: serial, full_name: name, district_id: 1,
  record_status: "active", import_status: "pending", updated_at: "2026-11-05T00:00:00Z", meal_identity: mealIdentity,
  registration_choices: Object.entries(choices).map(([id, attending]) => ({ activity_id: Number(id), attending })),
  registration_hosting: hosting ? { status: hosting, guest_type: hosting === "hosting" ? "any" : null,
    guest_count: hosting === "hosting" ? 2 : null, pickup_count: 0 } : null,
});
const mealActivities = [
  { id: 1, title: "測試限定午餐", category: "meal", is_published: true, sort_order: 1, fee_amount: 120, student_fee_amount: 70,
    cost_amount: 150, audience: "hosting", audience_note: null },
  { id: 2, title: "測試晚餐", category: "meal", is_published: true, sort_order: 2, fee_amount: 100, student_fee_amount: 60,
    cost_amount: null, audience: "all", audience_note: null },
  { id: 3, title: "測試聚會", category: "meeting", is_published: true, sort_order: 3, fee_amount: null, student_fee_amount: null,
    cost_amount: null, audience: "all", audience_note: null },
];
// 甲 hosts and is a student; 乙 signed up for the restricted lunch before it was restricted and never
// answered the identity; 丙 only has the open dinner; 丁 keeps an identity from a removed student price.
const mealReplies = (registrations = [
  mealRegistration(4, "甲", { 1: true, 2: true, 3: false }, "hosting", "student"),
  mealRegistration(3, "乙", { 1: true, 2: true, 3: false }, null),
  mealRegistration(2, "丙", { 1: false, 2: true, 3: false }, "not_hosting", "general"),
  mealRegistration(1, "丁", { 1: false, 2: false, 3: true }, "not_hosting", "student"),
], settings = {}) => ({
  list_reference: () => ({ json: {
    settings: { event_name: "測試", is_registration_open: true, ...settings },
    districts: [{ id: 1, name: "林森", sort_order: 1 }], activities: mealActivities, program: [],
  } }),
  list_registrations: () => ({ json: { count: registrations.length, registrations } }),
});

test("statistics estimate fees by identity, with cost, subsidy and the sign-ups outside an audience", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", mealReplies(undefined, { student_statistics_identity_code: "student" }));
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  const rows = page.locator("#stats-rows tr");
  // Fictional amounts. Unset fees are left out and counted: 乙 never answered the identity.
  // 午餐: 甲 student 70, 乙 left out; cost 2 × 150, subsidy over 甲 only: 150 − 70.
  const amountNote = rows.nth(0).locator("td").nth(6).locator(".amount-note");
  await expect(amountNote).toHaveCSS("background-color", "rgb(240, 241, 242)");
  await expect(amountNote).toContainText("未計入");
  await expect(rows.nth(0).locator("td")).toHaveText(["測試限定午餐", "2", "1", "0", "2", "0",
    "NT$70（未回覆身分者未計入）", "NT$300", "NT$80（未回覆身分者未計入）"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["測試晚餐", "3", "1", "0", "1", "0", "NT$160（未回覆身分者未計入）", "—", "—"]);
  // Nothing of the meeting's fee is set, so there is no sum to show.
  await expect(rows.nth(2).locator("td")).toHaveText(["測試聚會", "1", "1", "0", "3", "0", "—", "—", "—"]);
  // The free meeting needs no cost; only the charged dinner without one is named.
  // The summary shows plain amounts; 各活動 names what is left out.
  await expect(page.locator("#stats-summary")).toHaveText("有效登記 4 筆；預估費用 NT$230；預估成本 NT$300；"
    + "預估補貼 NT$80；測試晚餐尚未設定實際成本，未計入。"
    + "用餐身分未回覆 1 人。不符報名對象（限定前已報名）：測試限定午餐 1 人。");
  // The 合計 row matches the summary above, as a plain amount.
  await expect(page.locator("#district-stats-rows tr td")).toHaveText(["林森", "4", "2", "0", "NT$230", "合計", "4", "2", "0", "NT$230"]);
});

test("statistics CSV uses active registrations and published activities for the fee totals", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const replies = mealReplies(undefined, { student_statistics_identity_code: "student" });
  await mockStaff(page, "staff", () => {}, "測試登記", {
    ...replies,
    list_reference: () => {
      const result = replies.list_reference();
      result.json.activities.push({ id: 4, title: "未公開活動", is_published: false, fee_amount: 999 });
      return result;
    },
    list_registrations: () => {
      const result = replies.list_registrations();
      result.json.registrations.push({ ...result.json.registrations[0], id: "voided", serial_no: 5, record_status: "void" });
      return result;
    },
  });
  await login(page, "統計與匯出");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載統計 CSV" }).click();
  const csv = await readFile(await (await download).path(), "utf8");
  expect(csv).toContain('"有效登記 4 筆；預估費用 NT$230；預估成本 NT$300；預估補貼 NT$80；');
  expect(csv).toContain('"測試限定午餐","2","1","0","2","0","NT$70（未回覆身分者未計入）","NT$300","NT$80（未回覆身分者未計入）"');
  expect(csv).toContain('"測試晚餐","3","1","0","1","0","NT$160（未回覆身分者未計入）","—","—"');
  expect(csv).not.toContain("未公開活動");
  expect(csv).not.toContain("請先到身分別設定選擇學生統計身分");
  await expect(page.locator("#stats-summary")).toContainText("有效登記 4 筆");
});

test("statistics name no activity once every charged one has a cost", async ({ page }) => {
  const replies = mealReplies();
  await mockStaff(page, "staff", () => {}, "測試登記", { ...replies, list_reference: () => {
    const result = replies.list_reference();
    result.json.activities = result.json.activities.map((item) => item.id === 2 ? { ...item, cost_amount: 130 } : item);
    return result;
  } });
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  // Dinner: cost 3 × 130 = 390, subsidy over 甲 and 丙: 260 − 160 = 100, plus the lunch's 80; the meeting
  // has no fee, so it is not named.
  await expect(page.locator("#stats-summary")).toContainText("預估成本 NT$690；預估補貼 NT$180。");
});

test("statistics show no cost or subsidy until a cost is set", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", twoActivities);
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#stats-summary")).toHaveText("有效登記 1 筆；預估費用 NT$0；預估成本 —；預估補貼 —（尚未設定實際成本）。");
});

test("CSV shows the meal identity only where it is needed, and the fee by identity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await mockStaff(page, "staff", () => {}, "測試登記", mealReplies());
  await login(page, "統計與匯出");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載報名登記 CSV" }).click();
  const lines = (await readFile(await (await download).path(), "utf8")).split("\r\n");
  expect(lines[0]).toMatch(/"用餐身分","預估應付餐費","餐費未計入的活動"$/);
  expect(lines[1]).toMatch(/^"4","甲",.*,"學生","130",""$/);
  expect(lines[2]).toMatch(/^"3","乙",.*,"未回覆","未設定","測試限定午餐、測試晚餐"$/);
  expect(lines[3]).toMatch(/^"2","丙",.*,"一般","100",""$/);
  // 丁's stored identity is left from a removed student price, so it is not needed and stays blank.
  expect(lines[4]).toMatch(/^"1","丁",.*,"","未設定","測試聚會"$/);
});

test("the activity form saves prices, cost and audience, and confirms restricting one with outside sign-ups", async ({ page }) => {
  const saved = [];
  const replies = mealReplies();
  const open = { ...replies, list_reference: () => {
    const result = replies.list_reference();
    result.json.activities = result.json.activities.map((item) => item.id === 1
      ? { ...item, audience: "all" } : item.id === 3 ? { ...item, is_published: false } : item);
    return result;
  } };
  await mockStaff(page, "admin", (payload) => { if (payload.action === "save_reference") saved.push(payload.data); }, "測試登記", open);
  await login(page, "活動");
  const form = page.locator("#activity-form");
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).first().click();
  await expect(form.locator('input[name="fee_amount"]')).toHaveValue("120");
  await expect(form.locator('input[data-identity-price="student"]')).toHaveValue("70");
  await expect(form.locator('input[name="cost_amount"]')).toHaveValue("150");
  await expect(form.locator('select[name="audience"]')).toHaveValue("all");
  await expect(form.locator('select[name="audience"] option[value="pickup"]')).toHaveText("接機接待");
  await expect(form.locator('select[name="audience"] option[value="activity:1"]')).toHaveCount(0);
  await expect(form.locator('select[name="audience"] option[value="activity:2"]')).toHaveText("測試晚餐");
  await expect(form.locator('select[name="audience"] option[value="activity:3"]')).toHaveText("測試聚會（未公開）");
  await form.locator('select[name="audience"]').selectOption("hosting");
  await form.locator('input[name="audience_note"]').fill("限有開家接待的家庭");

  // 乙 signed up and has no hosting answer, so restricting the lunch leaves one sign-up outside it.
  const asked = [];
  page.once("dialog", (dialog) => { asked.push(dialog.message()); return dialog.dismiss(); });
  await form.getByRole("button", { name: /^儲存活動/ }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain("目前有 1 位不符對象的人已報名此活動，他們的報名會保留。");
  expect(saved).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await form.getByRole("button", { name: /^儲存活動/ }).click();
  await expect(page.locator("#message")).toHaveText("設定已儲存。");
  expect(saved[0]).toMatchObject({ id: "1", fee_amount: "120", student_fee_amount: 70, cost_amount: "150",
    audience: "hosting", audience_note: "限有開家接待的家庭" });

  // Each identity price can be set while the general price remains null.
  await form.locator('input[name="title"]').fill("新的餐");
  await expect(form.locator('input[data-identity-price="student"]')).toHaveAttribute("placeholder", "未設定");
  await expect(form.locator('input[data-identity-price="child"]')).toHaveAttribute("placeholder", "未設定");
  await form.locator('input[data-identity-price="student"]').fill("60");
  await form.getByRole("button", { name: "儲存活動" }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toMatchObject({fee_amount:"",student_fee_amount:60,identity_prices:[{identity_code:"student",fee_amount:60}]});
});

test("staff saving a sign-up from before a restriction confirm that it becomes 不參加", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; }, "測試登記",
    mealReplies([mealRegistration(3, "乙", { 1: true, 2: false, 3: false }, null, "general")]));
  await login(page);
  await page.getByRole("button", { name: "查看／處理" }).click();
  const lunch = page.locator('#detail-choices [data-activity="1"]');
  // Viewing shows what is stored: the old sign-up and its identity, with no revert yet.
  await expect(lunch.locator('input[value="true"]')).toBeChecked();
  await expect(lunch.locator(".audience-reverted")).toBeHidden();
  await expect(page.locator('#edit-registration-form [name="meal_identity"]')).toBeVisible();
  await expect(page.locator('#edit-registration-form [name="meal_identity"]')).toHaveValue("general");
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await expect(lunch.locator('input[value="false"]')).toBeChecked();
  await expect(lunch.locator('input[value="true"]')).toBeDisabled();
  await expect(lunch.locator(".audience-reverted")).toHaveText("不符報名對象，已改為不參加。");
  // The lunch was the only student-priced meal, so the question is gone.
  await expect(page.locator("#detail-choices .meal-identity")).toBeHidden();
  await page.locator('#edit-registration-form input[name="full_name"]').fill("乙更正");

  const asked = [];
  page.once("dialog", (dialog) => { asked.push(dialog.message()); return dialog.dismiss(); });
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toBe("這筆登記有 1 項限定活動不符報名對象，儲存後會改為不參加。確定儲存？");
  expect(saved).toBeUndefined();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  expect(saved.choices).toEqual([{ activity_id: 1, attending: false }, { activity_id: 2, attending: false }, { activity_id: 3, attending: false }]);
  expect(saved.meal_identity).toBe("general");
});

test("an unanswered restricted activity stays 未回覆 when staff save an older registration", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; }, "測試登記",
    mealReplies([mealRegistration(3, "乙", { 2: false, 3: false }, null)]));
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  await login(page);
  await page.getByRole("button", { name: "查看／處理" }).click();
  const lunch = page.locator('#detail-choices [data-activity="1"]');
  await expect(lunch).toContainText("（未回覆，可留空）");
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await expect(lunch.locator("input:checked")).toHaveCount(0);
  await expect(lunch.locator('input[value="true"]')).toBeDisabled();
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  // Nothing about the lunch is sent, so the save changes no answer, and there was nothing to confirm.
  expect(saved.choices).toEqual([{ activity_id: 2, attending: false }, { activity_id: 3, attending: false }]);
  expect(dialogs).toEqual([]);
});

test("協助登記 follows the audience and asks the identity for a student-priced meal", async ({ page }) => {
  let created;
  await mockStaff(page, "staff", () => {}, "測試登記", { ...mealReplies(undefined, { is_hosting_open: true }), create_registration: (payload) => {
    created = payload;
    return { status: 201, json: { serial_no: 5 } };
  } });
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  const lunch = form.locator('[data-activity="1"]');
  const identity = form.locator('[name="meal_identity"]');
  await identity.selectOption("general");
  await expect(lunch.locator('input[value="true"]')).toBeDisabled();
  await page.locator("#new-registration-hosting").getByLabel("家人已登記開家接待").check();
  await expect(lunch.locator('input[value="true"]')).toBeEnabled();
  await form.locator('input[name="full_name"]').fill("協助學生");
  await form.locator('select[name="district_id"]').selectOption("1");
  await lunch.locator('input[value="true"]').check();
  await form.locator('input[name="activity_2"][value="false"]').check();
  await form.locator('input[name="activity_3"][value="false"]').check();
  // The identity question is required.
  await identity.selectOption("");
  await form.getByRole("button", { name: "建立協助登記" }).click();
  expect(created).toBeUndefined();
  // A student is not asked hosting, so staff cannot answer it; the audience exemption keeps the meal.
  await identity.selectOption("student");
  await expect(page.locator("#new-registration-hosting")).toBeHidden();
  await expect(lunch.locator('input[value="true"]')).toBeChecked();
  await form.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#new-registration-code")).toContainText("已建立流水號 5");
  await expect(page.locator("#message")).toHaveText("協助登記已建立。");
  expect(created.meal_identity).toBe("student");
  expect(created.hosting).toBeNull();
  expect(created.choices).toEqual([{ activity_id: 1, attending: true }, { activity_id: 2, attending: false }, { activity_id: 3, attending: false }]);
});

test("各區各活動 shows three cards a row on wide screens and one a row on phones", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", {
    list_reference: () => ({ json: {
      settings: { event_name: "測試", is_registration_open: false },
      districts: ["林森", "忠孝", "杭州", "其他"].map((name, index) => ({ id: index + 1, name, sort_order: index + 1 })),
      activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }], program: [],
    } }),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  // Clicking the nav link brings 統計與匯出 into view, also where it is shown one section at a time.
  await page.locator('.staff-nav a[href="#section-stats"]').click();
  await page.getByRole("button", { name: "更新統計" }).click();
  const cards = page.locator("#district-activity-cards > .mini-card");
  await expect(cards).toHaveCount(5);
  const boxes = () => cards.evaluateAll((items) => items.map((item) => {
    const { x, y } = item.getBoundingClientRect();
    return { x: Math.round(x), y: Math.round(y) };
  }));
  // 全會所 and the first two districts on top, the other two below, starting under 全會所.
  let at = await boxes();
  expect(new Set(at.slice(0, 3).map((box) => box.y)).size).toBe(1);
  expect(at[3].y).toBe(at[4].y);
  expect(at[3].y).toBeGreaterThan(at[0].y);
  expect(at[3].x).toBe(at[0].x);
  expect(at[4].x).toBe(at[1].x);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(async () => new Set((await boxes()).map((box) => box.x)).size).toBe(1);
  at = await boxes();
  expect(at.every((box, index) => index === 0 || box.y > at[index - 1].y)).toBe(true);
});

test("admin forms and statistics are compact: fields share rows on wide screens and stack on phones", async ({ page }) => {
  await mockStaff(page, "admin", () => {}, "測試登記", { list_staff: () => ({ json: { staff: [
    { auth_user_id: "123e4567-e89b-42d3-a456-426614174099", username: "helper", display_name: "測試服事者乙", role: "staff", is_active: true },
  ] } }) });
  await login(page, "活動");
  await expect(page.locator("#section-new h2")).toHaveText("協助登記");
  await expect(page.locator('.staff-nav a[href="#section-new"]')).toHaveText("協助登記");
  // A hidden element measures as an empty box at 0, 0, so each check opens its view first.
  await expect(page.locator("#activity-form")).toBeVisible();
  const wide = page.viewportSize().width >= 896;
  // Both boxes in one call: opening the staff editor scrolls smoothly, so separate reads would disagree.
  const sameRow = (first, second) => page.evaluate(([a, b]) => {
    const [one, two] = [a, b].map((selector) => document.querySelector(selector).getBoundingClientRect());
    return one.width > 0 && two.width > 0 && Math.abs(one.y - two.y) < 2 && two.x > one.x + one.width - 1;
  }, [first, second]);
  // A row of related fields, and a date beside its time even on a phone.
  expect(await sameRow('#activity-form label:has([name="category"])', '#activity-form label:has([name="title"])')).toBe(wide);
  expect(await sameRow('#activity-form label:has([name="starts_on"])', '#activity-form label:has([name="starts_time"])')).toBe(true);
  await go(page, "時間表");
  expect(await sameRow('#program-form label:has([name="event_date"])', '#program-form label:has([name="start_time"])')).toBe(true);
  await go(page, "帳號");
  expect(await sameRow('#create-staff-form label:has([name="username"])', '#create-staff-form label:has([name="display_name"])')).toBe(wide);
  // The short statistics tables share a row on wide screens.
  await go(page, "統計與匯出");
  expect(await sameRow("#section-stats .stat-cards > :nth-child(1)", "#section-stats .stat-cards > :nth-child(2)")).toBe(wide);
  // Every statistics card fits its table without a sideways scroll bar; on phones 各區 wraps its five columns instead.
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#district-activity-cards > .mini-card")).toHaveCount(2);
  const summaryCards = page.locator(".summary-stat-cards > .mini-card");
  await expect(summaryCards.locator("h3")).toHaveText(["各區", "接待對象", "開家接待回覆", "接機"]);
  const layout = await summaryCards.evaluateAll((cards) => cards.map((card) => ({
    top: card.offsetTop, left: card.offsetLeft, height: card.offsetHeight,
    rows: [...card.querySelectorAll("tr")].map((row) => row.getBoundingClientRect().top),
  })));
  if (wide) {
    expect(layout[0].top).toBe(layout[1].top);
    expect(layout[2].top).toBeGreaterThan(layout[0].top);
    expect(layout[2].top).toBe(layout[3].top);
    expect(layout[2].height).toBe(layout[3].height);
    expect(layout[2].rows).toEqual(layout[3].rows);
  } else {
    expect(new Set(layout.map((card) => card.left)).size).toBe(1);
    expect(layout.every((card, index) => !index || card.top > layout[index - 1].top)).toBe(true);
  }
  expect(await summaryCards.locator("th, td").evaluateAll((cells) => [...new Set(cells.map((cell) =>
    `${cell.closest(".mini-card").querySelector("h3").textContent}:${getComputedStyle(cell).whiteSpace}`))]))
    .toEqual(["各區:" + (wide ? "nowrap" : "normal"), "接待對象:nowrap", "開家接待回覆:nowrap", "接機:nowrap"]);
  expect(await page.locator("#section-stats .stat-cards .table-scroll").evaluateAll((boxes) => boxes
    .filter((box) => box.scrollWidth > box.clientWidth).map((box) => box.closest(".mini-card").querySelector("h3").textContent)))
    .toEqual([]);
  // 修改帳號 and 設定密碼 are two cards side by side.
  await go(page, "帳號");
  await page.locator("#staff-rows tr").first().getByRole("button", { name: "修改" }).click();
  expect(await sameRow("#staff-editor > :nth-child(1)", "#staff-editor > :nth-child(2)")).toBe(wide);
  // Nothing widens the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
});

// 兒童 (2026-11-09): a parent with two children in the list, one of them in it too, and a child whose parent is not.
const familyRow = (serial, name, extra = {}) => ({ id: `${serial}23e4567-e89b-42d3-a456-426614174000`.slice(-36), serial_no: serial,
  full_name: name, district_id: 1, record_status: "active", import_status: "pending", updated_at: "2026-11-09T00:00:00Z",
  registration_choices: [{ activity_id: 1, attending: true }], is_child: false, child_type: "", parent_name: null, ...extra });
const family = [
  familyRow(5, "王爸爸", { children: [{ serial_no: 3, full_name: "王大明" }, { serial_no: 4, full_name: "王小明" }], registration_hosting: { status: "hosting", guest_type: "any", guest_count: 2 } }),
  familyRow(4, "王小明", { is_child: true, meal_identity: "child", child_type: "elementary", parent_name: "王爸爸", registration_hosting: { status: "not_hosting" }, registration_pickup: { status: "no", count: 0 } }),
  familyRow(3, "王大明", { is_child: true, meal_identity: "child", child_type: "elementary", parent_name: "王爸爸", registration_hosting: { status: "not_hosting" }, registration_pickup: { status: "no", count: 0 } }),
  familyRow(2, "李小華", { is_child: true, meal_identity: "child", child_type: "elementary", parent_name: "李媽媽", district_id: 2 }),
  familyRow(1, "陳弟兄", { children: [] }),
];
const familyReference = { settings: { event_name: "測試", is_hosting_open: true, is_pickup_open: true },
  districts: [{ id: 1, name: "林森", sort_order: 1 }, { id: 2, name: "中山", sort_order: 2 }],
  activities: [{ id: 1, title: "測試聚會", is_published: true, fee_amount: 0 }], program: [] };
const familyReplies = {
  list_reference: () => ({ json: familyReference }),
  list_registrations: () => ({ json: { count: family.length, registrations: family } }),
};

// Ticks only the named boxes in the 身分別 checklist, opening it first.
async function pickIdentities(page, names) {
  const form = page.locator("#search-form");
  if (!await form.locator(".identity-filter details").evaluate((details) => details.open)) await form.locator(".identity-filter summary").click();
  const all = form.getByLabel("全部身分", { exact: true });
  await all.check();
  await all.uncheck();
  for (const name of names) await form.getByLabel(name, { exact: true }).check();
}

test("student badges, dynamic identity filters and stacked child statistics use the unified identity", async ({ page }) => {
  const student = familyRow(6, "學生驗證", { meal_identity: "student" });
  const people = [student, ...family];
  const requests = [];
  // The 身分別 order, a stopped identity in the middle and a stopped unused one that the filter leaves out.
  const identities = [["preschool", "兒童（學齡前）"], ["general", "一般"], ["student", "學生"], ["child", "兒童（國小）"]]
    .map(([code, name]) => ({ code, name, is_active: true, public_selectable: true }));
  identities.splice(2, 0, { code: "old", name: "舊身分", is_active: false, public_selectable: false });
  identities.push({ code: "unused", name: "未使用", is_active: false, public_selectable: false });
  await mockStaff(page, "staff", (payload) => requests.push(payload), "測試登記", {
    list_reference: () => ({ json: { ...familyReference, identities, used_identity_codes: ["old"] } }),
    list_registrations: () => ({ json: { count: people.length, registrations: people } }),
  });
  await login(page);
  await expect(page.locator("#registration-rows tr").first().locator(".child-badge")).toHaveText("學生");
  await expect(page.locator("#search-form .identity-filter-menu label")).toHaveText(
    ["全部身分", "兒童（學齡前）", "一般", "舊身分（已停用）", "學生", "兒童（國小）", "未填身分"]);
  await pickIdentities(page, ["學生"]);
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await expect.poll(() => requests.at(-1).meal_identities).toEqual(["student"]);
  await expect(page.locator("#search-form .identity-filter summary")).toHaveText("學生");
  await page.locator("#registration-rows tr").first().getByRole("button", { name: "查看／處理" }).click();
  await expect(page.locator("#detail-title .child-badge")).toHaveText("學生");
  await expect(page.locator('#edit-registration-form [name="meal_identity"]')).toHaveValue("student");
  await expect(page.locator("#detail-choices .meal-identity")).toHaveCount(0);
  await go(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  const childCell = page.locator("#stats-rows tr").first().locator("td").nth(3);
  await expect(childCell.locator(".child-badge")).toHaveText("兒童（國小） 3");
  await expect(childCell.locator(".child-badge")).toHaveCount(1);
  await expect(childCell).toHaveAttribute("data-csv", "3（國小 3）");
  const [total, detail] = await childCell.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element.firstChild);
    return [range.getBoundingClientRect().bottom, element.querySelector(".stat-details").getBoundingClientRect().top];
  });
  expect(detail).toBeGreaterThanOrEqual(total);
});

test("親子 sits between 更新時間 and 操作: a child shows the parent's name and a listed parent the children's names", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", familyReplies);
  await login(page);
  const headers = await page.locator("#registration-table th").allTextContents();
  expect(headers.slice(-3)).toEqual(["更新時間", "親子", "操作"]);
  const familyHint = page.locator("#section-registrations .hint").filter({ hasText: "親子：" });
  await expect(familyHint).toHaveText("親子：兒童顯示登記時填寫的家長姓名；家長顯示同區有效登記中對應的兒童姓名。");
  // The note has a warm grey background and a bold label so staff notice it.
  await expect(familyHint).toHaveCSS("background-color", "rgb(243, 241, 238)");
  await expect(familyHint.locator("strong")).toHaveText("親子：");
  await expect(page.locator("#registration-rows td:nth-child(7)")).toHaveText(["兒童：王大明、王小明", "家長：王爸爸", "家長：王爸爸", "家長：李媽媽", ""]);
  // The names are plain text; the record view is where a child's record opens.
  await expect(page.locator("#registration-rows td:nth-child(7) button")).toHaveCount(0);
  await expect(page.locator("#registration-rows .parent-check")).toHaveCount(0);
});

test("the 身分別 checklist filters by several identities and 未填身分, with 區 and paging, and 清除條件 or 登出 clears it", async ({ page }) => {
  const lists = [];
  await mockStaff(page, "staff", () => {}, "測試登記", {
    ...familyReplies,
    list_registrations: (payload) => {
      if (payload.before_serial !== undefined) return { json: { registrations: [] } };
      lists.push(payload);
      return { json: { count: 11, registrations: payload.meal_identities ? family.filter((row) => row.is_child) : family } };
    },
  });
  await login(page);
  const form = page.locator("#search-form");
  const details = form.locator(".identity-filter details");
  const summary = form.locator(".identity-filter summary");
  const clear = page.getByRole("button", { name: "清除條件" });
  const search = page.getByRole("button", { name: "搜尋" });
  const boxes = form.locator('[name="identity_filter"]');
  const unfiltered = { action: "list_registrations", summary: true, page: 0, search: "" };
  // 身分別 sits after 區, level with the boxes, on a wide screen.
  await expect(summary).toHaveText("全部身分");
  if (page.viewportSize().width > 700) {
    const [district, box] = await Promise.all([form.locator('select[name="district_id"]').boundingBox(), summary.boundingBox()]);
    expect(box.x).toBeGreaterThan(district.x + district.width);
    const middle = box.y + box.height / 2;
    expect(middle).toBeGreaterThan(district.y);
    expect(middle).toBeLessThan(district.y + district.height);
  }
  await expect(form.locator(".identity-filter-menu label")).toHaveText(["全部身分", "一般", "學生", "兒童（國小）", "兒童（學齡前）", "未填身分"]);

  // 全部身分 clears every box; nothing ticked is still no condition.
  await pickIdentities(page, []);
  await expect(summary).toHaveText("未選身分");
  await expect(clear).toBeDisabled();
  await form.getByLabel("兒童（國小）", { exact: true }).check();
  await form.getByLabel("兒童（學齡前）", { exact: true }).check();
  await expect(summary).toHaveText("兒童（國小）、兒童（學齡前）");
  await expect(form.getByLabel("全部身分", { exact: true })).toHaveJSProperty("indeterminate", true);
  await expect(clear).toBeEnabled();
  // A click outside closes the list.
  await page.locator("#section-registrations h2").click();
  await expect(details).not.toHaveAttribute("open");
  await form.locator('select[name="district_id"]').selectOption({ label: "林森" });
  await search.click();
  await expect(page.locator("#registration-rows tr")).toHaveCount(3);
  await page.locator("#next-page").click();
  await expect(page.locator("#page-number")).toHaveText("第 2 頁");
  expect(lists.slice(1)).toEqual([
    { ...unfiltered, district_id: 1, meal_identities: ["child", "preschool"] },
    { ...unfiltered, page: 1, district_id: 1, meal_identities: ["child", "preschool"] },
  ]);

  // Three or more read as a count; 未填身分 is sent as null.
  await pickIdentities(page, ["一般", "兒童（學齡前）", "未填身分"]);
  await expect(summary).toHaveText("已選 3 種身分");
  await page.keyboard.press("Escape");
  await expect(details).not.toHaveAttribute("open");
  await search.click();
  await expect.poll(() => lists.at(-1).meal_identities).toEqual(["general", "preschool", null]);
  // Ticking every box is 全部身分 again.
  await summary.click();
  await form.getByLabel("全部身分", { exact: true }).check();
  await expect(boxes.and(page.locator(":checked"))).toHaveCount(5);
  await search.click();
  await expect.poll(() => lists.at(-1)).toEqual({ ...unfiltered, district_id: 1 });

  // Nothing ticked searches 全部身分 and ticks every box again.
  await pickIdentities(page, []);
  await search.click();
  await expect(details).not.toHaveAttribute("open");
  await expect(summary).toHaveText("全部身分");
  await expect(boxes.and(page.locator(":checked"))).toHaveCount(5);

  await pickIdentities(page, ["兒童（學齡前）"]);
  await search.click();
  await expect.poll(() => lists.at(-1).meal_identities).toEqual(["preschool"]);
  await clear.click();
  await expect(summary).toHaveText("全部身分");
  await expect.poll(() => lists.at(-1)).toEqual(unfiltered);

  await pickIdentities(page, ["學生"]);
  await search.click();
  await expect.poll(() => lists.at(-1).meal_identities).toEqual(["student"]);
  await page.getByRole("button", { name: "登出" }).click();
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect.poll(() => lists.at(-1)).toEqual(unfiltered);
  await expect(summary).toHaveText("全部身分");
});

test("協助登記 for a child hides the surveys it cannot answer and requires the parent's name at the bottom", async ({ page }) => {
  const created = [];
  await mockStaff(page, "staff", (payload) => { if (payload.action === "create_registration") created.push(payload); },
    "測試登記", { ...familyReplies, create_registration: () => ({ status: 201, json: { serial_no: 6 } }) });
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  // The panel shows only for an identity that can answer at least one survey.
  await expect(form.locator(".hosting-panel")).toBeHidden();
  await form.getByRole("combobox", { name: "身分別", exact: true }).selectOption("general");
  await expect(form.locator(".hosting-panel")).toBeVisible();
  await form.getByRole("combobox", { name: "身分別", exact: true }).selectOption("child");
  await expect(form.locator(".hosting-panel")).toBeHidden();
  await expect(form.locator(".child-hint")).toHaveText("兒童報名請在表單最下方填寫家長姓名。");
  expect(await form.evaluate((element) => [...element.children].filter((item) => item.checkVisibility())
    .slice(-2).map((item) => item.className || item.tagName))).toEqual(["parent-name", "BUTTON"]);
  await form.locator('input[name="full_name"]').fill("王小美");
  await form.locator('select[name="district_id"]').selectOption("1");
  await form.locator('input[name="activity_1"][value="true"]').check();
  await page.getByRole("button", { name: "建立協助登記" }).click();
  expect(await form.evaluate((element) => element.checkValidity())).toBe(false);
  await form.locator('input[name="parent_name"]').fill("  ");
  await page.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#message")).toHaveText("請填寫家長姓名");
  expect(created).toHaveLength(0);
  await form.locator('input[name="parent_name"]').fill(" 王爸爸 ");
  await page.getByRole("button", { name: "建立協助登記" }).click();
  await expect(page.locator("#message")).toHaveText("協助登記已建立。");
  expect(created[0]).toMatchObject({ full_name: "王小美", meal_identity: "child", child_type: "elementary", parent_name: "王爸爸", hosting: null, pickup: null });
  // A new registration starts with no identity selected.
  await expect(form.getByRole("combobox", { name: "身分別", exact: true })).toHaveValue("");
  await expect(form.locator(".hosting-panel")).toBeHidden();
  await expect(form.locator(".parent-name")).toBeHidden();
});

test("a parent's record lists the children by name, and a name opens that child's record by serial number", async ({ page }) => {
  const lists = [];
  await mockStaff(page, "staff", () => {}, "測試登記", {
    ...familyReplies,
    list_registrations: (payload) => {
      if (payload.before_serial !== undefined) return { json: { registrations: [] } };
      lists.push(payload);
      const rows = payload.search ? family.filter((row) => String(row.serial_no) === payload.search) : family;
      return { json: { count: rows.length, registrations: rows } };
    },
  });
  await login(page);
  const children = page.locator("#detail-children");
  // A record without children has no list.
  await page.locator("#registration-rows tr").nth(4).getByRole("button", { name: "查看／處理" }).click();
  await expect(page.locator("#detail-title")).toHaveText("登記 #1｜陳弟兄");
  await expect(children).toBeHidden();

  await page.locator("#registration-rows tr").first().getByRole("button", { name: "查看／處理" }).click();
  await expect(children.locator("strong")).toHaveText("這位家長的兒童");
  await expect(children.locator("li")).toHaveText(["#3 王大明", "#4 王小明"]);
  // While editing the names are plain text, so a click cannot drop unsaved changes.
  await page.getByRole("button", { name: "修改登記資料" }).click();
  await expect(children.locator("li")).toHaveText(["#3 王大明", "#4 王小明"]);
  await expect(children.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "取消修改" }).click();

  // Search conditions applied before the click give way to the child's serial number.
  await page.locator('#search-form select[name="district_id"]').selectOption({ label: "中山" });
  await pickIdentities(page, ["兒童（國小）"]);
  await page.getByRole("button", { name: "搜尋" }).click();
  await expect.poll(() => lists.at(-1)).toEqual({ action: "list_registrations", summary: true, page: 0, search: "", district_id: 2, meal_identities: ["child"] });
  await children.getByRole("button", { name: "#4 王小明" }).click();
  await expect(page.locator("#detail-title")).toHaveText("登記 #4｜王小明兒童（國小）");
  expect(lists.at(-1)).toEqual({ action: "list_registrations", summary: true, page: 0, search: "4" });
  await expect(page.locator('#search-form input[name="search"]')).toHaveValue("4");
  await expect(page.locator('#search-form select[name="district_id"]')).toHaveValue("");
  await expect(page.locator("#search-form .identity-filter summary")).toHaveText("全部身分");
  await expect(page.locator("#registration-rows tr")).toHaveCount(1);
  await expect(page.locator("#edit-registration-form").getByRole("combobox", { name: "身分別", exact: true })).toHaveValue("child");
  await expect(children).toBeHidden();
  // 清除條件 brings the full list back.
  await page.getByRole("button", { name: "清除條件" }).click();
  await expect(page.locator("#registration-rows tr")).toHaveCount(5);
});

test("a child's record shows the parent's name read-only and can be changed back to an adult", async ({ page }) => {
  let saved;
  await mockStaff(page, "staff", (payload) => { if (payload.action === "save_registration") saved = payload; },
    "測試登記", familyReplies);
  await login(page);
  await page.locator("#registration-rows tr").nth(1).getByRole("button", { name: "查看／處理" }).click();
  const form = page.locator("#edit-registration-form");
  await expect(form.getByRole("combobox", { name: "身分別", exact: true })).toHaveValue("child");
  await expect(form.getByRole("combobox", { name: "身分別", exact: true })).toBeDisabled();
  await expect(form.locator('input[name="parent_name"]')).toHaveValue("王爸爸");
  await expect(form.locator('input[name="parent_name"]')).toBeDisabled();
  await expect(form.locator(".hosting-panel")).toBeVisible();
  await expect(form.locator(".child-hint")).toBeHidden();
  // Viewing shows the saved answers even though a child is asked neither survey; editing hides the panel.
  await expect(form.locator("#detail-hosting")).toBeVisible();

  await page.getByRole("button", { name: "修改登記資料" }).click();
  await expect(form.locator(".hosting-panel")).toBeHidden();
  await expect(form.locator('input[name="parent_name"]')).toBeEditable();
  await form.getByRole("combobox", { name: "身分別", exact: true }).selectOption("general");
  await expect(form.locator(".hosting-panel")).toBeVisible();
  await expect(form.locator('#detail-hosting [name="hosting_status"][value="not_hosting"]')).toBeChecked();
  await expect(form.locator(".parent-name")).toBeHidden();
  await page.getByRole("button", { name: "儲存登記" }).click();
  await expect(page.locator("#message")).toHaveText("登記資料已儲存。");
  expect(saved).toMatchObject({ child_type: "", pickup: { status: "no", count: 0 } });
  expect(saved.hosting.status).toBe("not_hosting");
  expect(saved).not.toHaveProperty("parent_name");
});

test("statistics count children per district, and the registration CSV has 兒童 and 家長姓名", async ({ page }, testInfo) => {
  await mockStaff(page, "staff", () => {}, "測試登記", familyReplies);
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#district-stats-rows").locator("xpath=..").locator("th")).toHaveText(["區", "有效登記", "其中學生", "其中兒童", "預估費用"]);
  await expect(page.locator("#district-stats-rows tr")).toHaveText([/林森\s*4—2/, /中山\s*1—1/, /合計\s*5—3/]);
  await expect(page.locator("#stats-rows tr td").nth(3)).toHaveText("3兒童（國小） 3");
  test.skip(testInfo.project.name !== "desktop-chromium", "Downloads are checked once.");
  const stats = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載統計 CSV" }).click();
  const statsCsv = await readFile(await (await stats).path(), "utf8");
  expect(statsCsv).toContain('"測試聚會","5","—","3（國小 3）","0","0"');
  expect(statsCsv).toContain('"區","有效登記","其中學生","其中兒童","預估費用"');
  expect(statsCsv).toContain('"合計","5","—","3（國小 3）","—"');
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載報名登記 CSV" }).click();
  const csv = await readFile(await (await download).path(), "utf8");
  expect(csv).toContain('"流水號","姓名","區","兒童","家長姓名","匯入狀態"');
  expect(csv).toContain('"4","王小明","林森","國小","王爸爸"');
  expect(csv).toContain('"5","王爸爸","林森","",""');
});

test("admin selects a custom student identity for every activity and district, then clears it", async ({ page }) => {
  const reference = { settings: { event_name: "測試", student_statistics_identity_code: null },
    districts: [{ id: 1, name: "林森" }, { id: 2, name: "中山" }],
    activities: [{ id: 1, title: "聚會", category: "meeting", is_published: true, fee_amount: null },
      { id: 2, title: "無人參加", category: "meeting", is_published: true, fee_amount: null }], program: [],
    identities: [
      { code: "general", name: "一般", is_active: true },
      { code: "student", name: "學生(大專)", is_active: false },
      { code: "identity_new", name: "學生", is_active: true },
      { code: "child", name: "兒童（國小）", is_active: true },
      { code: "preschool", name: "兒童（學齡前）", is_active: true },
    ] };
  const registrations = [
    familyRow(1, "舊學生", { meal_identity: "student" }),
    familyRow(2, "新學生", { meal_identity: "identity_new" }),
    familyRow(3, "未參加學生", { district_id: 2, meal_identity: "identity_new", registration_choices: [{ activity_id: 1, attending: false }] }),
    familyRow(4, "作廢學生", { meal_identity: "identity_new", record_status: "void" }),
  ];
  const writes = [];
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: reference }),
    list_registrations: () => ({ json: { count: registrations.length, registrations } }),
    save_reference: ({ kind, data }) => {
      writes.push({ kind, data });
      reference.settings.student_statistics_identity_code = data.code;
      return { json: { saved: reference.settings } };
    },
  });
  await login(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#student-statistics-hint")).toBeVisible();
  await expect(page.locator("#stats-rows tr td").nth(2)).toHaveText("—");
  await expect(page.locator("#district-stats-rows tr.total td").nth(2)).toHaveText("—");
  await go(page, "身分別");
  const form = page.locator("#student-statistics-identity-form");
  const select = form.getByRole("combobox", { name: "學生統計身分" });
  await expect(select.locator("option")).toHaveText(["未指定", "學生"]);
  await select.selectOption("identity_new");
  await form.getByRole("button", { name: "儲存學生統計身分" }).click();
  // The save redraws everything showing identities; a failing redraw would replace this message.
  await expect(page.locator("#message")).toHaveText("學生統計身分已儲存。");
  await expect(select).toHaveValue("identity_new");
  expect(writes[0]).toEqual({ kind: "student_statistics_identity", data: { code: "identity_new" } });
  await go(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#student-statistics-hint")).toBeHidden();
  await expect(page.locator("#stats-rows tr td").nth(2)).toHaveText("1");
  await expect(page.locator("#stats-rows tr").nth(1).locator("td").nth(2)).toHaveText("0");
  await expect(page.locator("#district-stats-rows tr td")).toHaveText([
    "林森", "2", "1", "0", "—", "中山", "1", "1", "0", "NT$0", "合計", "3", "2", "0", "—",
  ]);
  reference.identities.find((identity) => identity.code === "identity_new").is_active = false;
  await page.reload();
  await go(page, "身分別");
  await expect(select.locator("option:checked")).toHaveText("學生（已停用）");
  await select.selectOption("");
  await form.getByRole("button", { name: "儲存學生統計身分" }).click();
  expect(writes[1]).toEqual({ kind: "student_statistics_identity", data: { code: null } });
  await go(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  await expect(page.locator("#student-statistics-hint")).toBeVisible();
  await expect(page.locator("#stats-rows tr td").nth(2)).toHaveText("—");
});

test("unified identity aligns with name and district and remains present without meals", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", mealReplies());
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  const identity = form.locator('[name="meal_identity"]');
  await expect(identity).toBeVisible();
  await expect(form.locator(".meal-identity")).toHaveCount(0);
  await identity.selectOption("child");
  await expect(form.locator(".parent-name")).toBeVisible();
  await identity.selectOption("general");
  await expect(form.locator(".parent-name")).toBeHidden();
  const boxes = await form.locator('.identity-fields > label').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().bottom));
  if (page.viewportSize().width >= 672) expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
});

test("admins manage meal identities, and prices typed into the activity form survive", async ({ page }) => {
  const reference = { settings: { event_name: "測試" }, districts: [{ id: 1, name: "林森" }], program: [],
    activities: [{ id: 1, title: "晚餐", category: "meal", is_published: true, fee_amount: 120, activity_identity_prices: [] }] };
  migrateReference(reference);
  const writes = [];
  let rejectIdentitySave = false;
  await mockStaff(page, "admin", () => {}, "測試登記", {
    list_reference: () => ({ json: reference }),
    save_reference: ({ kind, data }) => {
      if (kind === "identity" && rejectIdentitySave) return { status: 500, json: { error: "測試儲存失敗" } };
      writes.push({ kind, data });
      if (kind === "identity") {
        const existing = reference.identities.find((item) => item.code === data.code);
        if (existing) Object.assign(existing, data);
        else reference.identities.push({ ...data, code: "volunteer" });
      } else if (kind === "delete_identity") {
        reference.identities = reference.identities.filter((item) => item.code !== data.code);
      }
      return { json: { saved: {} } };
    },
  });
  await login(page, "身分別");
  const form = page.locator("#identity-form");
  const cancel = form.getByRole("button", { name: "取消編輯" });
  const submit = form.locator('button[type="submit"]');
  // A new identity needs no way out, so 取消編輯 shows only while one is being edited.
  await expect(cancel).toBeHidden();
  await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await form.getByLabel("身分名稱").fill("志工");
  await form.getByLabel("啟用", { exact: true }).check();
  await form.getByLabel("開放報名者選擇").uncheck();
  await form.getByRole("button", { name: "儲存身分" }).click();
  await expect(page.locator("#identity-rows")).toContainText("志工");
  expect(writes[0]).toEqual({ kind: "identity", data: { code: "", name: "志工", is_active: true, public_selectable: false, show_badge: false, badge_color: "#e1effe" } });

  await go(page, "活動");
  await page.locator("#activity-rows").getByRole("button", { name: "編輯" }).click();
  await page.locator('[data-identity-price="child"]').fill("80");
  await page.locator('[data-identity-price="volunteer"]').fill("0");
  // Renaming an identity redraws the price fields without losing what was typed.
  await go(page, "身分別");
  await page.locator("#identity-rows tr").filter({ hasText: "志工" }).getByRole("button", { name: "編輯" }).click();
  await expect(submit).toHaveText("儲存身分（編輯：志工）");
  await expect(cancel).toBeVisible();
  const originalViewport = page.viewportSize();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => form.evaluate((element) => {
      const save = element.querySelector('button[type="submit"]').getBoundingClientRect();
      const cancel = element.querySelector('button[type="reset"]').getBoundingClientRect();
      const name = element.elements.name.getBoundingClientRect();
      return Math.abs(save.y - cancel.y) < 2 && save.right <= cancel.x && cancel.right <= innerWidth
        && (innerWidth !== 1440 || Math.abs(save.y - name.y) < 2);
    }), { message: `Identity actions fit together at ${width}px` }).toBe(true);
  }
  await page.setViewportSize(originalViewport);
  await form.getByLabel("身分名稱").fill("服事者");
  await form.getByLabel("顯示標籤").check();
  await form.locator('[name="badge_color_hex"]').fill("#123456");
  await expect(form.locator('[name="badge_color"]')).toHaveValue("#123456");
  rejectIdentitySave = true;
  await submit.click();
  await expect(page.locator("#message")).toHaveText("測試儲存失敗");
  await expect(form.getByLabel("身分名稱")).toHaveValue("服事者");
  await expect(form.getByLabel("啟用", { exact: true })).toBeChecked();
  await expect(form.getByLabel("開放報名者選擇")).not.toBeChecked();
  await expect(form.getByLabel("顯示標籤")).toBeChecked();
  await expect(form.locator('[name="badge_color_hex"]')).toHaveValue("#123456");
  await expect(cancel).toBeVisible();
  rejectIdentitySave = false;
  await form.getByRole("button", { name: "儲存身分" }).click();
  await expect(page.locator("#identity-rows")).toContainText("服事者");
  const badge = page.locator("#identity-rows .child-badge").filter({ hasText: "服事者" });
  await expect(badge).toHaveCSS("background-color", "rgb(18, 52, 86)");
  await expect(badge).toHaveCSS("color", "rgb(255, 255, 255)");
  expect(writes[1].data).toMatchObject({ show_badge: true, badge_color: "#123456" });
  await expect(form.locator('[name="code"]')).toHaveValue("");
  await expect(submit).toHaveText("儲存身分");
  await expect(cancel).toBeHidden();
  await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await page.locator("#identity-rows tr").filter({ hasText: "服事者" }).getByRole("button", { name: "編輯" }).click();
  await expect(form.getByLabel("顯示標籤")).toBeChecked();
  await expect(form.locator('[name="badge_color_hex"]')).toHaveValue("#123456");
  await form.locator('[name="badge_color_hex"]').fill("red");
  expect(await form.locator('[name="badge_color_hex"]').evaluate((input) => input.validity.patternMismatch)).toBe(true);
  await form.getByRole("button", { name: "儲存身分" }).click();
  expect(writes).toHaveLength(2);
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(submit).toHaveText("儲存身分");
  await expect(cancel).toBeHidden();
  await expect(form.getByLabel("身分名稱")).toBeFocused();
  await expect(form.locator('[name="code"]')).toHaveValue("");
  await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await expect(form.locator('[name="badge_color_hex"]')).toHaveValue("#e1effe");
  await go(page, "活動");
  await expect(page.locator('[data-identity-price="child"]')).toHaveValue("80");
  await expect(page.locator('[data-identity-price="volunteer"]')).toHaveValue("0");
  await page.locator("#activity-form").getByRole("button", { name: /儲存活動/ }).click();
  await expect.poll(() => writes.find((write) => write.kind === "activity")?.data.identity_prices).toEqual([
    { identity_code: "child", fee_amount: 80 }, { identity_code: "volunteer", fee_amount: 0 },
  ]);

  // An unused identity can be deleted; 一般 can only be renamed.
  await go(page, "身分別");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#identity-rows tr").filter({ hasText: "服事者" }).getByRole("button", { name: "刪除" }).click();
  await expect(page.locator("#identity-rows")).not.toContainText("服事者");
  const general = page.locator("#identity-rows tr").filter({ hasText: "一般" });
  await expect(general.getByRole("button", { name: "刪除" })).toHaveCount(0);
  await general.getByRole("button", { name: "編輯" }).click();
  await expect(form.getByLabel("啟用", { exact: true })).toBeDisabled();
  await expect(form.getByLabel("開放報名者選擇")).toBeDisabled();
  // A renamed 一般 is named so on the activity's price row too.
  await form.getByLabel("身分名稱").fill("成人");
  await form.getByRole("button", { name: "儲存身分" }).click();
  await go(page, "活動");
  await expect(page.locator("#general-price-name")).toHaveText("成人");
  await expect(page.getByLabel("成人每人費用")).toBeVisible();

  // An edit left open at 登出 does not carry over to whoever logs in next.
  await go(page, "身分別");
  await page.locator("#identity-rows tr").filter({ hasText: "兒童（國小）" }).getByRole("button", { name: "編輯" }).click();
  await expect(cancel).toBeVisible();
  await page.getByRole("button", { name: "登出" }).click();
  // Same page, no reload: a reload would clear the form by itself.
  await page.locator('#login-form input[name="username"]').fill("tester");
  await page.locator('#login-form input[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "登入" }).click();
  await go(page, "身分別");
  await expect(form.getByLabel("身分名稱")).toHaveValue("");
  await expect(form.getByLabel("啟用", { exact: true })).toBeEnabled();
  await expect(form.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await expect(submit).toHaveText("儲存身分");
  await expect(cancel).toBeHidden();
});

test("configured badges use custom identities and hide child badges without changing counts", async ({ page }) => {
  const people = [familyRow(6, "自訂身分驗證", { meal_identity: "volunteer" }), ...family];
  const identities = [
    { code: "general", name: "一般", show_badge: false },
    { code: "child", name: "兒童（國小）", show_badge: false },
    { code: "preschool", name: "兒童（學齡前）", show_badge: false },
    { code: "volunteer", name: "服事者", show_badge: true, badge_color: "#ffcc00" },
  ].map((identity) => ({ is_active: true, public_selectable: true, ...identity }));
  await mockStaff(page, "staff", () => {}, "測試", {
    list_reference: () => ({ json: { ...familyReference, identities } }),
    list_registrations: () => ({ json: { count: people.length, registrations: people } }),
  });
  await login(page);
  const badges = page.locator("#registration-rows .child-badge");
  await expect(badges).toHaveCount(1);
  await expect(badges).toHaveText("服事者");
  await expect(badges).toHaveCSS("background-color", "rgb(255, 204, 0)");
  await expect(badges).toHaveCSS("color", "rgb(0, 0, 0)");
  await page.locator("#registration-rows tr").first().getByRole("button", { name: "查看／處理" }).click();
  await expect(page.locator("#detail-title .child-badge")).toHaveText("服事者");
  await go(page, "統計與匯出");
  await page.getByRole("button", { name: "更新統計" }).click();
  const children = page.locator("#stats-rows tr").first().locator("td").nth(3);
  await expect(children).toHaveText("3");
  await expect(children.locator(".stat-details")).toHaveCount(0);
  await expect(children).toHaveAttribute("data-csv", "3（國小 3）");
});

test("協助登記 shows the child reminders as a blue block and the survey panel only for an identity that can answer", async ({ page }) => {
  await mockStaff(page, "staff", () => {}, "測試登記", familyReplies);
  await login(page, "協助登記");
  const form = page.locator("#new-registration-form");
  const identity = form.getByRole("combobox", { name: "身分別", exact: true });
  const reminder = form.locator("div.reminder");
  await expect(reminder).toBeHidden();
  await identity.selectOption("preschool");
  await expect(reminder).toBeVisible();
  await expect(reminder).toHaveCSS("background-color", "rgb(232, 241, 251)");
  await expect(reminder).toHaveCSS("color", "rgb(29, 79, 134)");
  await identity.selectOption("student");
  await expect(reminder).toBeHidden();
  await expect(form.locator(".hosting-panel")).toBeHidden();
  await identity.selectOption("general");
  await expect(form.locator(".hosting-panel")).toBeVisible();
});
