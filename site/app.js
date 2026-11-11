const config = window.APP_CONFIG;
const message = document.querySelector("#page-message");
const registrationForm = document.querySelector("#registration-form");
const queryForm = document.querySelector("#query-form");
const editForm = document.querySelector("#edit-form");
const editActivities = document.querySelector("#edit-activities");
const startEditButton = document.querySelector("#start-edit");
const saveEditButton = document.querySelector("#save-edit");
const cancelEditButton = document.querySelector("#cancel-edit");
const hostingSection = document.querySelector("#hosting-section");
const hostingFields = document.querySelector("#hosting-fields");
const pickupFields = document.querySelector("#pickup-fields");
const editHostingSection = document.querySelector("#edit-hosting-section");
const editHosting = document.querySelector("#edit-hosting");
const editPickup = document.querySelector("#edit-pickup");
const editChildInput = editForm.elements.meal_identity;
const editParentInput = editForm.elements.parent_name;
// Server codes for a survey switch that changed after this page loaded.
const surveyChangeCodes = ["HOSTING_CLOSED", "HOSTING_REQUIRED", "PICKUP_CLOSED", "PICKUP_REQUIRED", "HOSTING_NOT_ALLOWED", "PICKUP_NOT_ALLOWED"];
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const startedAt = Date.now();
let pageData;
// The name and district of the loaded registration; an update sends them back as its lookup key.
let activeIdentity = null;
let queriedChoicesBaseline = null;
let queriedHostingBaseline = null;
let queriedPickupBaseline = null;
let queriedIdentityBaseline = null;
// { child_type, parent_name } as saved; child_type is "" and parent_name null for anyone not a child.
let queriedChildBaseline = null;
// The edit form as it first appears. Opening it can already turn a restricted activity signed up
// before the restriction into 不參加 (and so hide the identity question); that alone is not an edit
// to warn about, and it is saved only together with a change the person makes.
let editStartChoices = null;
let editStartIdentity = null;
let queriedCanChange = false;
let editMode = false;

// The banner text lives here, not in the HTML, so link previews (LINE) never pick it up on the real site.
if (config?.environment === "test") Object.assign(document.querySelector("#test-banner"), { textContent: "測試站｜請勿填寫正式登記資料", hidden: false });
// The success page keeps its summary across reloads; returning here clears it, so the next
// person on a shared device starts without the previous person's details.
sessionStorage.removeItem("registration_success");

function selectTab(tab) {
  const current = tabs.find((item) => item.getAttribute("aria-selected") === "true");
  if (tab !== current && hasUnsavedChanges() && !confirm("確定放棄尚未儲存的修改？")) return false;
  if (tab !== current && editMode) showConfirmation();
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
  }
  return true;
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? tabs[0]
      : event.key === "End" ? tabs.at(-1)
      : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    if (selectTab(next)) next.focus();
  });
}

function showMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
  message.hidden = false;
  message.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function api(body) {
  if (!config?.supabaseUrl || !config?.publishableKey) throw new Error("網站尚未設定 Supabase 公開連線資訊");
  const response = await fetch(`${config.supabaseUrl}/functions/v1/registration`, {
    method: body ? "POST" : "GET",
    headers: { apikey: config.publishableKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "服務暫時無法使用");
    error.status = response.status;
    error.code = result.code;
    error.body = result;
    throw error;
  }
  return result;
}

// Only http(s) links open; anything else (javascript:, typos) is left out rather than shown broken.
function mapLink(value) {
  const url = Meals.mapUrl(value);
  if (!url) return "";
  const href = escapeHtml(url).replaceAll('"', "&quot;");
  return `<p class="hint"><a href="${href}" target="_blank" rel="noopener noreferrer">查看地圖</a></p>`;
}

// The query tab leaves out the map link; it is only for people deciding to register.
function activityDetails(activity, showMap = true) {
    const time = Meals.activityTime(activity);
    return `<strong>${escapeHtml(activity.title)}</strong>
      ${time ? `<p class="hint">時間：${escapeHtml(time)}</p>` : ""}
      ${activity.venue ? `<p class="hint">地點：${escapeHtml(activity.venue)}</p>` : ""}
      ${activity.address ? `<p class="hint">地址：${escapeHtml(activity.address)}</p>` : ""}
      ${showMap && activity.map_url ? mapLink(activity.map_url) : ""}
      ${Meals.feeText(activity) ? `<p class="hint">${escapeHtml(Meals.feeText(activity))}</p>` : ""}
      ${activity.description ? `<p class="hint activity-description">${escapeHtml(activity.description)}</p>` : ""}`;
}

function activityFields(activities, values = new Map(), showMap = true) {
  return activities.map((activity) => {
    const selected = values.get(activity.id);
    return `<div class="activity" data-activity="${activity.id}">
      ${activityDetails(activity, showMap)}
      <div class="activity-options">
        <label><input type="radio" name="activity_${activity.id}" value="true" ${selected === true ? "checked" : ""} required>參加</label>
        <label><input type="radio" name="activity_${activity.id}" value="false" ${selected === false ? "checked" : ""} required>不參加</label>
      </div>
    </div>`;
  }).join("");
}

function activitySummaryFields(activities, values) {
  return activities.map((activity) => {
    const selected = values.get(activity.id);
    const status = selected === true ? "參加" : selected === false ? "不參加" : "未回覆";
    return `<div class="activity">
      ${activityDetails(activity, false)}
      <p class="activity-status">登記狀態：${status}</p>
    </div>`;
  }).join("");
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function showProgram(program) {
  const section = document.querySelector("#program-section");
  section.hidden = program.length === 0;
  const days = new Map();
  for (const item of program) {
    if (!days.has(item.event_date)) days.set(item.event_date, []);
    days.get(item.event_date).push(item);
  }
  document.querySelector("#program").innerHTML = Array.from(days, ([date, items]) => {
    const day = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", month: "long", day: "numeric", weekday: "long",
    }).format(new Date(`${date}T00:00:00+08:00`));
    return `<section class="program-day" aria-label="${escapeHtml(day)}">
      <h3>${escapeHtml(day)}</h3>
      <div class="program-slots">${items.map((item) => {
        const start = item.start_time?.slice(0, 5);
        const end = item.end_time?.slice(0, 5);
        const time = start ? `${start}${end ? `–${end}` : ""}` : "時間待定";
        return `<div class="program-slot">
          <time>${escapeHtml(time)}</time>
          <div><strong>${escapeHtml(item.title)}</strong>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}</div>
        </div>`;
      }).join("")}</div>
    </section>`;
  }).join("");
}

function districtOptions(districts) {
  return `<option value="">請選擇</option>${districts.map((district) =>
    `<option value="${district.id}">${escapeHtml(district.name)}</option>`
  ).join("")}`;
}

function choicesFrom(form) {
  const choices = Meals.choices(form, pageData.activities);
  if (choices.length !== pageData.activities.length) throw new Error("請回答每一項活動");
  return choices;
}

function sortedChoices(choices) {
  return choices
    .map((choice) => ({ activity_id: Number(choice.activity_id), attending: choice.attending }))
    .sort((left, right) => left.activity_id - right.activity_id);
}

function choicesMap(choices) {
  return new Map(choices.map((choice) => [Number(choice.activity_id), choice.attending]));
}

function currentEditChoices() {
  const answered = choicesMap(Meals.choices(editForm, pageData.activities));
  return sortedChoices(pageData.activities.map((activity) => ({
    activity_id: activity.id, attending: answered.has(activity.id) ? answered.get(activity.id) : null,
  })));
}

const hostingOpen = () => Boolean(pageData?.settings.is_hosting_open);
const pickupOpen = () => Boolean(pageData?.settings.is_pickup_open);
const registrationChild = () => Boolean(Meals.childType(registrationForm.elements.meal_identity.value));
// Derive child fields from the single identity choice while editing.
function currentEditChild() {
  if (!editMode) return queriedChildBaseline;
  const type = Meals.childType(editChildInput.value);
  return { child_type: type, parent_name: type ? editParentInput.value.trim() : null };
}
const editingChild = () => Boolean(currentEditChild()?.child_type);
const registrationSkipsHosting = (kind = "hosting") => !Meals.answersHosting(registrationForm.elements.meal_identity.value, kind);
const editingSkipsHosting = (kind = "hosting") => !Meals.answersHosting(currentEditIdentity(), kind);
const editSurveyReset = new Set();

function syncRegistrationSurveys() {
  const visible = [];
  for (const [kind, container, renderer] of [["hosting", hostingFields, Hosting], ["pickup", pickupFields, Pickup]]) {
    const allowed = !registrationSkipsHosting(kind);
    const show = allowed && (kind === "hosting" ? hostingOpen() : pickupOpen());
    const survey = hostingSection.querySelector(`.${kind}-survey`);
    const identity = registrationForm.elements.meal_identity.value;
    // 請選擇 is not a new identity: passing through it does not count as leaving.
    if (identity && container.dataset.wasAllowed === "true" && !allowed
      && container.dataset.identity !== identity) renderer.render(container, null);
    if (show && container.dataset[kind] === undefined) renderer.render(container);
    if (identity) Object.assign(container.dataset, { wasAllowed: String(allowed), identity });
    survey.hidden = !show;
    // A hidden required control must not block the other survey or the whole form.
    for (const control of container.querySelectorAll("input,select")) control.disabled = !show;
    if (show) renderer.sync?.(container);
    visible.push(show);
  }
  hostingSection.hidden = !visible.some(Boolean);
  hostingSection.disabled = false;
  hostingSection.querySelector("legend").textContent = visible[0] ? "開家接待" : "接機接待";
  const pickupSurvey = hostingSection.querySelector(".pickup-survey");
  pickupSurvey.classList.toggle("with-hosting", visible[0] && visible[1]);
  pickupSurvey.querySelector(".pickup-heading").hidden = !visible[0] || !visible[1];
}

// Children give a parent name. Each survey follows its own public identity target list.
function showRegistrationChild() {
  const child = registrationChild();
  registrationForm.querySelector(".preschool-hint").hidden = Meals.childType(registrationForm.elements.meal_identity.value) !== "preschool";
  registrationForm.querySelector(".child-hint").hidden = !child;
  registrationForm.querySelector(".parent-name").hidden = !child;
  registrationForm.elements.parent_name.disabled = !child;
  syncRegistrationSurveys();
}

// The lookup shows the saved child fields read-only until 修改登記內容.
function showEditChild() {
  if (!editMode) {
    Meals.renderIdentity(editChildInput, queriedIdentityBaseline);
    editParentInput.value = queriedChildBaseline?.parent_name ?? "";
  }
  const child = editingChild();
  editForm.querySelector(".preschool-hint").hidden = currentEditChild()?.child_type !== "preschool";
  editChildInput.disabled = !editMode;
  editForm.querySelector(".child-hint").hidden = !(editMode && child);
  editForm.querySelector(".parent-name").hidden = !child;
  editParentInput.readOnly = !editMode;
  editParentInput.disabled = !child;
}

const currentEditIdentity = () => editMode ? Meals.readIdentity(editForm) : queriedIdentityBaseline;
const checkedHostingStatus = (container) => container.querySelector('[name="hosting_status"]:checked')?.value ?? null;

// Restricted activities follow the current hosting, pickup and activity answers.
function syncMeals() {
  Meals.sync(registrationForm, pageData.activities, {
    skipsHosting: registrationSkipsHosting(),
    skipsPickup: registrationSkipsHosting("pickup"),
    hostingStatus: hostingOpen() ? checkedHostingStatus(hostingFields) : null,
    pickupStatus: pickupOpen() ? Pickup.read(pickupFields)?.status : null,
  });
  if (editMode) {
    Meals.sync(editActivities, pageData.activities, {
      skipsHosting: editingSkipsHosting(),
      skipsPickup: editingSkipsHosting("pickup"),
      hostingStatus: hostingOpen() ? checkedHostingStatus(editHosting) : validAnswer(queriedHostingBaseline)?.status ?? null,
      pickupStatus: validAnswer(currentEditPickup())?.status ?? null,
    });
  }
}

// Only an open hosting survey is editable by the registrant; otherwise the stored answer stands.
// Non-target identities retain their saved answer read-only.
function currentEditHosting() {
  return editMode && hostingOpen() && !editingSkipsHosting() ? Hosting.read(editHosting) : queriedHostingBaseline;
}
function currentEditPickup() {
  return editMode && pickupOpen() && !editingSkipsHosting("pickup") ? Pickup.read(editPickup) : queriedPickupBaseline;
}

// An invalidated answer shows as unanswered, so leaving it unanswered is not a change.
const validAnswer = (answer) => answer?.answer_valid === false ? null : answer;
// Saving moves this survey out of the identity's reach, so the server will store 否 for it.
function editLeaves(kind) {
  const identity = currentEditIdentity();
  return editMode && Boolean(identity) && identity !== queriedIdentityBaseline
    && Meals.answersHosting(queriedIdentityBaseline ?? "general", kind) && !Meals.answersHosting(identity, kind);
}
function hasUnsavedChanges() {
  return Boolean(editMode && editStartChoices
    && (JSON.stringify(currentEditChoices()) !== JSON.stringify(editStartChoices)
      || JSON.stringify(validAnswer(currentEditHosting())) !== JSON.stringify(validAnswer(queriedHostingBaseline))
      || JSON.stringify(validAnswer(currentEditPickup())) !== JSON.stringify(validAnswer(queriedPickupBaseline))
      || JSON.stringify(currentEditChild()) !== JSON.stringify(queriedChildBaseline)
      || currentEditIdentity() !== editStartIdentity
      || [...editSurveyReset].some((kind) => !editingSkipsHosting(kind))));
}

function updateSaveState() {
  saveEditButton.disabled = !editForm.checkValidity() || !hasUnsavedChanges();
}

// The hosting description: on the registration form while hosting is open, and in the lookup only
// while editing, since the confirmation and read-only views cannot answer it.
function showHostingDescriptions() {
  for (const [element, visible] of [[hostingSection, true], [editHostingSection, editMode]]) {
    for (const [kind, open] of [["hosting", hostingOpen()], ["pickup", pickupOpen()]]) {
      const description = element.querySelector(`.${kind}-description`);
      const allowed = element === hostingSection ? !registrationSkipsHosting(kind) : !editingSkipsHosting(kind);
      const text = open && allowed ? pageData.settings[`${kind}_description`] ?? "" : "";
      description.textContent = text;
      description.hidden = !(visible && text);
    }
  }
}

// Each open target survey has enabled fields; hidden required controls never block submission.
function showRegistrationHosting() {
  showHostingDescriptions();
  showRegistrationChild();
}

// The switch changed after this page loaded (HOSTING_CLOSED / HOSTING_REQUIRED from the server).
// Shows what happened; unsaved activity edits stay as they are.
// HOSTING_REQUIRED carries the current description, which the admin may have written meanwhile.
function applyHostingChange(error) {
  const kind = error.code.startsWith("PICKUP") ? "pickup" : "hosting";
  const title = kind === "pickup" ? "接機接待" : "開家接待";
  if (error.body?.survey_settings) Object.assign(pageData.settings, error.body.survey_settings);
  // NOT_ALLOWED says nothing about the switch, so without settings the page keeps what it has.
  else if (!error.code.endsWith("NOT_ALLOWED")) pageData.settings[`is_${kind}_open`] = error.code.endsWith("REQUIRED");
  Meals.configure(pageData.identities, false, pageData.settings);
  if (error.body?.[`${kind}_description`] !== undefined) pageData.settings[`${kind}_description`] = error.body[`${kind}_description`];
  showRegistrationHosting();
  // showHostingSummary renders the fields that became editable; a lookup shown in the other tab
  // keeps its hosting summary and hint in step with the switch.
  if (editMode || queriedChoicesBaseline) showHostingSummary();
  // Restricted activities now follow the answer that stands after the switch.
  syncMeals();
  // Only the hosting answer had changed: nothing is left to save.
  if (editMode && error.code.endsWith("CLOSED") && !hasUnsavedChanges()) {
    showConfirmation();
    // Nothing was lost and the page is back to a normal confirmation, so this is not an error.
    return showMessage(`${title}調查已關閉，接待內容維持原樣。`);
  }
  const button = editMode ? "「儲存修改」" : "「送出登記」";
  if (error.code.endsWith("NOT_ALLOWED")) return showMessage("此身分的接待填寫設定已變更，請確認表單後重新儲存。", true);
  if (error.code.endsWith("REQUIRED")) return showMessage(kind === "pickup"
    ? `接機接待調查已開放，請回答是否可以接機後再按${button}。`
    : `開家接待調查已開放，請回答開家接待後再按${button}。`, true);
  // A new registration had nothing stored, so its answer is dropped, not kept.
  return showMessage(editMode ? `${title}調查已關閉，接待內容維持原樣，請再按一次「儲存修改」。`
    : `${title}調查已關閉，接待回答不會送出；請再按一次「送出登記」。`, true);
}

// While hosting is closed an existing answer stays visible but read-only; without one the section stays hidden.
function showHostingSummary() {
  const visible = [];
  for (const [kind, container, renderer, baseline] of [
    ["hosting", editHosting, Hosting, queriedHostingBaseline], ["pickup", editPickup, Pickup, queriedPickupBaseline],
  ]) {
    const allowed = !editingSkipsHosting(kind);
    const open = kind === "hosting" ? hostingOpen() : pickupOpen();
    const identity = currentEditIdentity();
    // 請選擇 (null) is not a new identity: passing through it does not count as leaving.
    if (editMode && identity && container.dataset.wasAllowed === "true" && !allowed
      && container.dataset.identity !== identity) editSurveyReset.add(kind);
    const editable = editMode && allowed && open;
    const survey = kind === "hosting" ? container : container.closest(".pickup-survey");
    const leaves = editLeaves(kind);
    const shown = leaves ? (kind === "hosting" ? { status: "not_hosting" } : { status: "no", count: 0 }) : baseline;
    // An identity that cannot answer has nothing to re-answer, so invalidated history stays hidden.
    const show = Boolean((allowed && open) || (allowed ? baseline : validAnswer(shown)));
    survey.hidden = !show;
    visible.push(show);
    if (editable) {
      if (container.dataset.editable !== "true") renderer.render(container, editSurveyReset.has(kind) ? null : baseline);
    } else {
      container.replaceChildren();
      const summary = document.createElement("p");
      summary.className = "activity-status";
      summary.textContent = `${kind === "hosting" ? "開家接待" : "接機接待"}：${renderer.summary(shown)}`;
      container.append(summary);
      if (!allowed || !open) {
        const hint = document.createElement("p"); hint.className = "hint";
        hint.textContent = leaves ? "此身分不需回答，儲存後為「否」" : !allowed ? "目前此身分未開放修改"
          : `${kind === "hosting" ? "開家接待" : "接機接待"}調查已關閉，如需調整請聯絡服事者`;
        container.append(hint);
      }
    }
    container.dataset.editable = String(editable);
    if (identity) Object.assign(container.dataset, { wasAllowed: String(allowed), identity });
  }
  editHostingSection.hidden = !visible.some(Boolean);
  editHostingSection.disabled = false;
  editHostingSection.querySelector("legend").textContent = visible[0] ? "開家接待" : "接機接待";
  const pickupSurvey = document.querySelector("#edit-pickup-survey");
  pickupSurvey.classList.toggle("with-hosting", visible[0] && visible[1]);
  pickupSurvey.querySelector(".pickup-heading").hidden = !visible[0] || !visible[1];
}

function showConfirmation() {
  editMode = false;
  editSurveyReset.clear();
  for (const container of [editHosting,editPickup]) delete container.dataset.editable;
  editActivities.innerHTML = activitySummaryFields(pageData.activities, choicesMap(queriedChoicesBaseline ?? []));
  showEditChild();
  showHostingSummary();
  showHostingDescriptions();
  for (const hint of editForm.querySelectorAll(".edit-only")) hint.hidden = true;
  startEditButton.hidden = !queriedCanChange;
  startEditButton.disabled = false;
  saveEditButton.hidden = true;
  cancelEditButton.hidden = true;
}

function beginEditing() {
  if (!queriedCanChange || !queriedChoicesBaseline) return;
  editMode = true;
  showEditChild();
  editActivities.innerHTML = activityFields(pageData.activities, choicesMap(queriedChoicesBaseline), false);
  Meals.render(editActivities, pageData.activities);
  for (const container of [editHosting,editPickup]) { delete container.dataset.editable; delete container.dataset.wasAllowed; }
  showHostingSummary();
  syncMeals();
  editStartChoices = currentEditChoices();
  editStartIdentity = currentEditIdentity();
  showHostingDescriptions();
  for (const hint of editForm.querySelectorAll(".edit-only")) hint.hidden = false;
  startEditButton.hidden = true;
  saveEditButton.hidden = false;
  cancelEditButton.hidden = false;
  updateSaveState();
  editActivities.querySelector("input")?.focus();
}

function districtName(id) {
  return pageData.districts.find((district) => String(district.id) === String(id))?.name ?? "";
}

function setBusy(form, busy) {
  form.querySelectorAll("button").forEach((button) => button.disabled = busy);
}

// Built from text nodes so the admin's note can never become markup; only https:// links are clickable.
// A bare link is ASCII URL characters only, so Chinese text written right after it stays text, and a
// trailing . , ; : ! ? ends the sentence, not the link. [label](https://...) shows the label as the link.
const noteLinkPattern = /\[([^\[\]\n]{1,200})\]\((https:\/\/[^\s()]+)\)|(https:\/\/[\w\-.~:/?#[\]@!$&*+,;=%]*[\w\-~/#[\]@$&*+=%])/g;

function showEventNote(text) {
  const note = document.querySelector("#event-note");
  const value = String(text ?? "");
  const parts = [];
  let last = 0;
  for (const match of value.matchAll(noteLinkPattern)) {
    parts.push(document.createTextNode(value.slice(last, match.index)));
    const link = document.createElement("a");
    link.href = match[2] ?? match[3];
    link.textContent = match[1] ?? match[3];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    parts.push(link);
    last = match.index + match[0].length;
  }
  parts.push(document.createTextNode(value.slice(last)));
  note.replaceChildren(...parts);
  note.hidden = !text;
}

async function loadPage() {
  try {
    pageData = await api();
    Meals.configure(pageData.identities, false, pageData.settings);
    Meals.renderIdentity(registrationForm.elements.meal_identity);
    document.querySelector("#event-name").textContent = pageData.settings.event_name;
    document.querySelector("#event-meta").textContent = [pageData.settings.venue, pageData.settings.address].filter(Boolean).join("｜");
    showEventNote(pageData.settings.event_note);
    showProgram(pageData.program);
    registrationForm.elements.district_id.innerHTML = districtOptions(pageData.districts);
    queryForm.elements.district_id.innerHTML = districtOptions(pageData.districts);
    document.querySelector("#activities").innerHTML = activityFields(pageData.activities);
    Meals.render(document.querySelector("#activities"), pageData.activities);
    showRegistrationHosting();
    syncMeals();
    // The server enforces the deadline; this only keeps the page from looking open after it.
    const deadline = pageData.settings.registration_deadline_at;
    const pastDeadline = Boolean(deadline) && new Date(deadline) <= new Date();
    if (!pageData.settings.is_registration_open || pastDeadline || pageData.activities.length === 0) {
      registrationForm.querySelector("button[type=submit]").disabled = true;
      showMessage(pastDeadline ? "登記已截止。" : "登記目前尚未開放。", true);
    }
  } catch (error) {
    registrationForm.hidden = true;
    queryForm.hidden = true;
    showMessage(error.message, true);
  }
}

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(registrationForm, true);
  try {
    const data = new FormData(registrationForm);
    const child = registrationChild();
    const parentName = child ? String(data.get("parent_name") ?? "").trim() : null;
    if (child && !parentName) throw new Error("請填寫家長姓名");
    const choices = choicesFrom(registrationForm);
    const skip = registrationSkipsHosting();
    const hosting = hostingOpen() && !skip ? Hosting.read(hostingFields) : undefined;
    const pickup = pickupOpen() && !registrationSkipsHosting("pickup") ? Pickup.read(pickupFields) : undefined;
    const mealIdentity = Meals.readIdentity(registrationForm);
    await api({
      action: "create",
      create_request_id: crypto.randomUUID(),
      started_at: startedAt,
      website: data.get("website"),
      full_name: data.get("full_name"),
      district_id: Number(data.get("district_id")),
      choices,
      hosting,
      pickup,
      meal_identity: mealIdentity ?? undefined,
      child_type: Meals.childType(registrationForm.elements.meal_identity.value),
      parent_name: parentName ?? undefined,
      turnstile_token: null,
    });
    // The success page shows what was sent, so the person can check it before leaving.
    sessionStorage.setItem("registration_success", JSON.stringify({
      full_name: String(data.get("full_name")).trim(),
      district: districtName(data.get("district_id")),
      parent_name: parentName,
      choices: choices.map((choice) => ({
        title: pageData.activities.find((activity) => activity.id === choice.activity_id)?.title ?? "",
        attending: choice.attending,
      })),
      hosting: hosting ? `開家接待：${Hosting.summary(hosting)}` : null,
      pickup: pickup ? `接機接待：${Pickup.summary(pickup)}` : null,
      meal_identity: mealIdentity ? `身分別：${Meals.identityLabels[mealIdentity]}` : null,
    }));
    location.assign("./success.html");
  } catch (error) {
    if (surveyChangeCodes.includes(error.code)) return applyHostingChange(error);
    showMessage(error.message, true);
  } finally {
    setBusy(registrationForm, false);
  }
});

queryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (hasUnsavedChanges() && !confirm("確定放棄尚未儲存的修改？")) return;
  setBusy(queryForm, true);
  editForm.hidden = true;
  activeIdentity = null;
  queriedChoicesBaseline = null;
  queriedHostingBaseline = null;
  queriedPickupBaseline = null;
  queriedIdentityBaseline = null;
  queriedChildBaseline = null;
  queriedCanChange = false;
  editMode = false;
  try {
    const data = new FormData(queryForm);
    const identity = { full_name: String(data.get("full_name")).trim(), district_id: Number(data.get("district_id")) };
    const registration = await api({ action: "query", ...identity });
    document.querySelector("#edit-full-name").value = registration.full_name;
    document.querySelector("#edit-district").value = districtName(registration.district_id);
    queriedChildBaseline = { child_type: registration.child_type ?? "",
      parent_name: registration.child_type ? registration.parent_name ?? null : null };
    activeIdentity = identity;
    queriedChoicesBaseline = sortedChoices(registration.choices);
    queriedHostingBaseline = Hosting.normalize(registration.hosting);
    queriedPickupBaseline = Pickup.normalize(registration.pickup);
    // The saved identity stays an option even when no longer publicly selectable.
    queriedIdentityBaseline = registration.meal_identity
      ?? (registration.child_type === "preschool" ? "preschool" : registration.is_child ? "child" : "general");
    queriedCanChange = registration.can_change;
    editForm.hidden = false;
    showConfirmation();
    showMessage(registration.can_change
      ? "以下為目前登記內容。"
      : "目前只能查看，無法修改登記內容。");
  } catch (error) {
    editForm.hidden = true;
    showMessage(error.message, true);
  } finally {
    setBusy(queryForm, false);
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeIdentity || !queriedChoicesBaseline) {
    showMessage("請先查詢登記資料。", true);
    return;
  }
  if (!editMode) return;
  const choices = currentEditChoices();
  if (choices.some((choice) => choice.attending === null)) return showMessage("請回答每一項活動", true);
  const child = currentEditChild();
  if (child.child_type && !child.parent_name) return showMessage("請填寫家長姓名", true);
  if (!editForm.reportValidity() || !hasUnsavedChanges()) return;
  const hosting = currentEditHosting();
  const pickup = currentEditPickup();
  const mealIdentity = currentEditIdentity();
  const skip = editingSkipsHosting();
  setBusy(editForm, true);
  try {
    const saved = await api({ action: "update", ...activeIdentity, choices, meal_identity: mealIdentity ?? undefined,
      ...child, ...(hostingOpen() && !skip ? { hosting } : {}),
      ...(pickupOpen() && !editingSkipsHosting("pickup") ? { pickup } : {}),
      ...(!hostingOpen() && !skip && editSurveyReset.has("hosting") ? { hosting: { reset: true } } : {}),
      ...(!pickupOpen() && !editingSkipsHosting("pickup") && editSurveyReset.has("pickup") ? { pickup: { reset: true } } : {}) });
    queriedChoicesBaseline = choices;
    // The server answers with the surveys it saved (stored 否, invalidated history); the sent answers
    // are only a fallback for a reply without them.
    queriedHostingBaseline = saved.surveys ? Hosting.normalize(saved.surveys.hosting) : hosting;
    queriedPickupBaseline = saved.surveys ? Pickup.normalize(saved.surveys.pickup) : pickup;
    queriedChildBaseline = child;
    queriedIdentityBaseline = mealIdentity;
    showConfirmation();
    showMessage("修改已儲存，以下為目前登記內容。");
  } catch (error) {
    if (surveyChangeCodes.includes(error.code)) return applyHostingChange(error);
    if (error.status === 409 || error.message === "查詢功能暫停中，請稍後再試") {
      queriedCanChange = false;
      showConfirmation();
    }
    showMessage(error.message, true);
  } finally {
    setBusy(editForm, false);
    if (editMode) updateSaveState();
  }
});

startEditButton.addEventListener("click", beginEditing);
registrationForm.addEventListener("input", () => {
  showRegistrationChild();
  showHostingDescriptions();
  syncMeals();
});
editForm.addEventListener("input", () => {
  if (!editMode) return;
  showEditChild();
  showHostingSummary();
  showHostingDescriptions();
  syncMeals();
  updateSaveState();
});
cancelEditButton.addEventListener("click", () => {
  if (hasUnsavedChanges() && !confirm("確定放棄尚未儲存的修改？")) return;
  showConfirmation();
  showMessage("以下為目前登記內容。");
});

// A page brought back whole from the back/forward cache keeps typed text, which autocomplete="off"
// does not cover; only the names are cleared, since other fields drive what the form shows.
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  registrationForm.elements.full_name.value = "";
  registrationForm.elements.parent_name.value = "";
  queryForm.elements.full_name.value = "";
});

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

loadPage();
