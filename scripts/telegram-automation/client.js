const { chromium } = require("playwright");
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
  await page.locator(".chatlist-chat", { hasText: topicNameSubstring }).first().click();
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
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
}

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

/** Total message-bubble count currently rendered - use as a baseline before an action, then poll
 * for `getMessageTexts` only over bubbles *past* that baseline. Matching by content alone (e.g.
 * "the last message containing X") is unsafe once a chat has history: it can match a stale
 * historical message instead of the fresh one just sent (confirmed live 2026-08-04). */
async function getMessageCount(page) {
  return page.locator(".bubble-content .translatable-message, .bubble .message").count();
}

module.exports = { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount };
