// §5.4 point 4's quiet mode, live. Built in 0.35.0 and unit-tested with a fake clock, but never
// forced with a real feed storm (§12 Phase 6a: "not yet live-forced with a real four-session feed
// storm") - so the two things that only a real storm can show have never been observed: that
// `RateGovernor.p2PressureExceeded()` actually trips under genuine load, and that the one-time
// "feed throttled" notice reaches the control topic.
//
// What has to happen for the trigger to fire (rate-governor.ts): at least MIN_SAMPLES_FOR_PRESSURE
// (4) P2 outcomes inside a rolling 60s window, with **more than half dropped**. P2 is the feed
// bot's lane - one token per 3s, 20 per minute - and a drop is what happens when a feed card edit
// finds the bucket empty. So the storm has to push well past 20 feed sends a minute, which means
// several sessions each producing a fast, unbroken run of tool calls.
//
// Every command below is already in settings.ts's allow list, deliberately: a permission card would
// stall the session on a P0 prompt and starve exactly the P2 traffic this is trying to generate.
//
// Usage: node quiet-mode-check.js [sessionCount]   (default 3 - the weighted concurrency cap is 4
// units and the ask-timeout check may be holding one)
const { connect, openGroup, openTopicByTitle, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

const BURST = [
  "ls",
  "git status --short",
  "git log -1 --oneline",
  "ls packages",
  "git branch --list",
  "ls scripts",
  "git diff --stat",
  "ls plans",
  "wc -l README.md",
  "head -5 README.md",
  "git log -3 --oneline",
  "ls packages/bridge/src",
  "tail -5 README.md",
  "git status",
  "ls packages/bridge/test",
];

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function stormPrompt(n) {
  return (
    `stormcheck${n} Run each of these Bash commands one at a time, in this exact order, ` +
    `as fast as you can, and do not summarise or explain anything between them: ` +
    `${BURST.join(", ")}. Then run the same list a second time. Reply only when completely done.`
  );
}

(async () => {
  const sessionCount = Number(process.argv[2] ?? 3);
  const { context, page } = await connect();
  await openGroup(page);
  await openTopicByTitle(page, "General");

  const slugs = [];
  for (let i = 1; i <= sessionCount; i++) {
    const before = await getMessageCount(page);
    await sendMessage(page, `/new aibridge ${stormPrompt(i)}`);
    let slug = null;
    for (let round = 0; round < 45; round++) {
      await page.waitForTimeout(2000);
      const total = await getMessageCount(page);
      if (total <= before) continue;
      const texts = await getMessageTexts(page, total - before);
      const refused = texts.find((t) => t.includes("at capacity") || t.includes("Failed to launch session"));
      if (refused) {
        log(`FAIL: session ${i} refused: ${refused.replace(/\n/g, " | ").slice(0, 160)}`);
        break;
      }
      const created = texts.find((t) => t.includes('Created "'));
      if (created) {
        slug = created.match(/Created "([^"]+)"/)?.[1] ?? null;
        break;
      }
    }
    if (!slug) {
      log(`FAIL: session ${i} never confirmed`);
      break;
    }
    slugs.push(slug);
    log(`storm session ${i}/${sessionCount}: ${slug}`);
  }

  if (slugs.length === 0) {
    await context.close();
    process.exit(1);
  }

  // Now drive *turns*, not just tool calls - the first version of this check sent one long
  // command list per session and never tripped the trigger, for a structural reason worth writing
  // down: `FeedCoalescer.interval()` is `3000 * activeSessionCount`, so coalesced card edits are
  // held at roughly the feed bucket's own 20/minute budget no matter how many tools a single turn
  // calls. The traffic that actually pushes P2 past its budget is *per-turn* overhead - a card
  // create and a details anchor for every turn - so the storm has to maximise turn count, which
  // means many short messages round-robined across the sessions rather than one big prompt each.
  // Baseline BEFORE the storm, not after it. `checkQuietMode` runs on index.ts's own 60s sweep and
  // posts on the rising edge, so the notice lands *during* the storm - an earlier version of this
  // script took its baseline after the last message was sent and reported "no notice" for a run
  // where the notice was sitting in the control topic the whole time.
  await openTopicByTitle(page, "General");
  const watchStart = await getMessageCount(page);

  const TURN_ROUNDS = 10;
  log(`driving ${TURN_ROUNDS} short turns into each of ${slugs.length} sessions to force per-turn P2 overhead past the budget...`);
  for (let round = 0; round < TURN_ROUNDS; round++) {
    for (const slug of slugs) {
      const hint = slug.startsWith("stormcheck1") ? "stormcheck1" : slug.startsWith("stormcheck2") ? "stormcheck2" : "stormcheck3";
      await openTopicByTitle(page, `${hint} Run each of these`);
      await sendMessage(page, `Run ls with Bash and reply with the first line only. (round ${round + 1})`);
    }
  }
  log("turn storm sent - watching the control topic for the notice");

  // The notice is posted once on the rising edge only (feed-wiring.ts's `quietModeNotified`), so
  // polling for it is the whole check - a later storm would notify again, but this one gets exactly
  // one chance.
  await openTopicByTitle(page, "General");
  let notice = null;
  for (let round = 0; round < 60; round++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total > watchStart) {
      const texts = await getMessageTexts(page, total - watchStart);
      // Emoji are rendered as <img> and dropped from innerText (see client.js) - match the words.
      notice = texts.find((t) => t.includes("feed throttled")) ?? null;
      if (notice) break;
    }
  }

  console.log(JSON.stringify({ slugs, quietModeNoticeSeen: Boolean(notice), notice }, null, 2));
  if (notice) log(`quiet mode fired: ${notice.replace(/\n/g, " | ")}`);
  else log("no 'feed throttled' notice within ~3 minutes - either the storm never pushed P2 drops past 50% in a 60s window, or the trigger did not fire");

  for (const slug of slugs) {
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(2000);
    await sendMessage(page, `/remove ${slug}`);
    await page.waitForTimeout(2500);
  }
  log("cleanup sent for every storm session");

  await context.close();
  process.exit(notice ? 0 : 1);
})();
