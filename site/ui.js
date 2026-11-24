// Confirmation dialog and scroll motion, shared by the public page and the back office.
const Ui = (() => {
  let dialog;

  // A modal <dialog> instead of confirm(): its button says what happens, Cancel takes the first focus,
  // and Firefox's "prevent additional dialogs" box cannot turn a confirmation into a silent no.
  // Esc and the back gesture close it as Cancel. Resolves true only for the confirm button.
  function confirm(text, confirmLabel = "確定") {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog";
      // As confirm() is: a question the person must answer before going on.
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-labelledby", "confirm-dialog-text");
      // Static markup only; the question goes in through textContent below.
      dialog.innerHTML = `<form method="dialog"><p id="confirm-dialog-text"></p>
        <div class="confirm-dialog-buttons"><button value="cancel" class="secondary" autofocus>取消</button><button value="confirm"></button></div></form>`;
      document.body.append(dialog);
    }
    dialog.querySelector("p").textContent = text;
    dialog.querySelector('[value="confirm"]').textContent = confirmLabel;
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      // Esc sets no value, and browsers differ on clearing the last one.
      dialog.returnValue = "";
    }, { once: true }));
  }

  // Smooth scrolling only for people who have not asked their system for less motion.
  const scrollBehavior = () => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

  return { confirm, scrollBehavior };
})();
