// One-off: send a plain (non-command) message into a session's own topic and read back the
// reply. Used to live-verify dispatchInboundMessage's final passthrough branch (sendChannelText)
// after the §7.4 stale-inbound extraction refactor - not a permanent part of the toolkit, kept
// here anyway per CLAUDE.md's "write a small one-off script in this folder" guidance.
//
// Usage: node send-session-message.js "<topic name substring>" "<message text>"
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2];
const text = process.argv[3];
if (!topicSubstring || !text) {
  console.error('usage: node send-session-message.js "<topic name substring>" "<message text>"');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  const before = await getMessageCount(page);
  await sendMessage(page, text);
  log(`sent: ${text}`);

  let texts = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= before) continue;
    texts = await getMessageTexts(page, total - before);
    break;
  }
  log(`response: ${texts.join(" | ") || "(none within timeout)"}`);
  await context.close();
})();
