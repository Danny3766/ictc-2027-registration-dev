// 用餐身分（學生價）、報名對象，以及活動的時間、費用與地圖連結文字, shared by the public page and the
// back office. The database applies the same rules (registration_meal_identity,
// registration_audience_valid); this only keeps the form in step.
const Meals = (() => {
  const identityLabels = { general: "一般", student: "學生" };
  const revertedNote = "不符報名對象，已改為不參加。";
  // 是 and 家人已登記開家接待 both count as a hosting household.
  const hostingStatuses = ["hosting", "family_registered"];

  const hasStudentPrice = (activity) => activity.student_fee_amount != null;
  const eligible = (activity, context = {}) => {
    const audience = activity.audience ?? "all";
    if (audience === "all") return true;
    // 兒童 answer neither survey and are outside both audiences (decided 2026-11-09).
    if (audience === "hosting") return Boolean(context.isChild) || hostingStatuses.includes(context.hostingStatus);
    if (audience === "pickup") return Boolean(context.isChild) || context.pickupStatus === "yes";
    if (!audience.startsWith("activity:")) return false;
    const requiredId = Number(audience.slice(9));
    const prerequisite = context.activities?.find((item) => item.id === requiredId);
    return Boolean(prerequisite && prerequisite.is_published !== false
      && context.choices?.some((choice) => choice.activity_id === requiredId && choice.attending));
  };
  // Without an answered identity the general price applies, like the back-office estimate.
  const fee = (activity, identity) =>
    (identity === "student" && hasStudentPrice(activity) ? activity.student_fee_amount : activity.fee_amount) ?? 0;
  const needsIdentity = (activities, choices) => choices.some((choice) => choice.attending
    && activities.some((activity) => activity.id === choice.activity_id && hasStudentPrice(activity)));

  function priceText(activity) {
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

  // Adds the audience notes and the identity question to activity fields just rendered in container;
  // each activity's wrapper carries data-activity="<id>". All text is set as text, never as markup.
  function render(container, activities, identity = null) {
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
    if (!activities.some(hasStudentPrice)) return;
    const block = document.createElement("div");
    block.className = "activity meal-identity";
    block.hidden = true;
    const title = document.createElement("strong");
    title.textContent = "用餐身分";
    const options = document.createElement("div");
    options.className = "activity-options";
    options.setAttribute("role", "radiogroup");
    options.setAttribute("aria-label", "用餐身分");
    for (const [value, text] of Object.entries(identityLabels)) {
      const option = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "meal_identity";
      input.value = value;
      input.checked = value === identity;
      option.append(input, text);
      options.append(option);
    }
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "勾選的用餐有學生價，請選擇身分。";
    block.append(title, options, hint);
    container.append(block);
  }

  // Applies the current audience answers: a restricted activity is
  // 不參加 and locked outside its audience, and the identity question shows, required, only while a
  // student-priced activity is attended. Hidden or locked fields are disabled, so the form's own checks
  // skip them; read choices with choices() below, since FormData leaves disabled fields out.
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
    const block = container.querySelector(".meal-identity");
    if (!block) return;
    const needed = needsIdentity(activities, choices(container, activities));
    block.hidden = !needed;
    for (const input of block.querySelectorAll("input")) {
      input.disabled = !needed;
      input.required = needed;
    }
  }

  // Answered activities only; an unanswered one is left out.
  const choices = (container, activities) => activities
    .map((activity) => ({ activity_id: activity.id, attending: choiceOf(container, activity) }))
    .filter((choice) => choice.attending !== null);

  // null while the question is hidden: no student-priced activity is attended.
  const readIdentity = (container) =>
    container.querySelector('[name="meal_identity"]:checked:not(:disabled)')?.value ?? null;

  // A stored identity counts only while the choices still need one: after an admin removes a student
  // price or unpublishes the meal, the old value stays in the database until the next save.
  const identityFor = (activities, choices, identity) =>
    identity && needsIdentity(activities, choices) ? identity : null;

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
    identityLabels, hasStudentPrice, eligible, fee, needsIdentity, identityFor, priceText, feeText, mapUrl, activityTime,
    render, sync, choices, readIdentity, revertedCount,
  };
})();
