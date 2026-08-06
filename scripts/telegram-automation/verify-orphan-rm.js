// One-off (§4.5.2 live verification, not permanent): open an orphaned topic (no session row),
// send a bare /rm, and capture whatever the Bridge replies - confirms the new orphan-topic
// reconciliation branch in handleRmCommand actually fires instead of the old "usage: ..." error.
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2];
if (!topicSubstring) {
  console.error('usage: node verify-orphan-rm.js "<topic name substring>"');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);
  await page.waitForTimeout(2500); // extra settle time past openTopic's own 1500ms

  const before = await getMessageCount(page);
  log(`before count: ${before}`);
  await sendMessage(page, "/rm");
  log("sent literal /rm");

  let texts = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total > before) {
      texts = await getMessageTexts(page, total - before);
      break;
    }
  }
  log(`new messages: ${JSON.stringify(texts)}`);
  await page.screenshot({ path: "verify-orphan-rm.png" });
  await context.close();
})();
