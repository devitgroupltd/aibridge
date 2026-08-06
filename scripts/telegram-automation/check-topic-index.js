// One-off: same as check-topic.js but opens by row index in the left sidebar's chatlist rather
// than a text substring - needed when two topics currently share an identical last-message
// preview (both show "You: /rm" after this same live-verification), which check-topic.js's
// substring match can no longer disambiguate.
// Usage: node check-topic-index.js <row index> [count]
const { connect, openGroup, getMessageTexts } = require("./client.js");

const index = Number(process.argv[2]);
const count = Number(process.argv[3] || 10);
if (Number.isNaN(index)) {
  console.error("usage: node check-topic-index.js <row index> [count]");
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await page.waitForTimeout(1000);
  await page.locator(".chatlist-chat").nth(index).click({ force: true });
  await page.waitForTimeout(1500);
  const texts = await getMessageTexts(page, count);
  console.log(JSON.stringify(texts, null, 2));
  await context.close();
})();
