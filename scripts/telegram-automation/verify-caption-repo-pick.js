// One-off live verification for the ambiguous-repo gap fix (inbound-media.ts's
// handleControlTopicAttachment): a control-topic image whose caption NL-matches "create a
// session" intent without naming one of 2+ registered repos used to fall straight through to the
// fixed "send it in a session topic" rejection and silently drop the attachment. It should now post
// the same ask-which-repo keyboard the text flow already has. Not a permanent part of the toolkit -
// scoped to this one verification, per CLAUDE.md's "write a small one-off script" guidance.
//
// Usage: node verify-caption-repo-pick.js "<absolute image path>" "<caption>"
const { connect, openGroup, openTopic, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const filePath = process.argv[2];
const caption = process.argv[3];
if (!filePath || !caption) {
  console.error('usage: node verify-caption-repo-pick.js "<absolute image path>" "<caption>"');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");

  const before = await getMessageCount(page);

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('button[title="Attach"], .btn-icon.attach-file, button.attach-file').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.getByText("Document", { exact: false }).last().click({ force: true });
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(filePath);
  await page.waitForTimeout(1500);

  const captionBox = page.locator('div[contenteditable="true"][data-animation-group="NEW-MEDIA"]');
  await captionBox.click();
  await captionBox.type(caption);
  await page.keyboard.press("Enter");
  log(`sent attachment: ${filePath} (caption: ${caption})`);

  let texts = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= before) continue;
    texts = await getMessageTexts(page, total - before);
    break;
  }
  log(`response: ${texts.join(" | ") || "(none within timeout)"}`);
  await page.screenshot({ path: require("path").join(__dirname, "verify-caption-repo-pick.png") });
  await context.close();
})();
