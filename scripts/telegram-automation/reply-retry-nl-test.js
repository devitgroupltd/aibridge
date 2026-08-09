// One-off: live-verify nl-router.ts's new kind='retry' (any-language natural phrasing that
// isRetryPhrase's exact-match regex was never going to catch). Sends a fresh baseline command
// (/ls), replies to it with a full-sentence retry request instead of the bare word, and confirms
// a second /ls-style reply appears - proof the AI-matched retry path (nl-dispatch.ts's
// onRetryMatch) re-ran that exact message's text through dispatch, same as the regex fast-path.
//
// Usage: node reply-retry-nl-test.js "<topic name substring>"
const { connect, openGroup, openTopic, getMessageCount, getMessageTexts } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2] || "General";

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);
  await page.waitForTimeout(1000);

  const composer = page.locator('div[contenteditable="true"][data-peer-id]');
  await composer.click();
  await composer.type("/ls");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  log("sent baseline: /ls");

  const bubble = page.locator(".bubble-content .translatable-message, .bubble .message", { hasText: "/ls" }).last();
  await bubble.scrollIntoViewIfNeeded();
  await bubble.click({ button: "right", force: true });

  let replyBox = null;
  for (let i = 0; i < 10 && !replyBox; i++) {
    const candidate = page.getByText("Reply", { exact: true }).last();
    replyBox = await candidate.boundingBox().catch(() => null);
    if (!replyBox) await page.waitForTimeout(300);
  }
  if (!replyBox) throw new Error('context menu\'s "Reply" item never got a bounding box - menu likely did not open');
  await page.mouse.click(replyBox.x + replyBox.width / 2, replyBox.y + replyBox.height / 2);
  await page.waitForTimeout(800);
  log("clicked Reply");

  const before = await getMessageCount(page);
  const phrase = "Retry again as you already could handle such messages";
  await composer.click();
  await composer.type(phrase);
  await page.keyboard.press("Enter");
  log(`sent as a reply: "${phrase}"`);

  await page.waitForTimeout(6000);
  const texts = await getMessageTexts(page, before + 4);
  console.log(JSON.stringify(texts, null, 2));
  await context.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
