// One-off: send a prompt into a specific session's own topic (not the control topic) and read
// back what it does with it. Live-verifies §5.8's send_file/outbox path (screenshot -> outbox ->
// send_file -> Telegram photo/document) - not a permanent part of the toolkit, kept here per
// CLAUDE.md's "write a small one-off script" guidance.
//
// Usage: node send-to-topic.js "<topic name substring>" "<prompt>" [waitRounds]
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2];
const prompt = process.argv[3];
const waitRounds = Number(process.argv[4] ?? 40);
if (!topicSubstring || !prompt) {
  console.error('usage: node send-to-topic.js "<topic name substring>" "<prompt>" [waitRounds]');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  const before = await getMessageCount(page);
  await sendMessage(page, prompt);
  log(`sent: ${prompt}`);

  let texts = [];
  for (let i = 0; i < waitRounds; i++) {
    await page.waitForTimeout(3000);
    const total = await getMessageCount(page);
    if (total <= before) continue;
    texts = await getMessageTexts(page, total - before);
    break;
  }
  log(`response: ${texts.join(" | ") || "(none within timeout)"}`);
  await context.close();
})();
