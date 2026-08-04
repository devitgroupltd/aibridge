// Reads the last N messages from a session's own topic (not the control topic) - useful for
// checking on a fleet session's progress without touching it. Matching is a topic-name substring
// since that's all the sidebar exposes; slugs and topic titles diverge once a title is renamed.
//
// Usage: node check-topic.js "<topic name substring>" [count]
const { connect, openGroup, openTopic, getMessageTexts } = require("./client.js");
const path = require("path");

const topicSubstring = process.argv[2];
const count = Number(process.argv[3] || 10);
if (!topicSubstring) {
  console.error('usage: node check-topic.js "<topic name substring>" [count]');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);
  await page.waitForTimeout(1500);
  const texts = await getMessageTexts(page, count);
  console.log(JSON.stringify(texts, null, 2));
  await page.screenshot({ path: path.join(__dirname, "check-topic.png") });
  await context.close();
})();
