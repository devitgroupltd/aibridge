// One-off: live-verify reply-to-retry over an *attachment* (inbound-media.ts's
// attachmentFromReplyTarget + the new branch in routeInboundMessage). Sends a fresh document with a
// caption into a session topic, replies to it with "retry", and confirms a second identical
// "filename / size / caption" announcement appears - proof the retry mechanism re-downloaded and
// re-announced the attachment itself, not just forwarded the bare caption as text. Uses a fresh
// send immediately before replying (not an old historical message) for the same DOM-matching-
// ambiguity reason reply-retry-test.js documents.
//
// Usage: node reply-retry-attachment-test.js "<topic name substring>" "<absolute file path>" "<caption>"
const { connect, openGroup, getMessageCount, getMessageTexts } = require("./client.js");

// A topic whose title/last-activity text is echoed into the outer group's own chat-list preview
// (e.g. right after a rename service message) matches `.chatlist-chat`'s `.first()` on the *outer*
// group entry instead of the real topic row below it - confirmed live: `.first()` opened the
// control topic's history instead of the target session topic. `.last()` reliably lands on the
// nested topic-slider row instead, since it renders after the outer entry in DOM order.
async function openTopicLast(page, topicNameSubstring) {
  await page.locator(".chatlist-chat", { hasText: topicNameSubstring }).last().click({ force: true });
  await page.waitForTimeout(1500);
}

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2];
const filePath = process.argv[3];
const caption = process.argv[4] || "retry-attachment-test caption";
if (!topicSubstring || !filePath) {
  console.error('usage: node reply-retry-attachment-test.js "<topic name substring>" "<absolute file path>" ["<caption>"]');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopicLast(page, topicSubstring);
  await page.waitForTimeout(1000);

  const before = await getMessageCount(page);

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('button[title="Attach"], .btn-icon.attach-file, button.attach-file').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.getByText("Document", { exact: false }).last().click({ force: true });
  const chooser = await fileChooserPromise;
  await chooser.setFiles(filePath);
  await page.waitForTimeout(1500);

  // Media-preview popup's own caption input, disambiguated the same way send-attachment.js's
  // does - a second, unrelated contenteditable overlay sits on top and intercepts a plain click.
  const captionBox = page.locator('div[contenteditable="true"][data-animation-group="NEW-MEDIA"]');
  await captionBox.click();
  await captionBox.type(caption);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  log(`sent attachment with caption: ${caption}`);

  const bubble = page.locator(".bubble-content, .bubble", { hasText: caption }).last();
  await bubble.scrollIntoViewIfNeeded();
  await bubble.click({ button: "right", force: true });
  await page.waitForTimeout(500);

  // Manual mouse click at the "Reply" item's own bounding box, not `.click()` on the locator -
  // `.click()` on a text locator matched a stale/hidden duplicate menu-template node elsewhere in
  // the DOM (reply-retry-test.js's own doc comment covers the same class of issue), leaving the
  // real, visible menu untouched and still open afterward.
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
  await page.screenshot({ path: "reply-retry-attachment-debug.png" });

  const replyPreviewText = await page.locator(".reply-wrapper, .reply-title").first().innerText().catch(() => "(none)");
  log(`reply-preview bar shows: ${JSON.stringify(replyPreviewText)}`);

  const composer = page.locator('div[contenteditable="true"][data-peer-id]');
  await composer.click();
  await composer.type("retry");
  await page.keyboard.press("Enter");
  log("sent 'retry' as a reply to the attachment");

  await page.waitForTimeout(4000);
  const texts = await getMessageTexts(page, before + 6);
  console.log(JSON.stringify(texts, null, 2));
  await context.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
