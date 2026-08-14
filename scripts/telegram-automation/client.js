const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const USER_DATA_DIR = path.join(__dirname, "profile");

async function connect() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    // null, not a fixed size: with a real (non-headless) window, a fixed viewport fights the
    // actual window size once it's resized/maximized - confirmed live 2026-08-04, the composer
    // input ended up clipped off-screen after maximizing. null lets the page just use whatever
    // the real window's content area is, same as a normal browser.
    viewport: null,
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  return { context, page };
}

async function openGroup(page, groupName = "AI Bridge Control") {
  await page.getByText(groupName, { exact: false }).first().click();
  await page.waitForTimeout(1500);
}

async function openTopic(page, topicNameSubstring) {
  // `force: true` - confirmed live 2026-08-04 that the topics-slider bar's own ripple overlay
  // (`.topics-slider .c-ripple`) sits on top of the sidebar list and intercepts a plain click,
  // timing out after 30s even though the target row is visible/enabled/stable the whole time.
  await page.locator(".chatlist-chat", { hasText: topicNameSubstring }).first().click({ force: true });
  await page.waitForTimeout(1500);
}

/**
 * Opens a topic by matching its **title** only, unlike `openTopic` above which matches the whole
 * row - including the last-message preview.
 *
 * That difference is load-bearing right after a `/new`: the control topic's own preview then reads
 * `Created "<slug>" (...)`, so an `openTopic(page, slug)` matches the control topic *as well as* the
 * session's topic, and `.first()` picks the control topic because it is the most recently active
 * row. Two live runs of always-rule-check.js drove the control topic that way without failing -
 * every command "sent" fine and simply did nothing, since `/mode` and a plain instruction mean
 * nothing there.
 *
 * Note a session topic is titled from its **prompt**, not its slug (confirmed live 2026-08-12), so
 * pass a distinctive fragment of the prompt here - passing the slug matches nothing.
 */
async function openTopicByTitle(page, titleSubstring) {
  const row = page
    .locator(".chatlist-chat")
    .filter({ has: page.locator(".row-title", { hasText: titleSubstring }) })
    .first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.click({ force: true }); // same ripple-overlay interception as openTopic
  await page.waitForTimeout(1500);
}

async function sendMessage(page, text) {
  // The composer is `div[contenteditable="true"][data-peer-id]` - a second, unrelated
  // contenteditable "fake input" overlay exists in the DOM too (confirmed live 2026-08-04: `.last()`
  // resolved to that one and every click on it silently no-op'd, timing out 30s later), so the
  // `data-peer-id` attribute is what actually disambiguates the real composer.
  const composer = page.locator('div[contenteditable="true"][data-peer-id]');
  await composer.click();
  await composer.type(text);
  // Click the send button rather than pressing Enter. Telegram's native command-autocomplete popup
  // (fed by setMyCommands) stays open while a message starting with a known "/command" is typed, and
  // Enter then *selects the popup entry* instead of sending what was typed - silently replacing
  // "/auto permission on" with "/auto@om_..._bot" and dropping every argument (live-observed
  // 2026-08-11, twice, after /auto joined botCommandList(); any command name that prefixes a
  // registered one hits this). Escape is not the fix: with the popup up it dismisses the popup, but
  // Telegram Web K also treats Escape in the composer as "clear the draft", so the send that follows
  // posts nothing at all - swapping a wrong message for a silently missing one (also live-observed).
  // The send button acts on the composer's actual content whatever the popup is doing.
  const sendButton = page.locator("button.btn-send, .btn-send").first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click();
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(1000);
}

/**
 * Note for anyone writing a predicate against these strings: **a leading emoji is not in them.**
 * Telegram Web K renders emoji as `<img>` elements, and `innerText` skips those - so a card the
 * Bridge sent as "❓ slug asks:" comes back as "slug asks:", and "🔓 auto-approved ..." as
 * "auto-approved ...". Match on the words. Confirmed live 2026-08-13, after an emoji-bearing
 * predicate reported "no question card appeared" against a card that was plainly on screen.
 */
async function getMessageTexts(page, count = 10) {
  const bubbles = page.locator(".bubble-content .translatable-message, .bubble .message");
  const total = await bubbles.count();
  const start = Math.max(0, total - count);
  const texts = [];
  for (let i = start; i < total; i++) {
    texts.push((await bubbles.nth(i).innerText().catch(() => "")).trim());
  }
  return texts.filter(Boolean);
}

/** Total message-bubble count currently rendered.
 *
 * **Do not use this as a "did a reply arrive" baseline - use `getMaxMessageId` below instead.**
 * Web K virtualizes the message list and prunes bubbles that scroll out of the rendered window, so
 * this count does not grow monotonically with new messages: measured live 2026-08-13 in a busy
 * control topic it went 35 -> 36 -> **32** while a reply was landing, and a `total > before` test
 * therefore stayed false for the full timeout against a reply that was on screen. Three consecutive
 * `send-command.js` runs reported "(none within timeout)" that way for commands the Bridge had
 * already executed and answered - and, worse, the pattern fails hardest exactly when the topic is
 * busy, which is when a check is most likely to be measuring something that matters. Kept only for
 * the rare "how much is rendered right now" question. */
async function getMessageCount(page) {
  return page.locator(".bubble-content .translatable-message, .bubble .message").count();
}

/** Highest Telegram message id currently rendered. `data-mid` is per-message, stable and
 * monotonically increasing, which makes it the right baseline for "anything new since this moment":
 * unlike a bubble count it survives the virtualization pruning above, and unlike matching on text it
 * still sees a reply that happens to be byte-identical to an earlier one (five `/ls` rounds in a row
 * produce five identical tables - a content-diff baseline would call four of them stale). */
async function getMaxMessageId(page) {
  const mids = await page.locator(".bubble[data-mid]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-mid"))));
  const finite = mids.filter((n) => Number.isFinite(n));
  return finite.length > 0 ? Math.max(...finite) : 0;
}

/** Text of every rendered bubble newer than `afterMid`, oldest first. Includes the echo of whatever
 * the operator just sent, same as the count-based helper it replaces. */
async function getMessagesAfter(page, afterMid) {
  const texts = await page.locator(".bubble[data-mid]").evaluateAll(
    (els, after) =>
      els
        .filter((e) => Number(e.getAttribute("data-mid")) > after)
        .sort((a, b) => Number(a.getAttribute("data-mid")) - Number(b.getAttribute("data-mid")))
        .map((e) => (e.querySelector(".translatable-message, .message")?.innerText ?? "").trim()),
    afterMid,
  );
  return texts.filter(Boolean);
}

/**
 * Poll until at least one message newer than `afterMid` satisfies `match`, then return *every* new
 * message (not just the matching one). Returns [] on timeout - an empty result here really does
 * mean nothing arrived, which is the whole point of keying on mids.
 *
 * `match` matters because the operator's own message echoes back as a bubble too, and it is always
 * the first thing to appear: a bare "anything new?" test returns on that echo, typically a second
 * or two before the Bridge's actual reply, and the caller then reads a response that contains only
 * its own command. Pass a predicate that excludes the echo when you want the reply.
 */
async function waitForMessagesAfter(page, afterMid, { rounds = 20, intervalMs = 2000, match = () => true } = {}) {
  for (let i = 0; i < rounds; i++) {
    await page.waitForTimeout(intervalMs);
    const texts = await getMessagesAfter(page, afterMid);
    if (texts.some(match)) return texts;
  }
  return [];
}

/**
 * The button analogue of `getMessageTexts`' emoji caveat above, and the same bug one layer down:
 * Web K renders emoji as `<img class="emoji">` sprites, so a button the Bridge sends as `"✅ Allow"`
 * has an innerText of just `" Allow"`, and a `hasText: "✅ Allow"` locator matches nothing, ever.
 * Confirmed live 2026-08-13: rate-storm-check.js's permission probe had been hunting for `"✅ Allow"`
 * since it was written and had therefore never once measured a permission latency - it printed
 * "FAIL: no permission card appeared" against cards that were plainly on screen. Pass the label
 * *without* its emoji.
 *
 * Anchored regex rather than the plain substring `hasText` takes, because Playwright's string form
 * is case-insensitive: `"Allow"` also matches `"♾️ Always allow this pattern"`, and callers reach
 * for `.last()` here, which would tap **Always allow** - writing a permanent permission rule
 * instead of approving one call. A wrong tap that silently widens the allowlist is a far worse
 * failure than no tap at all, so this refuses to match loosely.
 */
function buttonByLabel(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(".reply-markup-button", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) });
}

/**
 * Undoes Git Bash's POSIX-path translation of a leading-slash argument.
 *
 * MSYS rewrites any argument that *looks* like an absolute POSIX path into a Windows path before
 * node ever sees it, and every command this rig sends starts with "/". So
 * `node send-command.js "/kill my-session"` arrives in `process.argv` as
 * `"C:/Program Files/Git/kill my-session"` - the command name silently becomes the tail of a path
 * to the Git installation. Live-hit 2026-08-14 on a `/kill`; the same trap had already cost a
 * detour on `powercfg /a` and `/ls`, so it is not specific to one command or one script.
 *
 * Two things made it worth repairing here rather than only documenting `MSYS_NO_PATHCONV=1`:
 * the mangled text is still a *plausible* message, so it gets sent and the check reports whatever
 * comes back rather than failing; and the NL router then reads it as a near-miss and answers with
 * a confirm card ("I read that as /kill ... - run it?"), which looks enough like success to be
 * mistaken for one in a log.
 *
 * Deliberately narrow, because over-eager unmangling would corrupt legitimate arguments: it only
 * fires when the prefix is a real Git-for-Windows install root (checked on disk via `usr/bin/bash.exe`,
 * not guessed from the string), which is the only directory MSYS ever substitutes for "/". A message
 * that genuinely begins with a Windows path is left alone, because such a path's own prefix will not
 * satisfy that test.
 *
 * Measured, not assumed - every leading-slash argument is rewritten, and only a leading one:
 *   "/ls"                     -> "C:/Program Files/Git/ls"
 *   "/kill some-slug"         -> "C:/Program Files/Git/kill some-slug"
 *   "hello /ls"               -> unchanged
 * **Known gap:** a *single-letter* command takes a different mangling - "/a" becomes "A:/", a drive
 * root with no install-root prefix to recognise - so this cannot repair it and returns it untouched.
 * No fleet command is one letter today, so nothing is currently affected; if one is ever added, pass
 * `MSYS_NO_PATHCONV=1` for it rather than widening the rule here, since "A:/" is also a legitimate
 * thing for a message to contain and guessing would corrupt it.
 */
function unmangleMsysPath(arg) {
  const m = /^([A-Za-z]:[\\/](?:[^\\/]*[\\/])*)([^\\/\s]+)([\s\S]*)$/.exec(arg);
  if (!m) return arg;
  const [, prefix, firstWord, rest] = m;
  if (!fs.existsSync(path.join(prefix, "usr", "bin", "bash.exe"))) return arg;
  const repaired = `/${firstWord}${rest}`;
  console.error(`[client] MSYS mangled the argument into a path; sending "${repaired}" instead of "${arg}"`);
  return repaired;
}

module.exports = {
  connect,
  openGroup,
  openTopic,
  openTopicByTitle,
  sendMessage,
  unmangleMsysPath,
  getMessageTexts,
  getMessageCount,
  getMaxMessageId,
  getMessagesAfter,
  waitForMessagesAfter,
  buttonByLabel,
};
