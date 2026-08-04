// Taps a reply-keyboard button in an arbitrary topic (not just General).
// Usage: node tap-topic-button.js "<topic name substring>" "<button text>"
const { connect, openGroup, openTopic } = require("./client.js");

function log(msg) { console.error(`[${new Date().toISOString()}] ${msg}`); }

(async () => {
  const topicName = process.argv[2];
  const buttonText = process.argv[3];
  if (!topicName || !buttonText) {
    console.error('usage: node tap-topic-button.js "<topic name substring>" "<button text>"');
    process.exit(1);
  }
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicName);
  await page.waitForTimeout(1000);

  const button = page.locator(".reply-markup-button", { hasText: buttonText }).last();
  await button.waitFor({ state: "visible", timeout: 10000 });
  await button.click({ force: true });
  log(`clicked button "${buttonText}" in topic "${topicName}"`);
  await page.waitForTimeout(3000);

  await context.close();
})();
