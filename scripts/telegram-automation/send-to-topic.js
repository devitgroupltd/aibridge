// Sends a message into a named session topic (not the control topic) and prints whatever new
// messages arrive - send-command.js only targets "General"/the control topic, and check-topic.js
// only reads, so this covers the gap of driving a session's own topic directly.
//
// Usage: node send-to-topic.js "<topic substring>" "<message>"
const { connect, openGroup, openTopic, sendMessage, getMaxMessageId, waitForMessagesAfter, unmangleMsysPath } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

// The message is unmangled too, not just the topic: a session topic accepts `/help`, `/commands`,
// `/<skill>` and so on, so this script hits the same Git Bash path-translation trap send-command.js
// does - see `unmangleMsysPath`.
const [topicSubstring, message] = process.argv.slice(2).map((a) => (a === undefined ? a : unmangleMsysPath(a)));
if (!topicSubstring || !message) {
  console.error('usage: node send-to-topic.js "<topic substring>" "<message>"');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  // Keyed on the highest message id, never on a bubble count. Web K prunes bubbles that scroll out
  // of view, so the count can *fall* while a reply lands (measured 35 -> 36 -> 32), which makes
  // `total <= before` skip the very message it was waiting for and report "(none within timeout)"
  // for a reply that did arrive. This script was the last one in the rig still using the count
  // baseline that CLAUDE.md already documents as forbidden - the same pattern had left check 6's
  // permission half measuring nothing while printing a verdict on every run.
  const afterMid = await getMaxMessageId(page);
  await sendMessage(page, message);
  log(`sent: ${message}`);

  // `match` skips the echo of the message itself, which always renders first - otherwise the
  // "response" is just what was typed.
  const texts = await waitForMessagesAfter(page, afterMid, {
    rounds: 20,
    intervalMs: 2000,
    match: (t) => !t.startsWith(message),
  });
  log(`response: ${texts.join(" | ") || "(none within timeout)"}`);

  await context.close();
  console.log(JSON.stringify(texts, null, 2));
})();
