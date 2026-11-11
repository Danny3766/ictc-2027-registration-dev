// 接機接待 is independent of 開家接待; both forms use the same field renderer.
const Pickup = (() => {
  const labels = { yes: "是", no: "否" };

  function normalize(value) {
    if (!value?.status) return null;
    return { status: value.status, count: value.status === "yes" ? Number(value.count) : 0,
      ...(value.answer_valid === false && { answer_valid: false }) };
  }

  function summary(value) {
    const answer = normalize(value);
    const text = !answer ? "未回覆" : answer.status === "yes" ? `是，可接機 ${answer.count} 位` : "否";
    return answer?.answer_valid === false ? `未回覆（先前紀錄：${text}，須重新回答）` : text;
  }

  function sync(container) {
    const yes = container.querySelector('[name="pickup_status"]:checked')?.value === "yes";
    const details = container.querySelector(".pickup-details");
    details.hidden = !yes;
    details.querySelector("select").disabled = !yes;
  }

  function render(container, value = null, required = true) {
    container.innerHTML = `<p class="hosting-question pickup-question" id="${container.id}-question">2/19 或之前可以配搭接機幾位？</p>
      <div class="hosting-options" role="radiogroup" aria-labelledby="${container.id}-question">
        <label><input type="radio" name="pickup_status" value="yes">是</label>
        <label><input type="radio" name="pickup_status" value="no">否</label>
      </div>
      <label class="pickup-details" hidden>可以接機幾位？<select name="pickup_count" required>
        <option value="">請選擇</option>
        ${Array.from({ length: 6 }, (_, index) => `<option value="${index + 1}">${index + 1} 位</option>`).join("")}
      </select></label>
      <p class="hint">同一台車只需一人填寫，避免重複計算。</p>`;
    container.dataset.pickup = "";
    const answer = value?.answer_valid === false ? null : normalize(value);
    for (const radio of container.querySelectorAll('[name="pickup_status"]')) {
      radio.required = required;
      radio.checked = radio.value === answer?.status;
    }
    container.querySelector('[name="pickup_count"]').value = answer?.status === "yes" ? answer.count : "";
    sync(container);
  }

  function read(container) {
    return normalize({
      status: container.querySelector('[name="pickup_status"]:checked')?.value,
      count: container.querySelector('[name="pickup_count"]')?.value,
    });
  }

  document.addEventListener("input", (event) => {
    const container = event.target.closest?.("[data-pickup]");
    if (container) sync(container);
  }, true);

  return { labels, normalize, summary, render, read, sync };
})();
