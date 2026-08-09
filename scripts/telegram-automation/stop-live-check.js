// One-off live-verification harness for the new `/stop` command (aibridge, 2026-08-09). Does the
// whole flow in one browser session, since a substring topic match can accidentally resolve to
// the control topic instead of the session's own (its last message is literally
// "Created \"<slug>\" ..."), which contains the slug substring too - open-via-link.js's
// click-the-confirmation's-own-"Open <slug>"-button approach avoids that ambiguity, and staying in
// one session/context avoids losing the now-open session topic when a new script re-navigates.
// Per-session permission prompts render inline in the session's own topic (not just the control
// topic), so once we're there the Allow button is already in view - no extra navigation needed.
//
// Usage: node stop-live-check.js "<slug>"
const path = require("path");
const { connect, openGroup, openTopic } = require("./client.js");

const slug = process.argv[2];
if (!slug) {
  console.error('usage: node stop-live-check.js "<slug>"');
  process.exit(1);
}

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

async function dumpLast(page, n) {
  const bubbles = page.locator(".bubble");
  const count = await bubbles.count();
  const out = [];
  for (let i = Math.max(0, count - n); i < count; i++) {
    out.push((await bubbles.nth(i).innerText().catch(() => "")).slice(0, 500));
  }
  return out;
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");
  await page.waitForTimeout(1000);

  log("opening session topic via its own Open-link button");
  const link = page.locator("a.reply-markup-button", { hasText: slug }).last();
  await link.waitFor({ state: "visible", timeout: 10000 });
  await link.click({ force: true });
  await page.waitForTimeout(1500);

  log("looking for a pending Bash permission ask, in view now that we're in the session topic");
  const allow = page.locator(".reply-markup-button", { hasText: "Allow" }).last();
  if (await allow.isVisible().catch(() => false)) {
    log("found Allow - clicking");
    await allow.click({ force: true });
    await page.waitForTimeout(2000);
    log("Allow-area text right after click:");
    console.log(await page.locator(".bubble", { hasText: "wants to run Bash" }).last().innerText().catch(() => "(gone)"));
  } else {
    log("no visible Allow prompt - assuming already running or none pending");
  }

  log("BEFORE /stop:");
  console.log(JSON.stringify(await dumpLast(page, 4), null, 2));

  await page.waitForTimeout(3000); // let a few counted lines actually land before interrupting

  log("sending /stop in this session's own topic");
  const composer = page.locator('div[contenteditable="true"][data-peer-id]').first();
  await composer.click({ force: true });
  await composer.type("/stop");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);

  log("AFTER /stop:");
  console.log(JSON.stringify(await dumpLast(page, 6), null, 2));

  await page.waitForTimeout(4000);
  log("AFTER /stop + 4s settle:");
  console.log(JSON.stringify(await dumpLast(page, 6), null, 2));

  await page.screenshot({ path: path.join(__dirname, "stop-live-check.png") });
  await context.close();
})();
