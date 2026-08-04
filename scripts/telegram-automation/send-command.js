// Sends one or more control-topic commands (/new, /rm, /ls, /budget, ...) as the logged-in
// operator and prints whatever new messages arrive in response. Generic on purpose - it doesn't
// special-case any one command's reply format (e.g. parsing `/new`'s `Created "..."` line out of
// the response is the caller's job), so it covers every control command with one script.
//
// Usage: node send-command.js "<command 1>" ["<command 2>" ...]
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

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
    const before = await getMessageCount(page);
    await sendMessage(page, command);
    log(`sent: ${command}`);

    let texts = [];
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(2000);
      const total = await getMessageCount(page);
      if (total <= before) continue;
      texts = await getMessageTexts(page, total - before);
      break;
    }
    log(`response: ${texts.join(" | ") || "(none within timeout)"}`);
    results.push({ command, response: texts });
  }

  await context.close();
  console.log(JSON.stringify(results, null, 2));
})();
