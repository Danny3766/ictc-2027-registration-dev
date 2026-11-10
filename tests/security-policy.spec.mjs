import { expect, test } from "@playwright/test";

for (const path of ["/", "/success.html", "/admin/"]) {
  test(`security policies allow normal loading of ${path}`, async ({ page, browserName }) => {
    await page.addInitScript(() => {
      window.policyViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.policyViolations.push({
          directive: event.effectiveDirective, source: event.sourceFile,
          line: event.lineNumber, sample: event.sample, blocked: event.blockedURI,
        });
      });
      sessionStorage.setItem("registration_success", JSON.stringify({
        full_name: "測試登記", district_name: "測試區", choices: [],
      }));
    });
    await page.route("**/functions/v1/registration", (route) =>
      route.fulfill({ json: {
        settings: { event_name: "測試活動", is_registration_open: false },
        districts: [], activities: [], program: [], identities: [],
      } }));
    await page.goto(path);
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      "content", /script-src 'self'.*connect-src 'self' https:\/\/\*\.supabase\.co/);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content", "strict-origin-when-cross-origin");
    await expect.poll(() => page.evaluate((webkit) => {
      // WebKit flags each <select>'s own shadow styles once (microsoft/playwright#43497); any extra violation is ours.
      const known = webkit ? document.querySelectorAll("select").length : 0;
      const violations = window.policyViolations;
      return violations.length === known && violations.every((v) => v.directive === "style-src-attr") ? [] : violations;
    }, browserName === "webkit")).toEqual([]);
  });
}
