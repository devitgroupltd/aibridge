// §6.4's 3540s ask ceiling, live. The one part of the question path that has only ever been
// unit-tested and spike-verified against the real stdout contract - never run under an actual
// hour-long wait (§12 Phase 4: "not verified under a real hour-long wait").
//
// Two phases, because the wait is 59 minutes and nothing should hold a browser open that long:
//
//   node ask-timeout-check.js setup    - creates a session, disables /auto answer, gets Claude to
//                                        call AskUserQuestion, confirms the card is up, and exits
//                                        leaving it deliberately unanswered. Prints the slug.
//   node ask-timeout-check.js verify <slug>
//                                      - run after ~60 minutes: confirms the card was edited to
//                                        "⌛ no answer in an hour - cancelled" (ask-callback.ts's
//                                        renderAskCancelledCard) and the session is no longer
//                                        blocked, then cleans up.
//
// `/auto answer off` is not optional here: this fleet's default is on, and an auto-answered question
// never reaches the ceiling at all - the same trap that cost the Always-rule check three runs
// (always-rule-check.js's own header has the full list).
const { connect, openGroup, openTopicByTitle, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

const TOPIC_TITLE_HINT = "askcheck Reply with the single word";
const CANCEL_TEXT = "no answer in an hour";

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

async function pollInPlace(page, baseline, predicate, { rounds, intervalMs = 2000 } = {}) {
  for (let i = 0; i < rounds; i++) {
    const total = await getMessageCount(page);
    if (total > baseline) {
      const texts = await getMessageTexts(page, total - baseline);
      const hit = texts.find(predicate);
      if (hit) return hit;
    }
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

async function setup(page) {
  const prompt = "askcheck Reply with the single word ready and then wait. Do not run any command.";
  await openTopicByTitle(page, "General");
  const controlBaseline = await getMessageCount(page);
  await sendMessage(page, `/new aibridge ${prompt}`);

  let slug = null;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= controlBaseline) continue;
    const texts = await getMessageTexts(page, total - controlBaseline);
    const failure = texts.find((t) => t.includes("Failed to launch session"));
    if (failure) {
      log(`FAIL: ${failure.replace(/\n/g, " | ")}`);
      return null;
    }
    const created = texts.find((t) => t.includes('Created "'));
    if (created) {
      slug = created.match(/Created "([^"]+)"/)?.[1] ?? null;
      break;
    }
  }
  if (!slug) {
    log("FAIL: no session created within 90s");
    return null;
  }
  log(`session created: ${slug}`);

  await openTopicByTitle(page, TOPIC_TITLE_HINT);
  await page.waitForTimeout(1000);

  const autoBaseline = await getMessageCount(page);
  await sendMessage(page, "/auto answer off");
  const autoOff = await pollInPlace(page, autoBaseline, (t) => /Auto-answer is now off/i.test(t), { rounds: 10 });
  if (!autoOff) {
    log("FAIL: no 'Auto-answer is now off' confirmation - a recommended option would be auto-picked and the ceiling never reached");
    return null;
  }
  log("auto-answer disabled for this session");

  const askedAt = await getMessageCount(page);
  await sendMessage(
    page,
    "Use the AskUserQuestion tool right now to ask me whether to proceed with option A or option B. " +
      "Do not mark either option as recommended. Wait for my answer - do not decide yourself, do not do anything else.",
  );

  // ask-callback.ts's renderAskCard is "❓ <slug> asks[ (header)]:\n\n<question>" - but match on the
  // *words* only. Telegram Web K renders a leading emoji as an `<img>`, so `innerText` (what
  // client.js's getMessageTexts reads) returns "askcheck-... asks (A or B?): ..." with no ❓ at all;
  // an emoji-bearing predicate silently fails against a card that is sitting right there, which is
  // exactly what happened on this check's first run.
  const card = await pollInPlace(page, askedAt, (t) => /\basks\b/.test(t) && t.includes(slug), { rounds: 45 });
  if (!card) {
    log("FAIL: no question card appeared within 90s");
    return null;
  }
  log(`question card is up and will be left unanswered: ${card.slice(0, 120).replace(/\n/g, " | ")}`);
  log(`NEXT: in ~60 minutes, run: node ask-timeout-check.js verify ${slug}`);
  console.log(JSON.stringify({ phase: "setup", slug, cardSeen: true, startedAtIso: new Date().toISOString() }, null, 2));
  return slug;
}

async function verify(page, slug) {
  await openTopicByTitle(page, TOPIC_TITLE_HINT);
  await page.waitForTimeout(1500);

  const total = await getMessageCount(page);
  const texts = await getMessageTexts(page, Math.min(total, 25));
  const cancelled = texts.find((t) => t.includes(CANCEL_TEXT));
  const stillTappable = texts.find((t) => t.includes("❓") && t.includes("asks") && !t.includes(CANCEL_TEXT));

  const result = {
    phase: "verify",
    slug,
    cardCancelled: Boolean(cancelled),
    // The card is edited in place, so an un-edited question card still sitting there means the
    // 3540s sweep never fired - the exact failure this check exists to catch.
    unresolvedCardStillPresent: Boolean(stillTappable),
  };
  if (cancelled) log(`card was cancelled as expected: ${cancelled.slice(0, 140).replace(/\n/g, " | ")}`);
  else log("FAIL: no '⌛ no answer in an hour - cancelled' edit found");

  console.log(JSON.stringify(result, null, 2));

  await openTopicByTitle(page, "General");
  await page.waitForTimeout(1000);
  await sendMessage(page, `/kill ${slug}`);
  await page.waitForTimeout(2000);
  await sendMessage(page, `/remove ${slug}`);
  await page.waitForTimeout(2000);
  log("cleanup sent (kill + remove)");
  return result.cardCancelled && !result.unresolvedCardStillPresent;
}

(async () => {
  const mode = process.argv[2];
  const slugArg = process.argv[3];
  if (mode !== "setup" && mode !== "verify") {
    console.error("usage: node ask-timeout-check.js setup | node ask-timeout-check.js verify <slug>");
    process.exit(1);
  }

  const { context, page } = await connect();
  await openGroup(page);

  let ok = false;
  if (mode === "setup") {
    ok = Boolean(await setup(page));
  } else {
    if (!slugArg) {
      console.error("verify needs the slug printed by setup");
      await context.close();
      process.exit(1);
    }
    ok = await verify(page, slugArg);
  }

  await context.close();
  process.exit(ok ? 0 : 1);
})();
