// turn-start-watchdog.ts's false-positive check: healthy traffic must never raise its notice.
//
// The watchdog's *firing* path is covered by mutation-verified unit tests. What those cannot cover
// is the deployment risk, which points the other way: it arms on every inbound message written to an
// idle session, so if `UserPromptSubmit` ever fails to arrive within the timeout on a perfectly
// normal turn, every operator message grows a scary ⚠️ notice and the detector becomes noise - the
// failure mode that gets a real warning ignored later.
//
// So this drives ordinary traffic and asserts silence: a /new, then several in-topic turns of
// different shapes (instant reply, a turn that runs tools for a while, a fast follow-up sent while
// the previous turn is still running - that last one is the case the `idle`-only arm guard exists
// for). Every message must produce a reply and *no* notice.
//
// Usage: node turn-watchdog-check.js [--keep]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect, openGroup, openTopic, openTopicByTitle, sendMessage, getMessageTexts, getMaxMessageId, waitForMessagesAfter } = require("./client.js");

const RUN_ID = String(Date.now()).slice(-6);
const TITLE = `turn watchdog check ${RUN_ID}`;
const NOTICE = "never started a turn";
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);

(async () => {
  const keep = process.argv.includes("--keep");
  let slug = null;
  let context;
  try {
    let page;
    ({ context, page } = await connect());
    await openGroup(page);

    await openTopic(page, "General");
    const createMid = await getMaxMessageId(page);
    await sendMessage(page, `/new aibridge ${TITLE}. Reply with the single word READY and wait.`);
    const created = await waitForMessagesAfter(page, createMid, { rounds: 40, intervalMs: 3000, match: (t) => t.includes('Created "') });
    slug = created.find((t) => t.includes('Created "'))?.match(/Created "([^"]+)"/)?.[1] ?? null;
    if (!slug) throw new Error("no session was created");
    log(`created session "${slug}"`);

    // The /new prompt is itself the first watched message - the exact path that produced the live
    // failure this whole feature came from, so its silence is part of the result.
    await openTopicByTitle(page, TITLE);
    const readyTexts = await waitForMessagesAfter(page, await getMaxMessageId(page), { rounds: 40, intervalMs: 3000, match: (t) => /^\s*READY\s*$/m.test(t) });
    if (!readyTexts.some((t) => /^\s*READY\s*$/m.test(t))) throw new Error("session never reported READY - cannot judge anything about watchdog noise on a session that never started");
    log("session reported READY (the /new prompt became a turn)");

    // Three shapes, deliberately different. (2) runs long enough to cross the 20s window while
    // genuinely working; (3) is sent immediately behind it, i.e. into a session that is *not* idle,
    // which is the case the arm guard exists for and the most likely source of a false positive.
    const turns = [
      { label: "instant reply", text: `Reply with exactly DONE-1-${RUN_ID} and nothing else.`, token: `DONE-1-${RUN_ID}` },
      { label: "tool-using turn", text: `List the files in the repo root with ls, then read package.json, then reply with exactly DONE-2-${RUN_ID}.`, token: `DONE-2-${RUN_ID}` },
      { label: "follow-up sent behind a running turn", text: `Reply with exactly DONE-3-${RUN_ID}.`, token: `DONE-3-${RUN_ID}`, noWait: true },
    ];

    for (const turn of turns) {
      await openTopicByTitle(page, TITLE);
      const mid = await getMaxMessageId(page);
      await sendMessage(page, turn.text);
      if (turn.noWait) {
        log(`sent "${turn.label}" without waiting - it queues behind the previous turn`);
        continue;
      }
      const texts = await waitForMessagesAfter(page, mid, { rounds: 60, intervalMs: 3000, match: (t) => t.includes(turn.token) && !t.includes("Reply with exactly") });
      if (!texts.some((t) => t.includes(turn.token))) throw new Error(`"${turn.label}" never completed - refusing to score watchdog noise on a turn that may itself have wedged`);
      log(`"${turn.label}" completed`);
    }

    // The queued follow-up has to be given longer than the watchdog's own window to come back, or
    // "no notice yet" is just "not enough time has passed" wearing the shape of a pass.
    const tailMid = await getMaxMessageId(page);
    await waitForMessagesAfter(page, tailMid, { rounds: 20, intervalMs: 3000, match: (t) => t.includes(`DONE-3-${RUN_ID}`) });

    const all = await getMessageTexts(page, 60);
    const notices = all.filter((t) => t.includes(NOTICE));
    const answered = [1, 2, 3].filter((n) => all.some((t) => t.includes(`DONE-${n}-${RUN_ID}`) && !t.includes("Reply with exactly")));
    log(`turns answered: ${answered.join(", ") || "(none)"}`);
    log(`watchdog notices seen: ${notices.length}`);
    for (const n of notices) log(`  notice: ${JSON.stringify(n.slice(0, 200))}`);

    // Both halves are required. Zero notices on a session where nothing ever ran is the vacuous pass
    // this rig keeps rediscovering, so the turns must also have actually happened.
    const pass = notices.length === 0 && answered.length === 3;
    console.log(`RESULT|slug=${slug}|turns_answered=${answered.length}/3|false_positive_notices=${notices.length}|${pass ? "PASS" : "FAIL"}`);

    if (!keep) {
      await openTopic(page, "General");
      await sendMessage(page, `/kill ${slug}`);
      await page.waitForTimeout(3000);
      await sendMessage(page, `/remove ${slug}`);
      await page.waitForTimeout(3000);
      log(`cleaned up session "${slug}"`);
    }
    await context.close();
  } catch (err) {
    log(`ERROR: ${err.stack ?? err}`);
    if (context) await context.close().catch(() => {});
    process.exitCode = 1;
  }
})();
