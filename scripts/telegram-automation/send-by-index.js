// One-off: like send-to-topic.js but targets a sidebar row by index rather than text substring -
// needed once several topics share an identical last-message preview.
// Usage: node send-by-index.js <row index> "<text>" [waitRounds]
const { connect, openGroup, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const index = Number(process.argv[2]);
const text = process.argv[3];
const waitRounds = Number(process.argv[4] ?? 6);
if (Number.isNaN(index) || !text) {
  console.error('usage: node send-by-index.js <row index> "<text>" [waitRounds]');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await page.waitForTimeout(1000);
  await page.locator(".chatlist-chat").nth(index).click({ force: true });
  await page.waitForTimeout(1500);

  const before = await getMessageCount(page);
  await sendMessage(page, text);
  log(`sent: ${text}`);

  let texts = [];
  for (let i = 0; i < waitRounds; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= before) continue;
    texts = await getMessageTexts(page, total - before);
    break;
  }
  log(`response: ${texts.join(" | ") || "(none within timeout)"}`);
  await context.close();
})();
