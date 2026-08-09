// One-off: attach a real file (photo or document) to a session's own topic, optionally with a
// caption, and read back what the session did with it. Live-verifies §5.6's attachment-inbox path
// (photo/document/video/audio/video_note -> $STATE/sessions/<slug>/inbox/ -> announced by path) -
// not a permanent part of the toolkit, kept here per CLAUDE.md's "write a small one-off script"
// guidance.
//
// Usage: node send-attachment.js "<topic name substring>" "<absolute file path>" ["<caption>"]
const { connect, openGroup, openTopic, getMessageTexts, getMessageCount } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const topicSubstring = process.argv[2];
const filePath = process.argv[3];
const caption = process.argv[4];
if (!topicSubstring || !filePath) {
  console.error('usage: node send-attachment.js "<topic name substring>" "<absolute file path>" ["<caption>"]');
  process.exit(1);
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, topicSubstring);

  const before = await getMessageCount(page);

  // The attach (paperclip) button opens a menu with "Photo or Video"/"Document" entries, each of
  // which triggers a native file-picker dialog - intercepted here via Playwright's `filechooser`
  // event instead of an OS dialog, exactly the pattern client.js's own doc comments favour
  // (disambiguate real UI elements, don't fight overlays).
  // `.last()`, not `.first()` - confirmed live 2026-08-09 that "Document" matches four elements on
  // a chat with any message history (sidebar chat-list previews and message-bubble text can contain
  // the word too), and the actual attach-menu item is reliably the last one in DOM order, not the
  // first. `.first()` silently clicked one of the other three, leaving the menu open and the
  // filechooser event never firing (a 30s timeout with no visible cause in the log).
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('button[title="Attach"], .btn-icon.attach-file, button.attach-file').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.getByText("Document", { exact: false }).last().click({ force: true });
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(filePath);
  await page.waitForTimeout(1500);

  if (caption) {
    // The media-preview composer's real caption input is disambiguated by
    // `data-animation-group="NEW-MEDIA"` - a second, unrelated contenteditable "fake input"
    // overlay sits on top of it and intercepts a plain click/`.last()` (confirmed live
    // 2026-08-05), same class of pitfall client.js's own composer note already documents.
    const captionBox = page.locator('div[contenteditable="true"][data-animation-group="NEW-MEDIA"]');
    await captionBox.click();
    await captionBox.type(caption);
  }
  await page.keyboard.press("Enter");
  log(`sent attachment: ${filePath}${caption ? ` (caption: ${caption})` : ""}`);

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
