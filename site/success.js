let data = null;
try { data = JSON.parse(sessionStorage.getItem("registration_success") ?? "null"); } catch { data = null; }

// The banner text lives here, not in the HTML, so link previews (LINE) never pick it up on the real site.
if (window.APP_CONFIG?.environment === "test") Object.assign(document.querySelector("#test-banner"), { textContent: "測試站｜請勿填寫正式登記資料", hidden: false });

if (!data?.full_name) {
  location.replace("./index.html");
} else {
  document.querySelector("#summary-identity").textContent = `${data.full_name}｜${data.district}`;
  document.querySelector("#summary-choices").replaceChildren(...data.choices.map((choice) => {
    const item = document.createElement("li");
    item.textContent = `${choice.title}：${choice.attending ? "參加" : "不參加"}`;
    return item;
  }));
  // Older saved summaries have no hosting line; the registration page only adds one while hosting is open.
  for (const line of [data.meal_identity, data.hosting, data.pickup].filter(Boolean)) {
    const item = document.createElement("li");
    item.textContent = line;
    document.querySelector("#summary-choices").append(item);
  }
}
