// One-time interactive login, run manually: `node login.js`, scan the QR code in the window
// that opens, then Ctrl+C once status.txt says logged_in. After that, every other script in this
// directory reuses the same persisted `profile/` (a real Chromium user-data dir - launchPersistentContext
// refuses a second concurrent browser against it, so don't run this alongside another script).
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const USER_DATA_DIR = path.join(__dirname, "profile");
const SCREENSHOT_PATH = path.join(__dirname, "screenshot.png");
const STATUS_PATH = path.join(__dirname, "status.txt");

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded" });

  // Loops taking a fresh screenshot every 2s and writing a simple status marker, so a separate
  // process (an agent, via its file-read tool) can just poll screenshot.png/status.txt on disk
  // without ever launching a second browser against the same profile.
  for (;;) {
    await page.waitForTimeout(2000);
    try {
      await page.screenshot({ path: SCREENSHOT_PATH });
      const loggedIn = await page.locator('[class*="sidebar-header"], .chatlist').first().isVisible().catch(() => false);
      fs.writeFileSync(STATUS_PATH, loggedIn ? "logged_in" : "waiting_for_login");
    } catch (err) {
      fs.writeFileSync(STATUS_PATH, `error: ${err.message}`);
    }
  }
})();
