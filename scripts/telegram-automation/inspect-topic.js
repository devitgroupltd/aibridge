// Dumps raw HTML of the last N chat bubbles in an arbitrary topic (not just General).
// Usage: node inspect-topic.js "<topic name substring>" [n]
const { connect, openGroup, openTopic } = require("./client.js");

(async () => {
  const topicName = process.argv[2];
  if (!topicName) {
    console.error('usage: node inspect-topic.js "<topic name substring>" [n]');
    process.exit(1);
  }
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicName);
  await page.waitForTimeout(1000);
  const bubbles = page.locator(".bubble");
  const count = await bubbles.count();
  const n = Number(process.argv[3] ?? 1);
  for (let i = Math.max(0, count - n); i < count; i++) {
    console.log(`--- bubble ${i} ---`);
    console.log(await bubbles.nth(i).innerHTML());
  }
  await context.close();
})();
