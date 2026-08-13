// Sends one or more control-topic commands (/new, /rm, /ls, /budget, ...) as the logged-in
// operator and prints whatever new messages arrive in response. Generic on purpose - it doesn't
// special-case any one command's reply format (e.g. parsing `/new`'s `Created "..."` line out of
// the response is the caller's job), so it covers every control command with one script.
//
// Usage: node send-command.js "<command 1>" ["<command 2>" ...]
const { connect, openGroup, openTopic, sendMessage, getMaxMessageId, waitForMessagesAfter } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const commands = process.argv.slice(2);
if (commands.length === 0) {
  console.error('usage: node send-command.js "<command 1>" ["<command 2>" ...]');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");

  const results = [];
  for (const command of commands) {
    // Keyed on the highest message id, not the rendered bubble count - see `getMaxMessageId`'s doc
    // comment for the three false "(none within timeout)" readings the count baseline produced on
    // 2026-08-13 against commands the Bridge had already executed and answered.
    const afterMid = await getMaxMessageId(page);
    await sendMessage(page, command);
    log(`sent: ${command}`);

    // `match` skips the echo of the command itself, which always renders first - without it this
    // returns a "response" consisting solely of what was just typed.
    const texts = await waitForMessagesAfter(page, afterMid, {
      rounds: 20,
      intervalMs: 2000,
      match: (t) => !t.startsWith(command),
    });
    log(`response: ${texts.join(" | ") || "(none within timeout)"}`);
    results.push({ command, response: texts });
  }

  await context.close();
  console.log(JSON.stringify(results, null, 2));
})();
