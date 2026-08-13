// §13 manual check 5, as far as a repo with no guard hook of its own can carry it.
//
// Check 5 is specified against SeoWrite and has four paths, three of which ((a) commit on `main`
// blocked by SeoWrite's PowerShell guard, (b) `--no-verify` blocked, (d) `git push origin main`
// caught by its `.githooks/pre-push`) need that repo's own hooks to exist. §13 says so explicitly:
// "A registered repo with no equivalent guard hook has no (a)/(b)/(d) to verify - only (c), the
// `ask` rule, applies universally." aibridge is such a repo, so this script runs (c) and only (c):
//
//   (c) ask a session to commit normally on a feature branch - a *button* appears rather than the
//       commit just happening, driven by the `ask` rule and not by any guard's return value
//       (§6.1.1). §13 names (c) and (d) as "the ones most likely to regress silently".
//
// Every session's worktree is already on its own `claude/<slug>-<n>` branch, so "on a feature
// branch" is the default state here - nothing to set up.
//
// Written 2026-08-13 also to settle a question rate-storm-check.js could not: whether a permission
// card genuinely reaches Telegram under normal conditions. bridge.log logs the auto-approve
// shortcuts but not the happy path, so "PermissionRequest received" and "card visible on the phone"
// are not the same observation, and only the second one is what check 5(c) is about. This dumps
// what is actually in the topic - bubble text *and* inline-keyboard button labels - rather than
// inferring it.
//
// Usage: node guardrail-check.js
const { connect, openGroup, openTopic, openTopicByTitle, sendMessage, getMessageTexts, getMaxMessageId, waitForMessagesAfter } = require("./client.js");

const TAG = "[GR-C]";
const PROMPT = `${TAG} Create a file named guardrail-check-scratch.txt containing the single line "guardrail check (c)", then run "git add guardrail-check-scratch.txt" and then "git commit -m \\"guardrail check (c) - throwaway\\"". This is a disposable session branch.`;

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

/** Both halves of what the operator would actually see: the bubble text and, separately, the
 * inline-keyboard buttons. Read apart because a permission card is exactly a bubble whose meaning
 * lives in its buttons - a text-only dump of that topic looks like an ordinary feed line. */
async function dumpTopic(page, titleSubstring) {
  await openTopicByTitle(page, titleSubstring);
  await page.waitForTimeout(800);
  const texts = await getMessageTexts(page, 25);
  const buttons = await page.locator(".reply-markup-button").allInnerTexts();
  return { texts, buttons };
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");

  // --- create the session ------------------------------------------------------------------
  let slug = null;
  {
    // `getMaxMessageId`, never `getMessageCount` - see that helper's doc comment for why a bubble
    // count is not a valid arrival baseline in this client.
    const afterMid = await getMaxMessageId(page);
    await sendMessage(page, `/new aibridge ${PROMPT}`);
    const texts = await waitForMessagesAfter(page, afterMid, { rounds: 20, intervalMs: 2000, match: (t) => t.includes('Created "') });
    slug = texts.find((t) => t.includes('Created "'))?.match(/Created "([^"]+)"/)?.[1] ?? null;
  }
  if (!slug) {
    log("FAIL: no session created - cannot run check 5(c)");
    await context.close();
    process.exit(1);
  }
  log(`created session "${slug}"`);

  // --- make sure the ask rule is what decides, not the bypass ---------------------------------
  // Check 5(c) is specifically about the `ask` rule producing a button. With auto-permission ON
  // (which `/default permission` may well leave it) the commit is auto-allowed and the check
  // measures nothing at all - the exact way rate-storm-check.js's permission half went quietly
  // vacuous. Per-session only; the operator's global `/default` is theirs.
  {
    await openTopic(page, "General");
    const afterMid = await getMaxMessageId(page);
    await sendMessage(page, `/auto permission ${slug} off`);
    const texts = await waitForMessagesAfter(page, afterMid, { rounds: 10, intervalMs: 1000, match: (t) => t.includes("Auto-permission is now off") });
    const confirmed = texts.some((t) => t.includes("Auto-permission is now off"));
    log(confirmed ? "auto-permission off confirmed" : 'WARN: no "Auto-permission is now off" confirmation - the result below may be vacuous');
  }

  // --- watch the session's own topic for the card ---------------------------------------------
  let outcome = "no-card";
  let sawAllow = false;
  for (let round = 0; round < 12; round++) {
    await page.waitForTimeout(10000);
    const { texts, buttons } = await dumpTopic(page, TAG);
    log(`round ${round + 1}: ${buttons.length} button(s) [${buttons.join(" | ")}]`);
    if (round === 11 || buttons.some((b) => b.includes("Allow"))) {
      console.log("=== topic text ===");
      for (const t of texts) console.log(t.replace(/\s+/g, " ").slice(0, 300));
      console.log("=== buttons ===");
      for (const b of buttons) console.log(JSON.stringify(b));
    }
    if (buttons.some((b) => b.includes("Allow"))) {
      sawAllow = true;
      const committed = texts.some((t) => t.includes("git commit") || t.includes("Bash"));
      outcome = committed ? "card-raised" : "card-raised-unmatched-text";
      break;
    }
    if (texts.some((t) => t.includes("auto-approved"))) {
      outcome = "auto-approved-no-card";
      break;
    }
  }

  log(
    sawAllow
      ? "PASS 5(c): the commit raised a real Telegram button instead of just happening"
      : `FAIL 5(c): no Allow button ever appeared (outcome="${outcome}")`,
  );
  console.log(JSON.stringify({ slug, outcome, sawAllow }, null, 2));

  // Deliberately does NOT clean up: if the card is up, the session is blocked on it and the
  // operator may want to look. Remove with /kill + /remove from the control topic.
  log(`session "${slug}" left in place - /kill ${slug} && /remove ${slug} to clean up`);
  await context.close();
})();
