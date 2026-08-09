// Sends a message into a named session topic (not the control topic) and prints whatever new
// messages arrive - send-command.js only targets "General"/the control topic, and check-topic.js
// only reads, so this covers the gap of driving a session's own topic directly.
//
// Usage: node send-to-topic.js "<topic substring>" "<message>"
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const [topicSubstring, message] = process.argv.slice(2);
if (!topicSubstring || !message) {
  console.error('usage: node send-to-topic.js "<topic substring>" "<message>"');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  const before = await getMessageCount(page);
  await sendMessage(page, message);
  log(`sent: ${message}`);

  let texts = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= before) continue;
    texts = await getMessageTexts(page, total - before);
    break;
  }
  log(`response: ${texts.join(" | ") || "(none within timeout)"}`);

  await context.close();
  console.log(JSON.stringify(texts, null, 2));
})();
