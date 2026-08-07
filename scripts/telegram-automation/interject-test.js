// One-off: live-verify the feed-interjection-repost fix. Sends a task message into a topic, waits
// a few seconds while it's working, sends a second "interjection" message, then reads back the
// topic to see whether the feed card reposted as a new message after the interjection rather than
// continuing to edit at its original position. Not a permanent tool - CLAUDE.md's "write a small
// one-off script" guidance.
//
// Usage: node interject-test.js "<topic name substring>" "<task prompt>" "<interjection text>"
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2];
const taskPrompt = process.argv[3];
const interjection = process.argv[4];

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  const before = await getMessageCount(page);
  await sendMessage(page, taskPrompt);
  log(`sent task: ${taskPrompt}`);

  await page.waitForTimeout(4000);
  await sendMessage(page, interjection);
  log(`sent interjection: ${interjection}`);

  await page.waitForTimeout(15000);
  const total = await getMessageCount(page);
  const texts = await getMessageTexts(page, total - before);
  console.log(JSON.stringify(texts, null, 2));

  await context.close();
})();
