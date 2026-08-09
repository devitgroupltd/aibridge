// One-off: sends a benign message into a session's own topic, then polls message count/texts
// every 500ms for ~20s, logging a timestamp each time new messages appear - to see exactly when
// (if ever) the "🤔 Thinking..." placeholder shows up relative to the send.
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

const [topicSubstring, message] = process.argv.slice(2);

function ts() {
  return new Date().toISOString().slice(11, 23);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  const before = await getMessageCount(page);
  const sendStart = Date.now();
  await sendMessage(page, message);
  console.error(`[${ts()}] sent (t=0ms): ${message}`);

  let lastCount = before;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    const total = await getMessageCount(page);
    if (total > lastCount) {
      const texts = await getMessageTexts(page, total - lastCount);
      console.error(`[${ts()}] (t=${Date.now() - sendStart}ms) new message(s): ${JSON.stringify(texts)}`);
      lastCount = total;
    }
  }

  await context.close();
})();
