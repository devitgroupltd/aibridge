// One-off: live-verify the reply-to-retry feature (command-dispatch.ts's isRetryPhrase branch +
// inbound-media.ts's reply_to_message threading). Sends a fresh, harmless baseline command (/ls),
// replies to it with "retry", and confirms a second /ls-style reply appears - proof the retry
// mechanism re-ran that exact message's text through dispatch, not just a no-op. Uses a fresh
// baseline (not an old historical message) to sidestep DOM-matching ambiguity: an old message may
// already be quoted by other replies, which also match a text-based bubble locator and point the
// right-click at the wrong bubble (confirmed live while iterating on this script).
//
// Usage: node reply-retry-test.js "<topic name substring>"
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

  const replyPreviewText = await page.locator(".reply-wrapper, .reply-title").first().innerText().catch(() => "(none)");
  log(`reply-preview bar shows: ${JSON.stringify(replyPreviewText)}`);
  await page.screenshot({ path: "reply-retry-debug.png" });

  const before = await getMessageCount(page);
  await composer.click();
  await composer.type("retry");
  await page.keyboard.press("Enter");
  log("sent 'retry' as a reply to /ls");

  await page.waitForTimeout(3000);
  const texts = await getMessageTexts(page, before + 4);
  console.log(JSON.stringify(texts, null, 2));
  await context.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
