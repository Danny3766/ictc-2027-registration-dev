// 用餐身分與自訂價格、報名對象，以及活動的時間、費用與地圖連結文字, shared by the public page and the
// back office. The database applies the same rules (registration_meal_identity,
// registration_audience_valid); this only keeps the form in step.
const Meals = (() => {
  const identityLabels = { general: "一般", student: "學生", child: "兒童（國小）", preschool: "兒童（學齡前）" };
  // Until configure() gets the list from the Edge Function (an older one sends none).
  let identities = Object.entries(identityLabels).map(([code, name]) => ({ code, name, is_active: true, public_selectable: true }));
  let staff = false;
  // identityLabels is changed in place, since callers hold the object.
  function configure(items, isStaff = false) {
    if (!items) return;
    identities = items;
    staff = isStaff;
    for (const key of Object.keys(identityLabels)) delete identityLabels[key];
    for (const item of items) identityLabels[item.code] = item.name;
  }
  const revertedNote = "不符報名對象，已改為不參加。";
  // 是 and 家人已登記開家接待 both count as a hosting household.
  const hostingStatuses = ["hosting", "family_registered"];

  const hasStudentPrice = (activity) => activity.student_fee_amount != null;
  const eligible = (activity, context = {}) => {
    const audience = activity.audience ?? "all";
    if (audience === "all") return true;
    // Whoever answers neither survey is outside both audiences (兒童 2026-11-09, any non-一般 2026-11-10).
    if (audience === "hosting") return Boolean(context.skipsHosting) || hostingStatuses.includes(context.hostingStatus);
    if (audience === "pickup") return Boolean(context.skipsHosting) || context.pickupStatus === "yes";
    if (!audience.startsWith("activity:")) return false;
    const requiredId = Number(audience.slice(9));
    const prerequisite = context.activities?.find((item) => item.id === requiredId);
    return Boolean(prerequisite && prerequisite.is_published !== false
      && context.choices?.some((choice) => choice.activity_id === requiredId && choice.attending));
  };
  // A missing price is unknown, not free and never another identity's price.
  const fee = (activity, identity) => {
    if (identity === "general") return activity.fee_amount ?? null;
    if (!identity) return null;
    if (activity.activity_identity_prices) return activity.activity_identity_prices.find((price) => price.identity_code === identity)?.fee_amount ?? null;
    return identity === "student" ? activity.student_fee_amount ?? null : null;
  };
  // Unset fees are left out of a total but counted, so the total can name what it lacks.
  const addFees = (values) => values.reduce((total, value) => value == null
    ? { ...total, missing: total.missing + 1 }
    : { ...total, sum: total.sum + value, known: total.known + 1 }, { sum: 0, known: 0, missing: 0 });
  const needsIdentity = (activities, choices) => choices.some((choice) => choice.attending
    && activities.some((activity) => activity.id === choice.activity_id && activity.category === "meal" && activity.is_published !== false));
  // Who may pick an identity anew: active ones, and staff also those not open to the public.
  const selectable = (item) => item.is_active && (staff || item.public_selectable);

  function priceText(activity) {
    if (activity.activity_identity_prices) {
      // Prices of identities nobody can pick anew are left out; 一般 is named only beside another price.
      const others = activity.activity_identity_prices
        .filter((price) => identities.some((item) => item.code === price.identity_code && selectable(item)))
        .map((price) => `${identityLabels[price.identity_code]} NT$${price.fee_amount}／人`);
      if (activity.fee_amount == null) return others.join("，");
      return [`${identityLabels.general} NT$${activity.fee_amount}／人`, ...others].join("，");
    }
    const prices = [];
    if (activity.fee_amount != null) prices.push(`${hasStudentPrice(activity) ? "一般 " : ""}NT$${activity.fee_amount}／人`);
    if (hasStudentPrice(activity)) prices.push(`學生 NT$${activity.student_fee_amount}／人`);
    return prices.join("，");
  }
  function feeText(activity) {
    const prices = priceText(activity);
    return prices && `負擔費用：${prices}`;
  }

  // The public page links only http(s) map URLs; the back office warns about any other value.
  const mapUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  };

  const radio = (container, activity, value) =>
    container.querySelector(`[name="activity_${activity.id}"][value="${value}"]`);
  const choiceOf = (container, activity) => {
    const value = container.querySelector(`[name="activity_${activity.id}"]:checked`)?.value;
    return value === undefined ? null : value === "true";
  };

  // Adds the audience notes to activity fields just rendered in container;
  // each activity's wrapper carries data-activity="<id>". All text is set as text, never as markup.
  function render(container, activities) {
    for (const activity of activities) {
      const wrapper = container.querySelector(`[data-activity="${activity.id}"]`);
      if (!wrapper || !activity.audience || activity.audience === "all") continue;
      const reverted = document.createElement("p");
      reverted.className = "hint audience-reverted";
      reverted.textContent = revertedNote;
      reverted.hidden = true;
      // On the public page the note sits to the right of 參加／不參加 (wrapping below on narrow screens);
      // the back office has no options row, so it stays on its own line there.
      if (activity.audience_note?.trim()) {
        const note = document.createElement("p");
        note.className = "hint audience-note";
        note.textContent = activity.audience_note;
        (wrapper.querySelector(".activity-options") ?? wrapper).append(note);
      }
      wrapper.append(reverted);
    }
  }

  // Restricted activities become 不參加 and locked outside their audience.
  // Read choices() since FormData leaves disabled controls out.
  // A 參加 reverted here comes back if the answer becomes eligible again on the same screen.
  function sync(container, activities, context = {}) {
    // A prerequisite can appear after its dependent activity. Repeat until the choices settle.
    for (let pass = 0; pass <= activities.length; pass++) {
      let changed = false;
      for (const activity of activities) {
        if (!activity.audience || activity.audience === "all") continue;
        const yes = radio(container, activity, "true");
        const no = radio(container, activity, "false");
        if (!yes || !no) continue;
        const wasYes = yes.checked;
        const allowed = eligible(activity, { ...context, activities, choices: choices(container, activities) });
        const note = container.querySelector(`[data-activity="${activity.id}"] .audience-reverted`);
        if (!allowed && yes.checked) yes.dataset.reverted = "";
        if (allowed && yes.dataset.reverted !== undefined) {
          if (no.checked) yes.checked = true;
          delete yes.dataset.reverted;
        }
        if (note) note.hidden = yes.dataset.reverted === undefined;
        // A required question gets 不參加 so the form can be sent; an optional one left 未回覆 (an older
        // registration in the back office) stays unanswered, so saving it changes nothing.
        if (!allowed && (yes.checked || yes.required)) no.checked = true;
        yes.disabled = no.disabled = !allowed;
        if (yes.checked !== wasYes) changed = true;
      }
      if (!changed) break;
    }
  }

  // Answered activities only; an unanswered one is left out.
  const choices = (container, activities) => activities
    .map((activity) => ({ activity_id: activity.id, attending: choiceOf(container, activity) }))
    .filter((choice) => choice.attending !== null);

  // The form's 身分別; null while 請選擇.
  const readIdentity = (form) => form.elements.meal_identity.value || null;
  const childType = (identity) => identity === "preschool" ? "preschool" : identity === "child" ? "elementary" : "";
  // Only 一般 answers 開家接待 and 接機接待; the server stores 否 for anyone else (decided 2026-11-10).
  const answersHosting = (identity) => identity === "general";
  // 身分別 options: new picks follow selectable(); the stored identity stays even when stopped or staff-only.
  function renderIdentity(select, stored = null) {
    const current = stored ?? select.value;
    select.replaceChildren(new Option("請選擇", ""));
    for (const item of identities.filter((item) => item.code === current || selectable(item))) {
      select.add(new Option(item.name, item.code));
    }
    select.value = current || "";
  }
  // The list's 身分別 filter: fixed order first, then custom ones; a stopped identity only while registrations use it.
  function renderIdentityFilter(select, usedCodes = []) {
    const current = select.value;
    select.replaceChildren(new Option("全部身分", ""));
    const add = (code) => {
      const item = identities.find((item) => item.code === code);
      if (item && (item.is_active || usedCodes.includes(code))) select.add(new Option(item.name + (item.is_active ? "" : "（已停用）"), code));
    };
    add("general"); add("student");
    select.add(new Option("全部兒童", "all_children"));
    add("child"); add("preschool");
    for (const item of identities) if (!["general", "student", "child", "preschool"].includes(item.code)) add(item.code);
    select.value = current;
  }

  const taipeiDateTime = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return {
      day: `${parts.year}-${parts.month}-${parts.day}`,
      date: `${Number(parts.month)}/${Number(parts.day)}`,
      time: `${parts.hour}:${parts.minute}`,
    };
  };

  // The 時間 line as the public page shows it; the back office's activity details show the same text.
  function activityTime(activity) {
    const start = taipeiDateTime(activity.starts_at);
    if (!start) return "";
    const startText = activity.starts_at_has_time === false ? start.date : `${start.date} ${start.time}`;
    const end = taipeiDateTime(activity.ends_at);
    if (!end) return startText;
    if (end.day === start.day && activity.starts_at_has_time === false && activity.ends_at_has_time === false) {
      return startText;
    }
    const bothTimesOnSameDay = end.day === start.day
      && activity.starts_at_has_time !== false && activity.ends_at_has_time !== false;
    const endText = bothTimesOnSameDay ? end.time
      : (activity.ends_at_has_time === false ? end.date : `${end.date} ${end.time}`);
    return `${startText}–${endText}`;
  }

  // How many restricted activities sync() turned from 參加 into 不參加 in this container.
  const revertedCount = (container) => container.querySelectorAll("input[data-reverted]").length;

  return {
    configure, identityLabels, childType, answersHosting, renderIdentity, renderIdentityFilter, hasStudentPrice, eligible, fee, addFees, needsIdentity, priceText, feeText, mapUrl, activityTime,
    render, sync, choices, readIdentity, revertedCount,
  };
})();
