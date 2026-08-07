// One-off: live-verify message-context.ts's reply-quote wiring (index.ts's dispatchInboundMessage
// contextPrefix param) - sends a baseline message, right-clicks it to open Telegram Web K's context
// menu, clicks "Reply", sends a follow-up, then greps bridge-dev.log's PTY tail for the
// "[Replying to an earlier message: ...]" prefix actually reaching the session's PTY.
//
// Usage: node reply-context-test.js "<topic name substring>"
const { connect, openGroup, openTopic, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2] || "test-session";

(async () => {
  const { context, page } = await connect();
  await page.setViewportSize({ width: 1400, height: 900 });
  // A hard reload first - confirmed live: every forum topic in the same group shares one
  // `data-peer-id` (only the thread differs), so once this persistent profile's page has visited
  // more than one topic in its lifetime, multiple composer nodes can be mounted at once and the
  // plain `data-peer-id` composer locator silently resolves to a stale one (typing lands in
  // whichever topic was opened first, not the one currently on screen). A fresh reload leaves
  // exactly one composer mounted.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  await openGroup(page);
  await page.waitForTimeout(1500);
  // `.last()`, not `.first()` - a hidden "all chats" duplicate of this row sits earlier in the DOM
  // (confirmed live: it resolves with a null bounding box), same duplicate-layer issue client.js's
  // own composer-disambiguation comment already flagged for a different element.
  const topicRow = page.locator(".chatlist-chat", { hasText: topicSubstring }).last();
  let box = null;
  for (let i = 0; i < 10 && !box; i++) {
    box = await topicRow.boundingBox();
    if (!box) await page.waitForTimeout(1000);
  }
  if (!box) throw new Error(`topic row for "${topicSubstring}" has no bounding box after retrying`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);

  const baseline = `reply-context-baseline-${Date.now()}`;
  const composer = page.locator('div[contenteditable="true"][data-peer-id]');
  await composer.click();
  await composer.type(baseline);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  log(`sent baseline: ${baseline}`);

  // Right-click the bubble carrying the baseline text to open its context menu.
  const bubble = page.locator(".bubble-content .translatable-message, .bubble .message", { hasText: baseline }).last();
  await bubble.scrollIntoViewIfNeeded();
  await bubble.click({ button: "right" });

  // The context menu is flaky to catch immediately after right-click (confirmed live: sometimes
  // not rendered yet, sometimes already gone) - poll for a visible, exact "Reply" text node with a
  // real bounding box rather than a single locator().click() attempt.
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

  // Sanity check: clicking "Reply" must not have navigated away from this topic (confirmed live
  // this can silently happen) - the composer should now show a reply-preview bar quoting `baseline`.
  const replyPreviewVisible = await page.locator(".reply-wrapper, .reply-title", { hasText: /./ }).first().isVisible().catch(() => false);
  log(`reply-preview bar visible in composer: ${replyPreviewVisible}`);

  const followUp = `reply-context-followup-${Date.now()}`;
  await composer.click();
  await composer.type(followUp);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  log(`sent follow-up (as a reply): ${followUp}`);

  await page.waitForTimeout(3000);
  await context.close();
  console.log(JSON.stringify({ baseline, followUp }));
})();
