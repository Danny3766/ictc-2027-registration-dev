import { expect } from "@playwright/test";

// The open confirmation <dialog> from site/ui.js.
export const confirmDialog = (page) => page.locator("dialog.confirm-dialog[open]");

// Answers the confirmation the last action opened and returns its question.
export async function answerConfirm(page, accept = true) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  const question = await dialog.locator("p").textContent();
  await dialog.locator(`button[value="${accept ? "confirm" : "cancel"}"]`).click();
  await expect(dialog).toHaveCount(0);
  return question;
}
