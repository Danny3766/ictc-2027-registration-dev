const config = window.APP_CONFIG;
const loginPanel = document.querySelector("#login-panel");
const changePasswordPanel = document.querySelector("#change-password-panel");
const staffPanel = document.querySelector("#staff-panel");
const message = document.querySelector("#message");
const sessionKey = "ictc_staff_session";
let session;
try { session = JSON.parse(sessionStorage.getItem(sessionKey) || "null"); }
catch { sessionStorage.removeItem(sessionKey); session = null; }
let profile;
let reference;
let page = 0;
let count = 0;
let search = "";
// The 區 filter's district id as the select gives it; "" means every district.
let district = "";
// Empty means everyone; all_children groups both child identities; other values are identity codes.
let identityFilter = "";
let visibleRegistrations = [];
let selectedRegistration;
let editingRegistration = false;
// Must match the page size of list_registrations in the staff Edge Function.
const REGISTRATIONS_PER_PAGE = 10;
let editingStaff = null;
const adminSections = ["#admin-identities", "#admin-accounts", "#admin-settings", "#admin-hosting", "#admin-activities", "#admin-program"];

function showAdminSections(visible) {
  for (const selector of adminSections) document.querySelector(selector).hidden = !visible;
  for (const link of document.querySelectorAll("[data-admin-link]")) link.hidden = !visible;
}

// One view at a time under the navigation. Views hide by class, separate from each section's own
// `hidden`, so half-filled forms and an open record survive switching. The view is kept for this
// sign-in only (cleared at 登出), so a refresh stays put; the URL never changes.
const viewKey = "ictc_staff_view";
const navLinks = Array.from(document.querySelectorAll(".staff-nav a"));
function showView(name) {
  const allowed = (view) => navLinks.some((link) => link.hash === `#${view}` && (!link.hasAttribute("data-admin-link") || profile?.role === "admin"));
  const view = allowed(name) ? name : "section-registrations";
  for (const section of document.querySelectorAll("[data-view]")) section.classList.toggle("view-off", section.dataset.view !== view);
  for (const link of navLinks) {
    if (link.hash === `#${view}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  sessionStorage.setItem(viewKey, view);
}
for (const link of navLinks) {
  link.addEventListener("click", (event) => {
    // A click that opens a new tab or window leaves this page as it is.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showView(link.hash.slice(1));
    window.scrollTo(0, 0);
  });
}

// Labels for stored codes, so the page never shows values like "reimport_needed" or "admin".
const labels = {
  record: { active: "有效", void: "作廢", cancelled: "已取消" },
  import: { pending: "待匯入", imported: "已匯入", reimport_needed: "需重新匯入" },
  role: { admin: "管理員", staff: "服事者" },
  category: { meeting: "聚會", meal: "用餐", other: "其他" },
};
const label = (group, value) => labels[group][value] ?? value;

// registration_id is the hosting table's primary key, so the API embeds the one row as an object.
const hostingOf = (registration) => Hosting.normalize(registration.registration_hosting);
const pickupOf = (registration) => Pickup.normalize(registration.registration_pickup);
const attends = (registration, activity) =>
  registration.registration_choices.some((choice) => choice.activity_id === activity.id && choice.attending);
const priced = (activity) => activity.fee_amount != null || activity.student_fee_amount != null
  || activity.activity_identity_prices?.length > 0;
// Whose fee is unset: the identity, 未回覆身分者, or the activity when it has no price at all.
const unsetLabel = (registration, activity) => !priced(activity) ? activity.title
  : registration.meal_identity ? Meals.identityLabels[registration.meal_identity] ?? registration.meal_identity : "未回覆身分者";
// The fees of [registration, activity] attendances; unset ones are left out of the sum and named.
const feeOf = (attendances) => {
  const fees = attendances.map(([registration, activity]) => Meals.fee(activity, registration.meal_identity));
  return { ...Meals.addFees(fees), unset: attendances.filter((_, index) => fees[index] == null)
    .map(([registration, activity]) => unsetLabel(registration, activity)) };
};
// "NT$800（兒童未計入）"; "—" when nothing is set, like a missing cost.
const feeText = ({ sum, known, unset }) => !unset.length ? `NT$${sum}`
  : known ? `NT$${sum}（${[...new Set(unset)].join("、")}未計入）` : "—";
// The summary and 各區 show only the amount; 各活動 names what is left out.
const amountText = ({ sum, known, unset }) => known || !unset.length ? `NT$${sum}` : "—";
// Blank when no published meal is attended; the database retains the stored identity.
const identityText = (registration, activities) => {
  if (!Meals.needsIdentity(activities, registration.registration_choices)) return "";
  return registration.meal_identity ? Meals.identityLabels[registration.meal_identity] : "未回覆";
};

// Short Taiwan time, for example "11/4 08:30".
function shortTime(value) {
  return new Date(value).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Reference tables show codes and timestamps the way the forms describe them.
function displayValue(column, value) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value == null || value === "") return "";
  if (column === "category") return label("category", value);
  if (column === "starts_at") return shortTime(value);
  if (column === "start_time") return value.slice(0, 5);
  return value;
}

function statusCell(row, group, value) {
  const badge = document.createElement("span");
  badge.className = `status status-${value}`;
  badge.textContent = label(group, value);
  cell(row, "").append(badge);
}

// The banner text lives here, not in the HTML, so link previews (LINE) never pick it up on the real site.
if (config?.environment === "test") Object.assign(document.querySelector("#test-banner"), { textContent: "測試站｜此處為測試資料", hidden: false });

const toast = document.querySelector("#toast");
let messageTimer;
// Success notes leave after 5 seconds; errors and notes that tell the user what to do next
// (stay = true) remain until closed or replaced, so they are not missed.
function showMessage(value, error = false, stay = error) {
  clearTimeout(messageTimer);
  message.textContent = value;
  // The toast appears together with its text, which screen readers often skip; this region is always there.
  document.querySelector("#message-live").textContent = value;
  message.classList.toggle("error", error);
  toast.hidden = false;
  if (!stay) messageTimer = setTimeout(hideMessage, 5000);
}

function hideMessage() {
  clearTimeout(messageTimer);
  toast.hidden = true;
}
document.querySelector("#message-close").addEventListener("click", hideMessage);

function clearSession() {
  session = null;
  sessionStorage.removeItem(sessionKey);
  // The next person to sign in on this device starts at 登記名單.
  sessionStorage.removeItem(viewKey);
  profile = null;
  loginPanel.hidden = false;
  changePasswordPanel.hidden = true;
  staffPanel.hidden = true;
  showAdminSections(false);
  document.querySelector("#identity").textContent = "";
  for (const form of ["#create-staff-form", "#edit-staff-form", "#staff-password-form", "#change-password-form"]) {
    document.querySelector(form).reset();
  }
  document.querySelector("#staff-editor").hidden = true;
  editingStaff = null;
  document.querySelector("#new-registration-code").textContent = "";
  document.querySelector("#new-registration-code").hidden = true;
  setReordering(false);
  // The 協助登記 form keeps input across redraws, so a shared device must not hand it to the next login.
  document.querySelector("#new-registration-form").reset();
  // The list's conditions belong to this login too.
  document.querySelector("#search-form").reset();
  [page, search, district, identityFilter] = [0, "", "", ""];
  document.querySelector("#clear-search").disabled = true;
  for (const selector of ["#registration-rows", "#staff-rows"]) {
    document.querySelector(selector).replaceChildren();
  }
  document.querySelector("#stats-rows").replaceChildren();
  document.querySelector("#district-stats-rows").replaceChildren();
  document.querySelector("#district-activity-cards").replaceChildren();
  document.querySelector("#hosting-status-stats-rows").replaceChildren();
  document.querySelector("#hosting-capacity-stats-rows").replaceChildren();
  document.querySelector("#stats-summary").textContent = "";
  document.querySelector("#registration-detail").hidden = true;
  selectedRegistration = null;
  editingRegistration = false;
  visibleRegistrations = [];
}

async function authRequest(path, body) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: config.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status < 500 ? "登入失敗，請確認帳號與密碼" : "登入服務暫時無法使用，請稍後再試");
    error.status = response.status;
    throw error;
  }
  session ={ access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Date.now() + result.expires_in * 1000 };
  sessionStorage.setItem(sessionKey, JSON.stringify(session));
}

async function accessToken() {
  if (!session) throw new Error("請先登入");
  if (Date.now() >= session.expires_at - 60_000) {
    try {
      await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    } catch (error) {
      // Only a rejected refresh token ends the login; a network error or Auth 5xx keeps it for a retry.
      if (![400, 401, 403].includes(error.status)) throw new Error("暫時無法連線，請稍後再試");
      clearSession();
      throw new Error("登入已過期，請重新登入");
    }
  }
  return session.access_token;
}

async function api(action, values = {}) {
  if (!config?.supabaseUrl || !config?.publishableKey) throw new Error("網站尚未設定 Supabase 公開連線資訊");
  const response = await fetch(`${config.supabaseUrl}/functions/v1/staff`, {
    method: "POST",
    headers: { apikey: config.publishableKey, Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...values }),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) clearSession();
  if (!response.ok) {
    const error = new Error(result.error || "後台暫時無法使用");
    error.status = response.status;
    error.code = result.code;
    throw error;
  }
  return result;
}

function cell(row, value) {
  const item = document.createElement("td");
  item.textContent = String(value ?? "");
  row.append(item);
  return item;
}

// 兒童類型: the registration CSV label, "" for anyone not a child.
const childLabel = (type) => ({ preschool: "學齡前", elementary: "國小" })[type] ?? "";
function appendIdentityBadge(container, registration, suffix = "") {
  const identity = reference.identities?.find((item) => item.code === registration.meal_identity);
  if (!identity?.show_badge) return;
  const badge = document.createElement("span");
  badge.className = "child-badge";
  const color = /^#[0-9a-f]{6}$/i.test(identity.badge_color) ? identity.badge_color : "#e1effe";
  badge.style.backgroundColor = color;
  // Choose the higher-contrast text color using sRGB relative luminance.
  const channels = color.slice(1).match(/../g).map((hex) => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  badge.style.color = luminance > 0.179 ? "#000000" : "#ffffff";
  badge.textContent = identity.name + suffix;
  container.append(badge);
}
// 其中兒童: the total on top, a badge per child type with anyone in it below; the CSV gets "3（國小 3）".
function childrenCell(row, people) {
  const counts = [["preschool", "學齡前"], ["elementary", "國小"]]
    .map(([type, label]) => ({ type, label, count: people.filter((person) => person.child_type === type).length }));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  const item = cell(row, total);
  const nonzero = counts.filter((entry) => entry.count);
  item.dataset.csv = total + (nonzero.length ? `（${nonzero.map((entry) => `${entry.label} ${entry.count}`).join("、")}）` : "");
  if (nonzero.length) {
    const details = document.createElement("div"); details.className = "stat-details";
    for (const entry of nonzero) {
      appendIdentityBadge(details, { meal_identity: entry.type === "preschool" ? "preschool" : "child" }, ` ${entry.count}`);
    }
    if (details.children.length) item.append(details);
  }
}
// 各活動 fee: the amount on top, feeText's "（…未計入）" note below on grey; the CSV keeps the whole text.
function amountCell(row, value) {
  const text = typeof value === "string" ? value : feeText(value);
  const split = text.indexOf("（");
  const item = cell(row, split < 0 ? text : text.slice(0, split));
  item.dataset.csv = text;
  if (split >= 0) {
    const note = document.createElement("div"); note.className = "stat-details amount-note";
    note.textContent = text.slice(split); item.append(note);
  }
}

function taipeiInput(value) {
  return value ? new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16) : "";
}

function taipeiTimestamp(value) {
  return value ? `${value}:00+08:00` : null;
}

function activityDateTimeFields(value, hasTime) {
  const local = taipeiInput(value);
  return {
    date: local.slice(0, 10),
    time: local && hasTime !== false ? local.slice(11, 16) : "",
  };
}

function activityTimestamp(date, time) {
  return date ? `${date}T${time || "00:00"}:00+08:00` : null;
}

function activityTimeDisplay(value, hasTime) {
  if (!value) return "";
  if (hasTime !== false) return shortTime(value);
  const local = taipeiInput(value);
  const [, month, day] = local.slice(0, 10).split("-").map(Number);
  return `${month}/${day}`;
}

function activitySortOrder(form, value) {
  if (value !== "") return value;
  const edited = reference.activities.find((item) => String(item.id) === form.dataset.editingId);
  if (edited) return edited.sort_order;
  const existing = reference.activities.map((item) => Number(item.sort_order)).filter(Number.isFinite);
  return Math.max(0, ...existing) + 1;
}

// An activity as an audience; an unpublished one is flagged because nobody can sign up for it.
const prerequisiteLabel = (activity) => `${activity.title}${activity.is_published ? "" : "（未公開）"}`;

function audienceText(item) {
  if (!item.audience || item.audience === "all") return "";
  if (item.audience.startsWith("activity:")) {
    const target = reference.activities.find((activity) => `activity:${activity.id}` === item.audience);
    return target ? `參加「${prerequisiteLabel(target)}」的人` : "參加已刪除活動的人";
  }
  const options = document.querySelector('#activity-form [name="audience"]').options;
  return Array.from(options).find((option) => option.value === item.audience)?.textContent ?? item.audience;
}

function mapLinkValue(value) {
  const url = Meals.mapUrl(value);
  if (!url) return `${value}（格式不正確，公開頁不會顯示）`;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = value;
  return link;
}

// The title expands to the rest of what the edit form holds, so reading an activity needs no 編輯.
function activityDetails(item, open) {
  const lines = [
    ["時間", Meals.activityTime(item)],
    ["地點", item.venue], ["地址", item.address], ["地圖連結", item.map_url && mapLinkValue(item.map_url)],
    ["費用", Meals.priceText(item)],
    ["實際成本", item.cost_amount == null ? "" : `NT$${item.cost_amount}／人`],
    ["報名對象", audienceText(item)], ["限定對象提示", item.audience_note], ["說明", item.description],
  ].filter(([, value]) => value);
  const details = document.createElement("details");
  details.className = "activity-details";
  details.open = open;
  details.inert = activitySection.classList.contains("reordering");
  const summary = document.createElement("summary");
  summary.textContent = item.title;
  const list = document.createElement("dl");
  for (const [name, value] of lines.length ? lines : [["內容", "尚未填寫其他資料"]]) {
    const term = document.createElement("dt");
    term.textContent = name;
    const description = document.createElement("dd");
    description.append(value);
    list.append(term, description);
  }
  details.append(summary, list);
  return details;
}

function editButton(row, callback) {
  const action = cell(row, "");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "編輯";
  button.addEventListener("click", callback);
  action.append(button);
}

function fillForm(form, values, scroll = true) {
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (!field) continue;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value ?? "";
  }
  if (scroll) form.scrollIntoView({ behavior: "smooth", block: "center" });
}

// The edited row's id lives only here, so abandoning an edit (取消編輯) can never update that row.
function setEditing(form, item) {
  const submit = form.querySelector('button[type="submit"]');
  submit.dataset.label ??= submit.textContent;
  if (item) {
    form.dataset.editingId = item.id;
    submit.textContent = `${submit.dataset.label}（編輯：${item.title}）`;
  } else {
    delete form.dataset.editingId;
    submit.textContent = submit.dataset.label;
  }
}

function setAudienceOptions(editingId = null) {
  const select = document.querySelector('#activity-form [name="audience"]');
  const selected = select.value;
  select.querySelectorAll('option[value^="activity:"]').forEach((option) => option.remove());
  for (const activity of reference.activities) {
    if (String(activity.id) === String(editingId)) continue;
    const option = document.createElement("option");
    option.value = `activity:${activity.id}`;
    option.textContent = prerequisiteLabel(activity);
    select.append(option);
  }
  select.value = selected;
}

// `only` redraws one table, so redrawing activities keeps unsaved input in the other forms.
// A full redraw leaves the activity table alone while reordering, so the unsaved drag order stays.
function renderReferenceRows(only) {
  for (const [table, items, columns, form, transform] of [
    ["#activity-rows", reference.activities, ["title", "category", "starts_at", "is_published"], "#activity-form",
      (item) => {
        const start = activityDateTimeFields(item.starts_at, item.starts_at_has_time);
        const end = activityDateTimeFields(item.ends_at, item.ends_at_has_time);
        return { ...item, starts_on: start.date, starts_time: start.time, ends_on: end.date, ends_time: end.time };
      }],
    ["#program-rows", reference.program, ["event_date", "start_time", "title", "is_visible"], "#program-form",
      (item) => ({ ...item, start_time: item.start_time?.slice(0, 5), end_time: item.end_time?.slice(0, 5) })],
  ]) {
    if (only ? table !== only : table === "#activity-rows" && activitySection.classList.contains("reordering")) continue;
    const rows = document.querySelector(table);
    // A redraw after a save or reorder keeps the activities the user had expanded.
    const opened = new Set(Array.from(rows.querySelectorAll("details[open]"), (details) => details.closest("tr").dataset.id));
    rows.replaceChildren();
    for (const item of items) {
      const row = document.createElement("tr");
      for (const column of columns) {
        if (table === "#activity-rows" && column === "title") {
          cell(row, "").append(activityDetails(item, opened.has(String(item.id))));
          continue;
        }
        const value = table === "#activity-rows" && column === "starts_at"
          ? activityTimeDisplay(item.starts_at, item.starts_at_has_time)
          : displayValue(column, item[column]);
        cell(row, value);
      }
      editButton(row, () => {
        if (table === "#activity-rows") {
          setAudienceOptions(item.id);
          renderIdentityPrices(item);
        }
        fillForm(document.querySelector(form), transform(item));
        setEditing(document.querySelector(form), item);
      });
      if (table === "#activity-rows") {
        row.dataset.id = item.id;
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "drag-handle";
        handle.textContent = "☰";
        handle.setAttribute("aria-label", `拖曳排序：${item.title}`);
        // Outside reordering the column shows each activity's place in the order instead of ☰.
        const number = document.createElement("span");
        number.className = "sort-number";
        number.textContent = rows.children.length + 1;
        const handleCell = cell(row, "");
        handleCell.className = "reorder-col";
        handleCell.append(number, handle);
      }
      rows.append(row);
    }
  }
}

function renderReference() {
  fillForm(document.querySelector("#settings-form"), {
    ...reference.settings,
    registration_deadline_at: taipeiInput(reference.settings.registration_deadline_at),
  }, false);
  fillForm(document.querySelector("#hosting-settings-form"), reference.settings, false);
  setAudienceOptions(document.querySelector("#activity-form").dataset.editingId);
  renderIdentities();
  renderIdentityPrices();
  renderReferenceRows();
  renderNewRegistrationForm();
}

async function saveReference(event, kind) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.editingId) data.id = form.dataset.editingId;
  for (const name of ["is_registration_open", "is_lookup_open", "is_hosting_open", "is_pickup_open", "is_published", "is_visible"]) {
    if (form.elements.namedItem(name)) data[name] = form.elements.namedItem(name).checked;
  }
  if (kind === "settings") data.registration_deadline_at = taipeiTimestamp(data.registration_deadline_at);
  if (kind === "activity") {
    if ((data.starts_time && !data.starts_on) || (data.ends_time && !data.ends_on)) {
      return showMessage("設定活動時間前，請先選擇對應日期。", true);
    }
    data.starts_at = activityTimestamp(data.starts_on, data.starts_time);
    data.starts_at_has_time = Boolean(data.starts_time);
    data.ends_at = activityTimestamp(data.ends_on, data.ends_time);
    data.ends_at_has_time = Boolean(data.ends_time);
    data.sort_order = activitySortOrder(form, data.sort_order);
    for (const name of ["starts_on", "starts_time", "ends_on", "ends_time"]) delete data[name];
    data.identity_prices = identityPricesFrom(form);
    // Older readers still use student_fee_amount.
    data.student_fee_amount = data.identity_prices.find((price) => price.identity_code === "student")?.fee_amount ?? "";
  }
  // An activity save would change the list being reordered; other saves leave the drag order alone.
  if (kind === "activity" && activitySection.classList.contains("reordering")) {
    return showMessage("請先完成或取消活動排序，再儲存活動。", true);
  }
  if (kind === "settings" && data.is_registration_open && !reference.settings.is_registration_open
    && !confirm("確定開放登記？請先完成正式環境驗收與核准。")) return;
  if (kind === "hosting" && data.is_hosting_open && !reference.settings.is_hosting_open
    && !confirm("確定開放開家接待調查？公開登記頁與查詢頁將顯示接待區塊。")) return;
  if (kind === "hosting" && data.is_pickup_open && !reference.settings.is_pickup_open
    && !confirm("確定開放接機接待調查？公開登記頁與查詢頁將顯示接機問題。")) return;
  const edited = kind === "activity" && reference.activities.find((item) => String(item.id) === form.dataset.editingId);
  if (edited && data.audience !== "all" && data.audience !== edited.audience) {
    // People who signed up before the restriction keep their answer until their next save.
    let outside;
    try {
      outside = activeRegistrations(await allRegistrations()).filter((registration) => attends(registration, edited)
        && !Meals.eligible(data, { skipsHosting: !Meals.answersHosting(registration.meal_identity ?? "general"), hostingStatus: hostingOf(registration)?.status,
          pickupStatus: pickupOf(registration)?.status, choices: registration.registration_choices,
          activities: reference.activities })).length;
    } catch (error) { return showMessage(error.message, true); }
    if (outside && !confirm(`目前有 ${outside} 位不符對象的人已報名此活動，他們的報名會保留。確定改為限定對象？`)) return;
  }
  try {
    await api("save_reference", { kind, data });
    reference = await api("list_reference");
    Meals.configure(reference.identities, true);
    renderReference();
    if (!["settings", "hosting"].includes(kind)) form.reset();
    showMessage("設定已儲存。");
  } catch (error) { showMessage(error.message, true); }
}

async function loadRegistrations() {
  const result = await api("list_registrations", { page, search, ...(district && { district_id: Number(district) }),
    ...(identityFilter === "all_children" ? { children_only: true } : identityFilter ? { meal_identity: identityFilter } : {}) });
  count = result.count ?? 0;
  document.querySelector("#registration-count").textContent = `共 ${count} 筆`;
  document.querySelector("#page-number").textContent = `第 ${page + 1} 頁`;
  document.querySelector("#previous-page").disabled = page === 0;
  document.querySelector("#next-page").disabled = (page + 1) * REGISTRATIONS_PER_PAGE >= count;
  const rows = document.querySelector("#registration-rows");
  rows.replaceChildren();
  visibleRegistrations = result.registrations;
  const districtNames = new Map(reference.districts.map((district) => [district.id, district.name]));
  for (const registration of result.registrations) {
    const row = document.createElement("tr");
    cell(row, registration.serial_no);
    const nameCell = cell(row, registration.full_name);
    appendIdentityBadge(nameCell, registration);
    cell(row, districtNames.get(registration.district_id));
    statusCell(row, "record", registration.record_status);
    statusCell(row, "import", registration.import_status);
    cell(row, shortTime(registration.updated_at));
    // Same-district active family matches are named directly in the list.
    const family = cell(row, registration.is_child ? `家長：${registration.parent_name}` : "");
    if (registration.children?.length) {
      family.textContent = `兒童：${registration.children.map((child) => child.full_name).join("、")}`;
    }
    const actions = cell(row, "");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "查看／處理";
    edit.addEventListener("click", () => openRegistration(registration));
    actions.append(edit);
    rows.append(row);
  }
}

async function allRegistrations() {
  const records = [];
  let beforeSerial = Number.MAX_SAFE_INTEGER;
  while (true) {
    const { registrations } = await api("list_registrations", { page: 0, search: "", before_serial: beforeSerial });
    records.push(...registrations);
    if (registrations.length < 500) return records;
    beforeSerial = registrations.at(-1).serial_no;
  }
}

function activeRegistrations(registrations) {
  return registrations.filter((item) => item.record_status === "active");
}

function currentActivities() {
  return reference.activities.filter((item) => item.is_published);
}

// Returns [參加, 不參加, 未回覆] counts for one activity.
function countAnswers(registrations, activity) {
  const counts = [0, 0, 0];
  for (const registration of registrations) {
    const choice = registration.registration_choices.find((item) => item.activity_id === activity.id);
    counts[!choice ? 2 : choice.attending ? 0 : 1] += 1;
  }
  return counts;
}

async function showStatistics() {
  const registrations = activeRegistrations(await allRegistrations());
  const activities = currentActivities();
  const rows = document.querySelector("#stats-rows");
  rows.replaceChildren();
  const total = { attendances: [], cost: 0, subsidy: { sum: 0, known: 0, unset: [] } };
  const outside = [];
  for (const activity of activities) {
    const [attending, notAttending, unanswered] = countAnswers(registrations, activity);
    const attendees = registrations.filter((registration) => attends(registration, activity));
    const attendances = attendees.map((registration) => [registration, activity]);
    const fee = feeOf(attendances);
    total.attendances.push(...attendances);
    // The subsidy is what the real cost exceeds the estimated fees by, over the people whose fee is set;
    // without a cost there is none to show.
    const cost = activity.cost_amount == null ? null : attending * activity.cost_amount;
    const subsidy = cost === null ? null : { ...fee, sum: fee.known * activity.cost_amount - fee.sum };
    if (cost !== null) {
      total.cost += cost;
      total.subsidy.sum += subsidy.sum;
      total.subsidy.known += subsidy.known;
      total.subsidy.unset.push(...subsidy.unset);
    }
    const restricted = attendees.filter((registration) => !Meals.eligible(activity, {
      skipsHosting: !Meals.answersHosting(registration.meal_identity ?? "general"), hostingStatus: hostingOf(registration)?.status, pickupStatus: pickupOf(registration)?.status,
      choices: registration.registration_choices, activities: reference.activities,
    })).length;
    if (restricted) outside.push(`${activity.title} ${restricted} 人`);
    const students = Meals.hasStudentPrice(activity)
      ? attendees.filter((registration) => registration.meal_identity === "student").length : "—";
    const row = document.createElement("tr");
    for (const value of [activity.title, attending, students]) cell(row, value);
    childrenCell(row, attendees);
    for (const value of [notAttending, unanswered]) cell(row, value);
    amountCell(row, fee);
    cell(row, cost === null ? "—" : `NT$${cost}`);
    amountCell(row, cost === null ? "—" : subsidy);
    rows.append(row);
  }
  const noIdentity = registrations.filter((registration) => identityText(registration, activities) === "未回覆").length;
  // Cost and subsidy cover only the activities with a cost set. A charged activity still without one is
  // named, so the totals are not read as complete; free activities such as meetings need no cost.
  const uncosted = activities.filter((activity) => priced(activity) && activity.cost_amount == null);
  const costText = activities.every((activity) => activity.cost_amount == null)
    ? "預估成本 —；預估補貼 —（尚未設定實際成本）"
    : `預估成本 NT$${total.cost}；預估補貼 ${amountText(total.subsidy)}`
      + (uncosted.length ? `；${uncosted.map((activity) => activity.title).join("、")}尚未設定實際成本，未計入` : "");
  document.querySelector("#stats-summary").textContent = [
    `有效登記 ${registrations.length} 筆；預估費用 ${amountText(feeOf(total.attendances))}；${costText}。`,
    noIdentity ? `用餐身分未回覆 ${noIdentity} 人。` : "",
    outside.length ? `不符報名對象（限定前已報名）：${outside.join("、")}。` : "",
  ].join("");
  const districtRows = document.querySelector("#district-stats-rows");
  districtRows.replaceChildren();
  const districtTotal = { people: [], attendances: [] };
  // A 全會所 card, then one per district; no 合計 row, since adding activities would count a person twice.
  const districtCards = [districtActivityCard({ name: "全會所" }, registrations, activities)];
  for (const district of reference.districts) {
    const people = registrations.filter((item) => item.district_id === district.id);
    const attendances = people.flatMap((person) => activities.filter((activity) => attends(person, activity))
      .map((activity) => [person, activity]));
    districtTotal.people.push(...people);
    districtTotal.attendances.push(...attendances);
    const row = document.createElement("tr");
    cell(row, district.name); cell(row, people.length); childrenCell(row, people); cell(row, amountText(feeOf(attendances)));
    districtRows.append(row);
    districtCards.push(districtActivityCard(district, people, activities));
  }
  const districtSum = document.createElement("tr"); districtSum.className = "total";
  cell(districtSum, "合計"); cell(districtSum, districtTotal.people.length); childrenCell(districtSum, districtTotal.people);
  cell(districtSum, amountText(feeOf(districtTotal.attendances))); districtRows.append(districtSum);
  document.querySelector("#district-activity-cards").replaceChildren(...districtCards);
  showHostingStatistics(registrations);
}

function totalRow(rows, values) {
  const row = document.createElement("tr");
  row.className = "total";
  for (const value of ["合計", ...values]) cell(row, value);
  rows.append(row);
}

function districtActivityCard(district, people, activities) {
  const card = document.createElement("section");
  card.className = "mini-card";
  const title = document.createElement("h3");
  const count = document.createElement("small");
  count.className = "field-hint";
  count.textContent = `有效登記 ${people.length} 人`;
  title.append(district.name, " ", count);
  const table = document.createElement("table");
  table.className = "numeric";
  table.innerHTML = "<thead><tr><th>活動</th><th>參加</th><th>不參加</th><th>未回覆</th></tr></thead><tbody></tbody>";
  for (const activity of activities) {
    const row = document.createElement("tr");
    for (const value of [activity.title, ...countAnswers(people, activity)]) cell(row, value);
    table.tBodies[0].append(row);
  }
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  scroll.append(table);
  card.append(title, scroll);
  return card;
}

function showHostingStatistics(registrations) {
  const answers = { hosting: 0, not_hosting: 0, family_registered: 0, unanswered: 0 };
  const capacity = Object.fromEntries(Object.keys(Hosting.guestLabels).map((type) => [type, { registrations: 0, people: 0 }]));
  const pickup = { yes: 0, no: 0, unanswered: 0, people: 0 };
  for (const registration of registrations) {
    const answer = hostingOf(registration);
    answers[answer?.status ?? "unanswered"] += 1;
    const pickupAnswer = pickupOf(registration);
    pickup[pickupAnswer?.status ?? "unanswered"] += 1;
    pickup.people += pickupAnswer?.count ?? 0;
    if (answer?.status !== "hosting") continue;
    capacity[answer.guest_type].registrations += 1;
    capacity[answer.guest_type].people += answer.guest_count;
  }
  const statusRows = document.querySelector("#hosting-status-stats-rows");
  statusRows.replaceChildren();
  for (const [status, total] of Object.entries(answers)) {
    if (status === "family_registered") continue;
    const row = document.createElement("tr");
    for (const value of [Hosting.statusLabels[status] ?? "未回覆", total]) cell(row, value);
    statusRows.append(row);
  }
  totalRow(statusRows, [registrations.length]);
  const capacityRows = document.querySelector("#hosting-capacity-stats-rows");
  capacityRows.replaceChildren();
  for (const [type, total] of Object.entries(capacity)) {
    const row = document.createElement("tr");
    for (const value of [Hosting.guestLabels[type], total.registrations, total.people]) cell(row, value);
    capacityRows.append(row);
  }
  totalRow(capacityRows, [answers.hosting, Object.values(capacity).reduce((sum, item) => sum + item.people, 0)]);
  const pickupRows = document.querySelector("#hosting-pickup-stats-rows");
  pickupRows.replaceChildren();
  for (const [status, count] of [["是", pickup.yes], ["否", pickup.no], ["未回覆", pickup.unanswered]]) {
    const row = document.createElement("tr");
    for (const value of [status, count, status === "是" ? pickup.people : 0]) cell(row, value);
    pickupRows.append(row);
  }
  totalRow(pickupRows, [registrations.length, pickup.people]);
}

function csvCell(value) {
  let text = String(value ?? "").replaceAll(/[\r\n\t]/g, " ");
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function saveCsv(rows, filename) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function appendStatisticsTable(rows, title, table, note = "") {
  rows.push([title]);
  for (const row of table.rows) rows.push([...row.cells].map((item) => item.dataset.csv ?? item.textContent));
  if (note) rows.push([note]);
  rows.push([]);
}

async function downloadStatisticsCsv() {
  await showStatistics();
  const rows = [["統計摘要"], [document.querySelector("#stats-summary").textContent], []];
  for (const [title, selector, noteSelector] of [
    ["各活動", "#stats-rows"], ["各區", "#district-stats-rows"],
    ["開家接待回覆", "#hosting-status-stats-rows", "#hosting-status-note"], ["接待對象", "#hosting-capacity-stats-rows"],
    ["接機", "#hosting-pickup-stats-rows"],
  ]) {
    const note = noteSelector ? document.querySelector(noteSelector).textContent : "";
    appendStatisticsTable(rows, title, document.querySelector(selector).closest("table"), note);
  }
  rows.push(["各區各活動"], []);
  for (const card of document.querySelectorAll("#district-activity-cards .mini-card")) {
    appendStatisticsTable(rows, card.querySelector("h3").textContent, card.querySelector("table"));
  }
  saveCsv(rows, "registration-statistics.csv");
}

// What this person pays for the attended activities, by their identity. The CSV keeps it a number, the
// set fees' sum, and names the activities left out in the next column.
const personFee = (registration, activities) => {
  const attended = activities.filter((activity) => attends(registration, activity));
  const fees = attended.map((activity) => Meals.fee(activity, registration.meal_identity));
  const { sum, known } = Meals.addFees(fees);
  const unsetTitles = attended.filter((_, index) => fees[index] == null).map((activity) => activity.title);
  return [known || !unsetTitles.length ? sum : "未設定", unsetTitles.join("、")];
};

async function downloadCsv() {
  const activities = currentActivities();
  const districts = new Map(reference.districts.map((item) => [item.id, item.name]));
  const rows = [["流水號", "姓名", "區", "兒童", "家長姓名", "匯入狀態", ...activities.map((item) => item.title),
    "開家接待", "接待對象", "可接待人數", "是否可以接機", "可接機人數", "用餐身分", "預估應付餐費", "餐費未計入的活動"]];
  for (const registration of activeRegistrations(await allRegistrations())) {
    const choices = new Map(registration.registration_choices.map((item) => [item.activity_id, item.attending]));
    const hosting = hostingOf(registration);
    const pickup = pickupOf(registration);
    rows.push([
      registration.serial_no, registration.full_name, districts.get(registration.district_id),
      childLabel(registration.child_type), registration.parent_name ?? "",
      label("import", registration.import_status),
      ...activities.map((item) => !choices.has(item.id) ? "未回覆" : choices.get(item.id) ? "參加" : "不參加"),
      hosting ? Hosting.statusLabels[hosting.status] : "未回覆",
      hosting?.guest_type ? Hosting.guestLabels[hosting.guest_type] : "",
      hosting?.guest_count ?? "", pickup ? Pickup.labels[pickup.status] : "", pickup?.count ?? "",
      identityText(registration, activities), ...personFee(registration, activities),
    ]);
  }
  saveCsv(rows, "registration-export.csv");
}

// A new registration answers every activity. An edit only has to keep existing answers:
// an activity the person never answered stays 未回覆 until they choose (requireAll = false).
function renderChoiceFields(container, choices = new Map(), requireAll = true) {
  container.replaceChildren();
  for (const activity of currentActivities()) {
    const item = document.createElement("div");
    item.className = "staff-choice";
    item.dataset.activity = activity.id;
    const title = document.createElement("strong");
    title.textContent = activity.title;
    item.append(title);
    if (!requireAll && !choices.has(activity.id)) {
      const unanswered = document.createElement("span");
      unanswered.className = "hint";
      unanswered.textContent = "（未回覆，可留空）";
      item.append(unanswered);
    }
    for (const [value, label] of [["true", "參加"], ["false", "不參加"]]) {
      const option = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `activity_${activity.id}`;
      radio.value = value;
      radio.required = requireAll || choices.has(activity.id);
      radio.checked = choices.get(activity.id) === (value === "true");
      option.append(radio, label);
      item.append(option);
    }
    container.append(item);
  }
  Meals.render(container, currentActivities());
}

// Same rules as the public form: only 一般 is asked the surveys (anyone else gets 否 for both), and a
// 兒童 needs the parent's name at the bottom. editable is false while a record is only being viewed.
function syncChildFields(form, editable = true) {
  const child = Boolean(Meals.childType(form.elements.meal_identity.value));
  form.querySelector(".preschool-hint").hidden = form.elements.meal_identity.value !== "preschool";
  form.querySelector(".child-hint").hidden = !(child && editable);
  form.querySelector(".parent-name").hidden = !child;
  form.elements.parent_name.disabled = !child || !editable;
  const panel = form.querySelector(".hosting-panel");
  const skip = !Meals.answersHosting(form.elements.meal_identity.value);
  panel.hidden = skip;
  panel.disabled = skip || !editable;
}
// The parent's name to send: trimmed for a child, nothing otherwise; throws when a child has none.
function parentNameFrom(form) {
  if (!Meals.childType(form.elements.meal_identity.value)) return null;
  const name = form.elements.parent_name.value.trim();
  if (!name) throw new Error("請填寫家長姓名");
  return name;
}

// Staff follow the same audience and identity rules as the public form.
const checkedStatus = (selector) => document.querySelector(`${selector} [name="hosting_status"]:checked`)?.value ?? null;
const childTypeOf = (selector) => Meals.childType(document.querySelector(selector).elements.meal_identity.value);
function syncNewMeals() {
  const childType = childTypeOf("#new-registration-form");
  Meals.sync(document.querySelector("#new-registration-choices"), currentActivities(), {
    skipsHosting: !Meals.answersHosting(document.querySelector("#new-registration-form").elements.meal_identity.value), childType,
    hostingStatus: checkedStatus("#new-registration-hosting"),
    pickupStatus: Pickup.read(document.querySelector("#new-registration-pickup"))?.status,
  });
}
function syncDetailMeals() {
  // Only while editing: sync would re-enable allowed choices and show what saving would change.
  if (!editingRegistration) return;
  const childType = childTypeOf("#edit-registration-form");
  Meals.sync(document.querySelector("#detail-choices"), currentActivities(), {
    skipsHosting: !Meals.answersHosting(document.querySelector("#edit-registration-form").elements.meal_identity.value), childType,
    hostingStatus: checkedStatus("#detail-hosting"),
    pickupStatus: Pickup.read(document.querySelector("#detail-pickup"))?.status,
  });
}

// Redrawn whenever districts or activities change, so it keeps what staff already entered.
function renderNewRegistrationForm() {
  const filter = document.querySelector("#search-form").elements.district_id;
  const filtered = filter.value;
  filter.replaceChildren(new Option("全部區", ""));
  for (const item of reference.districts) filter.add(new Option(item.name, item.id));
  filter.value = filtered;
  Meals.renderIdentityFilter(document.querySelector("#search-form").elements.identity_filter, reference.used_identity_codes ?? []);
  const form = document.querySelector("#new-registration-form");
  const entered = new FormData(form);
  Meals.renderIdentity(form.elements.meal_identity);
  const districts = form.elements.district_id;
  districts.replaceChildren(new Option("請選擇", ""));
  for (const district of reference.districts) {
    districts.add(new Option(district.name, district.id));
  }
  districts.value = entered.get("district_id") ?? "";
  const choices = new Map(choicesFromForm(form).map((item) => [item.activity_id, item.attending]));
  renderChoiceFields(document.querySelector("#new-registration-choices"), choices, true);
  const hosting = document.querySelector("#new-registration-hosting");
  // Required only while the public survey is open, matching the public form.
  Hosting.render(hosting, Hosting.read(hosting), Boolean(reference.settings.is_hosting_open));
  const pickup = document.querySelector("#new-registration-pickup");
  Pickup.render(pickup, Pickup.read(pickup), Boolean(reference.settings.is_pickup_open));
  syncChildFields(form);
  syncNewMeals();
}

// Read from the radios, not FormData, which leaves out the locked (disabled) restricted choices.
function choicesFromForm(form) {
  return Meals.choices(form, currentActivities());
}

// Opens in view mode, every field locked, so looking at a record cannot change it by a stray tap;
// 修改登記資料 reopens it with editing = true. Reopening from the stored record also undoes any edit.
function renderDetailTitle(registration) {
  const title = document.querySelector("#detail-title");
  title.textContent = `登記 #${registration.serial_no}｜${registration.full_name}`;
  appendIdentityBadge(title, registration);
}

function openRegistration(registration, editing = false) {
  const switching = selectedRegistration?.id !== registration.id;
  selectedRegistration = registration;
  editingRegistration = editing && registration.record_status === "active";
  const detail = document.querySelector("#registration-detail");
  detail.hidden = false;
  renderDetailTitle(registration);
  const form = document.querySelector("#edit-registration-form");
  form.elements.full_name.value = registration.full_name;
  Meals.renderIdentity(form.elements.meal_identity, registration.meal_identity ?? "general");
  form.elements.parent_name.value = registration.parent_name ?? "";
  const districts = form.elements.district_id;
  districts.replaceChildren();
  for (const district of reference.districts) {
    const option = document.createElement("option");
    option.value = district.id;
    option.textContent = district.name;
    option.selected = district.id === registration.district_id;
    districts.append(option);
  }
  const choices = new Map(registration.registration_choices.map((choice) => [choice.activity_id, choice.attending]));
  renderChoiceFields(document.querySelector("#detail-choices"), choices, false);
  document.querySelector("#import-form").elements.status.value = registration.import_status;
  // Only active rows can be edited; a historical cancelled row can still be voided.
  const isActive = registration.record_status === "active";
  form.querySelectorAll("input, select, button").forEach((control) => control.disabled = !editingRegistration);
  document.querySelector("#start-registration-edit").hidden = !isActive || editingRegistration;
  document.querySelector("#registration-edit-buttons").hidden = !editingRegistration;
  // Rendered after the loop above, which would otherwise re-enable the hidden hosting fields.
  // Like an activity, an existing answer cannot go back to 未回覆, but an unanswered one may stay so.
  const hosting = hostingOf(registration);
  const hostingFields = document.querySelector("#detail-hosting");
  Hosting.render(hostingFields, hosting, hosting !== null);
  Pickup.render(document.querySelector("#detail-pickup"), pickupOf(registration), pickupOf(registration) !== null);
  // The fieldset disables every hosting control, whatever its tag; sync() cannot re-enable them.
  // For a child it is hidden and disabled, as the surveys are not asked.
  syncChildFields(form, editingRegistration);
  // Rendered after the loop above, which disables every button in view mode.
  showParentChildren(registration);
  syncDetailMeals();
  const voidForm = document.querySelector("#void-form");
  voidForm.reset();
  voidForm.querySelectorAll("input, button").forEach((control) => control.disabled = registration.record_status === "void");
  if (switching) detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

// A parent's record lists the children naming them. While viewing, a name opens that child's record;
// while editing it is plain text, so a click cannot drop unsaved changes.
function showParentChildren(registration) {
  const block = document.querySelector("#detail-children");
  const children = registration.children ?? [];
  block.hidden = !children.length;
  block.querySelector("ul").replaceChildren(...children.map((child) => {
    const item = document.createElement("li");
    const label = `#${child.serial_no} ${child.full_name}`;
    if (editingRegistration) item.textContent = label;
    else {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "link-button";
      open.textContent = label;
      open.addEventListener("click", () => openChildRegistration(child.serial_no));
      item.append(open);
    }
    return item;
  }));
}

// The list switches to a search for the child's serial number, so the record stays open after a save;
// 清除條件 brings the full list back.
async function openChildRegistration(serial) {
  if (!await showRegistrations(0, String(serial), "", "")) return;
  searchForm.elements.search.value = String(serial);
  searchForm.elements.district_id.value = "";
  searchForm.elements.identity_filter.value = "";
  updateClearSearch();
  const child = visibleRegistrations.find((item) => item.serial_no === serial);
  if (child) openRegistration(child);
  else showMessage("找不到這位兒童的有效登記，請重新整理名單。", true);
}

async function refreshRegistration() {
  await loadRegistrations();
  const updated = visibleRegistrations.find((item) => item.id === selectedRegistration?.id);
  if (updated) openRegistration(updated);
  else document.querySelector("#registration-detail").hidden = true;
}

async function loadStaff() {
  const { staff } = await api("list_staff");
  const rows = document.querySelector("#staff-rows");
  rows.replaceChildren();
  for (const person of staff) {
    const row = document.createElement("tr");
    cell(row, person.username);
    cell(row, person.display_name);
    cell(row, label("role", person.role));
    cell(row, person.is_active ? "啟用" : "停用");
    cell(row, person.must_change_password ? "待更改" : "—");
    const actions = cell(row, "");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "修改";
    edit.addEventListener("click", () => openStaffEditor(person));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = person.is_active ? "停用" : "啟用";
    toggle.addEventListener("click", () => toggleStaff(person));
    actions.append(edit, toggle);
    rows.append(row);
  }
}

// One editor for the account picked in the list: rename it, or set its password (not one's own).
function openStaffEditor(person) {
  editingStaff = person;
  const editor = document.querySelector("#staff-editor");
  editor.hidden = false;
  document.querySelector("#staff-editor-title").textContent = `修改帳號：${person.username}`;
  fillForm(document.querySelector("#edit-staff-form"), { username: person.username, display_name: person.display_name }, false);
  const passwordForm = document.querySelector("#staff-password-form");
  passwordForm.reset();
  const self = person.auth_user_id === profile.auth_user_id;
  passwordForm.hidden = self;
  document.querySelector("#staff-password-self").hidden = !self;
  editor.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function toggleStaff(person) {
  if (!confirm(`確定要${person.is_active ? "停用" : "啟用"} ${person.username}？`)) return;
  try {
    await api("set_staff_active", { user_id: person.auth_user_id, is_active: !person.is_active });
    await loadStaff();
    showMessage("帳號已更新。");
  } catch (error) { showMessage(error.message, true); }
}

async function openStaff() {
  const result = await api("me");
  profile = result.profile;
  loginPanel.hidden = true;
  showChangePassword(profile.must_change_password);
  staffPanel.hidden = profile.must_change_password;
  document.querySelector("#identity").textContent = `${profile.display_name}｜${label("role", profile.role)}`;
  if (profile.must_change_password) return;
  const isAdmin = profile.role === "admin";
  showView(sessionStorage.getItem(viewKey));
  showAdminSections(false);
  try {
    reference = await api("list_reference");
    Meals.configure(reference.identities, true);
    // renderReference also builds the new-registration form, so it runs once either way.
    if (isAdmin) renderReference();
    else renderNewRegistrationForm();
    await Promise.all([loadRegistrations(), ...(isAdmin ? [loadStaff()] : [])]);
  } catch (error) {
    // Admin views stay hidden when loading fails; a kept admin view would leave the page blank.
    showView("section-registrations");
    throw error;
  }
  showAdminSections(isAdmin);
}

// 用餐身分: one price field per identity but 一般 (fee_amount); blank means unset, not the general price.
function renderIdentityPrices(activity = {}) {
  const container = document.querySelector("#identity-prices");
  container.replaceChildren();
  for (const identity of reference.identities ?? []) {
    if (identity.code === "general") {
      // 一般 can be renamed; its price field is fee_amount, already in the page.
      document.querySelector("#general-price-name").textContent = identity.name;
      document.querySelector('#activity-form [name="fee_amount"]').setAttribute("aria-label", `${identity.name}每人費用`);
      continue;
    }
    const label = document.createElement("label");
    label.className = "activity-price-row";
    const name = document.createElement("span");
    name.textContent = `${identity.name}${identity.is_active ? "" : "（已停用）"}`;
    const input = document.createElement("input");
    Object.assign(input, { type: "number", min: "0", step: "1", max: "2147483647", placeholder: "未設定" });
    input.dataset.identityPrice = identity.code;
    input.setAttribute("aria-label", `${identity.name}每人費用`);
    input.value = activity.activity_identity_prices?.find((price) => price.identity_code === identity.code)?.fee_amount ?? "";
    label.append(name, input);
    container.append(label);
  }
}

const identityPricesFrom = (form) => [...form.querySelectorAll("[data-identity-price]")]
  .filter((input) => input.value !== "")
  .map((input) => ({ identity_code: input.dataset.identityPrice, fee_amount: Number(input.value) }));

// 一般 and both 兒童 identities are reserved: keep them active and publicly selectable.
const reservedIdentity = (code) => ["general", "child", "preschool"].includes(code);

function renderIdentities() {
  const rows = document.querySelector("#identity-rows");
  rows.replaceChildren();
  for (const identity of reference.identities ?? []) {
    const row = document.createElement("tr");
    cell(row, identity.name);
    cell(row, identity.is_active ? "啟用" : "停用");
    cell(row, identity.public_selectable ? "是" : "僅後台");
    appendIdentityBadge(cell(row, identity.show_badge ? "" : "不顯示"), { meal_identity: identity.code });
    editButton(row, () => {
      const form = document.querySelector("#identity-form");
      fillForm(form, identity);
      // The stored code, not the color picker's lowercase copy, so saving unchanged writes no audit row.
      form.elements.badge_color_hex.value = identity.badge_color ?? "#e1effe";
      form.elements.is_active.disabled = reservedIdentity(identity.code);
      form.elements.public_selectable.disabled = reservedIdentity(identity.code);
    });
    if (!reservedIdentity(identity.code)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "刪除";
      remove.addEventListener("click", () => {
        if (confirm(`刪除身分「${identity.name}」？已使用的身分無法刪除。`)) saveIdentity("delete_identity", { code: identity.code });
      });
      row.lastElementChild.append(remove);
    }
    rows.append(row);
  }
}

async function saveIdentity(kind, data) {
  const activityForm = document.querySelector("#activity-form");
  try {
    await api("save_reference", { kind, data });
    reference = await api("list_reference");
    Meals.configure(reference.identities, true);
    renderIdentities();
    // Prices typed into an open activity form survive the redraw of its fields.
    renderIdentityPrices({ activity_identity_prices: identityPricesFrom(activityForm) });
    renderNewRegistrationForm();
    document.querySelector("#identity-form").reset();
    showMessage("身分已更新。");
  } catch (error) { showMessage(error.message, true); return; }
  // The identity is already saved, so a failed redraw must not read as a failed save.
  try {
    await loadRegistrations();
    if (selectedRegistration) renderDetailTitle(selectedRegistration);
    // 各區 always has its 合計 row once statistics were shown, even with no published activity.
    if (document.querySelector("#district-stats-rows").children.length) await showStatistics();
  } catch (error) { showMessage(`身分已更新，但畫面未能重新整理：${error.message}`, true); }
}

document.querySelector("#identity-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const { elements } = event.currentTarget;
  saveIdentity("identity", { code: elements.code.value, name: elements.name.value,
    is_active: elements.is_active.checked, public_selectable: elements.public_selectable.checked,
    show_badge: elements.show_badge.checked, badge_color: elements.badge_color_hex.value });
});

document.querySelector('#identity-form [name="badge_color"]').addEventListener("input", (event) => {
  event.target.form.elements.badge_color_hex.value = event.target.value;
});
document.querySelector('#identity-form [name="badge_color_hex"]').addEventListener("input", (event) => {
  if (/^#[0-9a-f]{6}$/i.test(event.target.value)) event.target.form.elements.badge_color.value = event.target.value;
});
document.querySelector("#identity-form").addEventListener("reset", (event) => {
  const { elements } = event.currentTarget;
  elements.code.value = "";
  elements.is_active.disabled = false;
  elements.public_selectable.disabled = false;
});

for (const [selector, kind] of [
  ["#settings-form", "settings"], ["#hosting-settings-form", "hosting"],
  ["#activity-form", "activity"], ["#program-form", "program"],
]) {
  const form = document.querySelector(selector);
  form.addEventListener("submit", (event) => saveReference(event, kind));
  if (!["settings", "hosting"].includes(kind)) form.addEventListener("reset", () => {
    setEditing(form, null);
    // The activity being edited was left out of its own audience options; a new one may pick it.
    if (kind === "activity") { setAudienceOptions(); renderIdentityPrices(); }
  });
}

// Activity order: a toggle shows the ☰ column; dragging (mouse or touch, via Pointer Events,
// which work on iOS Safari unlike HTML drag and drop) or ↑/↓ on a handle moves rows, and
// "完成排序" saves the whole order at once.
const activitySection = document.querySelector("#admin-activities");
const activityRows = document.querySelector("#activity-rows");
const reorderButton = document.querySelector("#reorder-activities");
const cancelReorderButton = document.querySelector("#cancel-reorder");
const staffNav = document.querySelector(".staff-nav");
let activityOrderBefore = "";
let endDrag = null;

const activityOrder = () => Array.from(activityRows.rows, (row) => Number(row.dataset.id));

function setReordering(on) {
  // A drag still running would move a row that a redraw has already replaced.
  endDrag?.();
  activitySection.classList.toggle("reordering", on);
  reorderButton.textContent = on ? "完成排序" : "調整排序";
  reorderButton.classList.toggle("secondary", !on);
  cancelReorderButton.hidden = !on;
  document.querySelector("#reorder-hint").hidden = !on;
  for (const button of activityRows.querySelectorAll("button:not(.drag-handle)")) button.disabled = on;
  // The details list is hidden while reordering; inert keeps its title from being a tab stop announced as
  // expanded, or toggled into a state nobody sees that reopens after 完成排序.
  for (const details of activityRows.querySelectorAll("details")) details.inert = on;
}

reorderButton.addEventListener("click", async () => {
  if (!activitySection.classList.contains("reordering")) {
    activityOrderBefore = JSON.stringify(activityOrder());
    setReordering(true);
    return;
  }
  const order = activityOrder();
  if (JSON.stringify(order) === activityOrderBefore) return setReordering(false);
  // 取消 also waits, so it cannot put back the old order on screen while the new one is being saved.
  reorderButton.disabled = cancelReorderButton.disabled = true;
  try {
    await api("reorder_activities", { activity_ids: order });
  } catch (error) {
    if (error.status !== 409) return showMessage(error.message, true);
    // The list changed elsewhere; retrying or 取消 would keep using the stale list, so reload it.
    try {
      reference.activities = (await api("list_reference")).activities;
    } catch (reloadError) {
      return showMessage(`${error.message}（重新載入失敗：${reloadError.message}）`, true);
    }
    setReordering(false);
    renderReferenceRows("#activity-rows");
    renderNewRegistrationForm();
    return showMessage("活動清單已有變動，已重新載入，請再調整一次排序。", true);
  } finally {
    reorderButton.disabled = cancelReorderButton.disabled = false;
  }
  // The server numbers activities 1, 2, 3... in the order sent, so update the local copy
  // instead of reloading everything.
  const byId = new Map(reference.activities.map((item) => [item.id, item]));
  reference.activities = order.map((id, index) => ({ ...byId.get(id), sort_order: index + 1 }));
  setReordering(false);
  renderReferenceRows("#activity-rows");
  renderNewRegistrationForm();
  // An open activity edit still holds the old sort_order and would undo this order when saved.
  const activityForm = document.querySelector("#activity-form");
  const position = order.indexOf(Number(activityForm.dataset.editingId)) + 1;
  if (position) activityForm.elements.sort_order.value = position;
  showMessage("活動排序已儲存。");
});

cancelReorderButton.addEventListener("click", () => {
  renderReferenceRows("#activity-rows");
  setReordering(false);
});

activityRows.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".drag-handle");
  // Only the first finger or the main mouse button drags; a second finger or a right-click does not.
  if (!handle || !activitySection.classList.contains("reordering") || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  endDrag?.();
  const row = handle.closest("tr");
  row.classList.add("dragging");
  let clientX;
  let clientY;
  // The sticky navigation bar covers the top of the page on desktop, so its bottom is the top edge.
  const topEdge = () => Math.max(0, staffNav.getBoundingClientRect().bottom);
  const place = () => {
    const y = Math.max(clientY, topEdge() + 1);
    const target = document.elementFromPoint(clientX, y)?.closest("#activity-rows tr");
    if (!target || target === row) return;
    const { top, height } = target.getBoundingClientRect();
    activityRows.insertBefore(row, y < top + height / 2 ? target : target.nextElementSibling);
  };
  // touch-action: none stops the finger from scrolling, so scroll while the pointer rests near
  // the top or bottom edge; otherwise a row could only reach positions already on screen.
  let frame;
  const autoScroll = () => {
    const edge = 56;
    const step = clientY === undefined ? 0 : clientY < topEdge() + edge ? -10 : clientY > window.innerHeight - edge ? 10 : 0;
    if (step) {
      window.scrollBy(0, step);
      place();
    }
    frame = requestAnimationFrame(autoScroll);
  };
  frame = requestAnimationFrame(autoScroll);
  // Listen on window: pointer capture is not reliable across browsers, and a missed capture would
  // send moves to whatever element is under the pointer instead of this handle.
  const finish = () => {
    cancelAnimationFrame(frame);
    row.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("blur", finish);
    endDrag = null;
  };
  const move = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    // A release outside the window may never send pointerup; no button held means the drag is over.
    if (moveEvent.buttons === 0) return finish();
    ({ clientX, clientY } = moveEvent);
    place();
  };
  const end = (endEvent) => {
    if (endEvent.pointerId === event.pointerId) finish();
  };
  endDrag = finish;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", finish);
});

activityRows.addEventListener("keydown", (event) => {
  const handle = event.target.closest(".drag-handle");
  if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const row = handle.closest("tr");
  const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  sibling.insertAdjacentElement(event.key === "ArrowUp" ? "beforebegin" : "afterend", row);
  handle.focus();
});

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = String(new FormData(form).get("username")).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,30}$/.test(username)) return showMessage("請檢查帳號格式", true);
  try {
    await authRequest("token?grant_type=password", { email: `${username}@accounts.invalid`, password: form.elements.password.value });
    form.elements.password.value = "";
    // A message left from before login (for example "請使用新密碼重新登入") no longer applies.
    hideMessage();
    await openStaff();
  } catch (error) { showMessage(error.message, true); }
});

// The same form serves a required change (first login or a reset) and a change by choice.
function showChangePassword(visible, byChoice = false) {
  changePasswordPanel.hidden = !visible;
  document.querySelector("#change-password-title").textContent = byChoice ? "更改密碼" : "更改初始密碼";
  document.querySelector("#change-password-intro").textContent = byChoice
    ? "輸入目前密碼與新密碼；完成後所有裝置都會登出，請用新密碼重新登入。"
    : "首次登入或密碼重設後須更改密碼，完成後才能使用後台。";
  document.querySelector("#cancel-change-password").hidden = !byChoice;
  if (!visible) document.querySelector("#change-password-form").reset();
}

document.querySelector("#change-password-button").addEventListener("click", () => {
  showChangePassword(true, true);
  changePasswordPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector('#change-password-form input[name="current_password"]').focus();
});
document.querySelector("#cancel-change-password").addEventListener("click", () => showChangePassword(false));

document.querySelector("#change-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("change_password", {
      current_password: form.elements.current_password.value, password: form.elements.password.value,
    });
    form.reset();
    clearSession();
    showMessage("密碼已更改，請使用新密碼重新登入。", false, true);
  } catch (error) { showMessage(error.message, true); }
});

document.querySelector("#create-staff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("create_staff", Object.fromEntries(new FormData(form)));
    form.reset();
    await loadStaff();
    showMessage("帳號已建立。請以安全方式私下交付密碼。");
  } catch (error) { showMessage(error.message, true); }
});

document.querySelector("#edit-staff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingStaff) return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api("update_staff", { user_id: editingStaff.auth_user_id, ...values });
    if (editingStaff.auth_user_id === profile.auth_user_id) {
      profile.display_name = values.display_name.trim();
      document.querySelector("#identity").textContent = `${profile.display_name}｜${label("role", profile.role)}`;
    }
    const renamed = values.username.trim().toLowerCase() !== editingStaff.username;
    editingStaff = { ...editingStaff, username: values.username.trim().toLowerCase(), display_name: values.display_name.trim() };
    document.querySelector("#staff-editor-title").textContent = `修改帳號：${editingStaff.username}`;
    showMessage(renamed ? "帳號已更新，之後請用新帳號名稱登入。" : "帳號已更新。");
    await loadStaff();
  } catch (error) { showMessage(error.message, true); }
});

document.querySelector("#staff-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!editingStaff || !confirm(`確定設定 ${editingStaff.username} 的密碼？對方所有已登入的裝置都會登出。`)) return;
  try {
    const result = await api("set_staff_password", { user_id: editingStaff.auth_user_id, password: form.elements.password.value });
    form.reset();
    showMessage(result.must_change_password
      ? "密碼已設定。對方是管理員，下次登入時須改成自己的密碼；請以安全方式私下交付。"
      : "密碼已設定。請以安全方式私下交付。");
  } catch (error) { showMessage(error.message, true); }
});

document.querySelector("#close-staff-editor").addEventListener("click", () => {
  document.querySelector("#staff-editor").hidden = true;
  editingStaff = null;
});

// A failed load keeps the previous page and conditions, so the controls match the rows on screen.
async function showRegistrations(nextPage, nextSearch = search, nextDistrict = district, nextIdentityFilter = identityFilter) {
  const previous = [page, search, district, identityFilter];
  [page, search, district, identityFilter] = [nextPage, nextSearch, nextDistrict, nextIdentityFilter];
  try {
    await loadRegistrations();
    return true;
  } catch (error) {
    // A 401 has already logged out and cleared the conditions; restoring them would hand them to the next login.
    if (session) [page, search, district, identityFilter] = previous;
    showMessage(error.message, true);
    return false;
  } finally {
    updateClearSearch();
  }
}
const searchForm = document.querySelector("#search-form");
// Enabled while either the typed or the applied conditions are set, so a filter typed away but still on the list can be cleared.
function updateClearSearch() {
  document.querySelector("#clear-search").disabled = !search && !district && !identityFilter
    && !searchForm.elements.search.value.trim() && !searchForm.elements.district_id.value
    && !searchForm.elements.identity_filter.value;
}
searchForm.addEventListener("input", updateClearSearch);
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showRegistrations(0, searchForm.elements.search.value.trim(), searchForm.elements.district_id.value,
    searchForm.elements.identity_filter.value);
});
document.querySelector("#clear-search").addEventListener("click", async () => {
  const entered = [searchForm.elements.search.value, searchForm.elements.district_id.value,
    searchForm.elements.identity_filter.value];
  searchForm.reset();
  // A failed load keeps the conditions from before the click, in the fields as well as on the list.
  if (!await showRegistrations(0, "", "", "") && session) {
    [searchForm.elements.search.value, searchForm.elements.district_id.value,
      searchForm.elements.identity_filter.value] = entered;
    updateClearSearch();
  }
});
document.querySelector("#refresh-stats").addEventListener("click", () =>
  showStatistics().catch((error) => showMessage(error.message, true)));
document.querySelector("#download-csv").addEventListener("click", () =>
  downloadCsv().catch((error) => showMessage(error.message, true)));
document.querySelector("#download-stats-csv").addEventListener("click", () =>
  downloadStatisticsCsv().catch((error) => showMessage(error.message, true)));
document.querySelector("#edit-registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const choices = choicesFromForm(form);
  let parentName;
  try { parentName = parentNameFrom(form); } catch (error) { return showMessage(error.message, true); }
  // Saving applies the audience rule to sign-ups from before an activity was restricted.
  const reverted = Meals.revertedCount(document.querySelector("#detail-choices"));
  if (reverted && !confirm(`這筆登記有 ${reverted} 項限定活動不符報名對象，儲存後會改為不參加。確定儲存？`)) return;
  const child = parentName !== null;
  const skip = !Meals.answersHosting(form.elements.meal_identity.value);
  try {
    await api("save_registration", {
      registration_id: selectedRegistration.id, full_name: data.get("full_name"),
      district_id: Number(data.get("district_id")), choices,
      hosting: skip ? null : Hosting.read(document.querySelector("#detail-hosting")),
      pickup: skip ? null : Pickup.read(document.querySelector("#detail-pickup")),
      meal_identity: Meals.readIdentity(form),
      is_child: child, child_type: Meals.childType(form.elements.meal_identity.value), parent_name: parentName ?? undefined,
    });
    await refreshRegistration();
    // Back in view mode the save button is hidden; focus the way back into editing.
    document.querySelector("#start-registration-edit").focus();
    showMessage("登記資料已儲存。");
  } catch (error) { showMessage(error.message, true); }
});
// Same form content keeps the same id, so a double submit or network retry cannot create a second record.
let newRegistrationRequestId = crypto.randomUUID();
document.querySelector("#new-registration-form").addEventListener("input", (event) => {
  newRegistrationRequestId = crypto.randomUUID();
  syncChildFields(event.currentTarget);
  syncNewMeals();
});
document.querySelector("#edit-registration-form").addEventListener("input", (event) => {
  if (editingRegistration) syncChildFields(event.currentTarget);
  syncDetailMeals();
});
// Each button hides itself, so focus moves to where the person continues instead of falling to the page.
document.querySelector("#start-registration-edit").addEventListener("click", () => {
  openRegistration(selectedRegistration, true);
  document.querySelector('#edit-registration-form input[name="full_name"]').focus();
});
document.querySelector("#cancel-registration-edit").addEventListener("click", () => {
  openRegistration(selectedRegistration);
  document.querySelector("#start-registration-edit").focus();
});
document.querySelector("#new-registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  const data = new FormData(form);
  try {
    const parentName = parentNameFrom(form);
    const child = parentName !== null;
    const skip = !Meals.answersHosting(form.elements.meal_identity.value);
    const result = await api("create_registration", {
      create_request_id: newRegistrationRequestId,
      full_name: data.get("full_name"), district_id: Number(data.get("district_id")),
      choices: choicesFromForm(form),
      hosting: skip ? null : Hosting.read(document.querySelector("#new-registration-hosting")),
      pickup: skip ? null : Pickup.read(document.querySelector("#new-registration-pickup")),
      meal_identity: Meals.readIdentity(form),
      is_child: child, child_type: Meals.childType(form.elements.meal_identity.value), parent_name: parentName ?? undefined,
    });
    newRegistrationRequestId = crypto.randomUUID();
    const notice = document.querySelector("#new-registration-code");
    notice.textContent = `已建立流水號 ${result.serial_no}。本人日後可用相同的姓名與區查詢。`;
    notice.hidden = false;
    form.reset();
    renderNewRegistrationForm();
    await loadRegistrations();
    showMessage("協助登記已建立。");
  } catch (error) {
    if (["HOSTING_REQUIRED", "PICKUP_REQUIRED"].includes(error.code)) {
      reference.settings[error.code === "HOSTING_REQUIRED" ? "is_hosting_open" : "is_pickup_open"] = true;
      renderNewRegistrationForm();
    }
    showMessage(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
document.querySelector("#import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("set_import_status", {
      registration_id: selectedRegistration.id,
      status: new FormData(event.currentTarget).get("status"),
    });
    await refreshRegistration();
    showMessage("匯入狀態已更新。");
  } catch (error) { showMessage(error.message, true); }
});
document.querySelector("#void-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirm("確定作廢此登記？作廢後不計入統計與 CSV，且無法在頁面上恢復。")) return;
  try {
    await api("void_registration", {
      registration_id: selectedRegistration.id,
      reason: String(new FormData(event.currentTarget).get("reason")).trim(),
    });
    await refreshRegistration();
    showMessage("登記已作廢。");
  } catch (error) { showMessage(error.message, true); }
});
document.querySelector("#previous-page").addEventListener("click", () => showRegistrations(page - 1));
document.querySelector("#next-page").addEventListener("click", () => showRegistrations(page + 1));
document.querySelector("#logout-button").addEventListener("click", async () => {
  const token = session?.access_token;
  let remoteError = false;
  try {
    if (token) await fetch(`${config.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST", headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` },
    });
  } catch {
    remoteError = true;
  } finally {
    clearSession();
    showMessage(remoteError ? "無法確認遠端登出，請關閉此分頁。" : "已登出。", remoteError);
  }
});

// Auth failures already clear the session in api()/accessToken(); a brief outage should not log the user out.
if (session) openStaff().catch((error) => showMessage(error.message, true));
