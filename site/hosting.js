// 開家接待 fields, shared by the public page and the back office. The markup is static (no user
// data), so it is safe to set as innerHTML; answers are filled in through input values.
const Hosting = (() => {
  const statusLabels = { hosting: "是", not_hosting: "否", family_registered: "家人已登記開家接待" };
  const guestLabels = { couple: "夫婦", brother: "弟兄", sister: "姊妹", any: "不拘" };
  const placeholder = '<option value="">請選擇</option>';

  // The question is labelled by id, so a screen reader reads it once; each container has its own id.
  const markup = (id) => `
    <p class="hosting-question" id="${id}-question">是否可以開家接待？</p>
    <div class="hosting-options" role="radiogroup" aria-labelledby="${id}-question">
      ${Object.entries(statusLabels).map(([value, text]) =>
        `<label><input type="radio" name="hosting_status" value="${value}">${text}</label>`).join("")}
    </div>
    <div class="hosting-details" hidden>
      <label>可以接待幾位？<select name="guest_count" required>${placeholder}
        ${Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">${index + 1} 位</option>`).join("")}
      </select></label>
      <label>接待對象<select name="guest_type" required>${placeholder}
        ${Object.entries(guestLabels).map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}
      </select></label>
    </div>
    `;

  function normalize(value) {
    if (!value?.status) return null;
    const hosting = value.status === "hosting";
    return {
      status: value.status,
      guest_type: hosting ? value.guest_type || null : null,
      guest_count: hosting && value.guest_count ? Number(value.guest_count) : null,
      ...(value.answer_valid === false && { answer_valid: false }),
    };
  }

  function summary(value) {
    const answer = normalize(value);
    if (!answer) return "未回覆";
    let hosting = statusLabels[answer.status];
    if (answer.status === "hosting") hosting = `是，可接待 ${answer.guest_count} 位（${guestLabels[answer.guest_type]}）`;
    return answer.answer_valid === false ? `未回覆（先前紀錄：${hosting}，須重新回答）` : hosting;
  }

  // Shows the guest dropdowns (.hosting-details) only for 是; hidden ones are disabled so they neither
  // block the form's required checks nor get sent. The pickup dropdown always shows.
  function sync(container) {
    const details = container.querySelector(".hosting-details");
    const status = container.querySelector('[name="hosting_status"]:checked')?.value;
    const hosting = status === "hosting";
    details.hidden = !hosting;
    details.querySelectorAll("select").forEach((select) => { select.disabled = !hosting; });
  }

  // required: a new answer must be given; an existing unanswered registration in the back office may stay 未回覆.
  function render(container, value = null, required = true) {
    container.innerHTML = markup(container.id);
    container.dataset.hosting = "";
    const answer = value?.answer_valid === false ? null : normalize(value);
    for (const radio of container.querySelectorAll('[name="hosting_status"]')) {
      radio.required = required;
      radio.checked = radio.value === answer?.status;
    }
    container.querySelector('[name="guest_count"]').value = answer?.guest_count ?? "";
    container.querySelector('[name="guest_type"]').value = answer?.guest_type ?? "";
    sync(container);
  }

  function read(container) {
    const value = (name) => container.querySelector(`[name="${name}"]`)?.value;
    return normalize({
      status: container.querySelector('[name="hosting_status"]:checked')?.value,
      guest_type: value("guest_type"),
      guest_count: value("guest_count"),
    });
  }

  // Capture runs before the page's own listeners, so they already see the synced fields.
  // "input" also fires for radio buttons and selects, so no "change" listener is needed.
  document.addEventListener("input", (event) => {
    const container = event.target.closest?.("[data-hosting]");
    if (container) sync(container);
  }, true);

  return { statusLabels, guestLabels, normalize, summary, render, read, sync };
})();
