// Taps a reply-keyboard button on the last message bubble whose text matches `buttonText`.
// Usage: node tap-button.js "<button text>"
const { connect, openGroup, openTopic } = require("./client.js");

function log(msg) { console.error(`[${new Date().toISOString()}] ${msg}`); }

(async () => {
  const buttonText = process.argv[2];
  if (!buttonText) {
    console.error('usage: node tap-button.js "<button text>"');
    process.exit(1);
  }
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");
  await page.waitForTimeout(1000);

  const button = page.locator(".reply-markup-button", { hasText: buttonText }).last();
  await button.waitFor({ state: "visible", timeout: 10000 });
  await button.click({ force: true });
  log(`clicked button: ${buttonText}`);
  await page.waitForTimeout(3000);

  await context.close();
})();
