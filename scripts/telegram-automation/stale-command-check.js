// §13 check 3, the stale command - **fully automated: no sleep, no lid, no operator present.**
//
// Check 3 reads "Send 'push it' while the machine is asleep. On resume it is confirmed, not
// executed", and §13's status line claimed it "needs a real 30-minute sleep, which no script can
// perform". Both halves of that turned out to be wrong on this host, in opposite directions:
//
//  1. **There is no lid to close.** This machine is a VMware guest (`Win32_ComputerSystem` reports
//     `VMware, Inc.`, no battery, chassis type 1) and `powercfg /q SCHEME_CURRENT SUB_BUTTONS`
//     contains exactly one setting - "Start menu power button". Windows only publishes a lid-close
//     action when a lid exists, so the check as literally worded is not merely unautomated here,
//     it is unrunnable *by anyone*, the operator included. `powercfg /a` also reports S3, hibernate
//     and S0 Low Power Idle as all unsupported; only S1 is available.
//
//  2. **Sleeping was never the mechanism under test.** The gate is `isStaleInbound(message.date,
//     Date.now())` - pure wall-clock arithmetic against Telegram's own server-side timestamp. A
//     suspended machine is just *one* way to make the Bridge miss a message for 30 minutes, and
//     `stale-inbound.ts`'s own doc comment names the other one in the same breath: "Telegram queues
//     updates for 24 hours while the Bridge is offline (laptop asleep, **process down**)". A
//     stopped Bridge produces a byte-identical condition - same backlog burst on the same
//     `getUpdates` call, same `message.date`, same comparison - through the identical production
//     path, with real Telegram on the other end. Nothing is simulated here and no clock is faked.
//
// So this script stops the Bridge, sends a command, waits out the real 30-minute threshold, starts
// the Bridge, and measures what happens to the backlog. The 30 minutes are real; they just do not
// need anybody sitting in front of the machine.
//
// ## The load-bearing assertion is the *third* one
//
// "Not executed" on its own is a check that cannot fail for the right reason - §13 check 6's whole
// lesson. A Bridge that dropped the stale message on the floor, or never received it, would satisfy
// "not executed" perfectly while being a considerably worse bug than the one this guards against:
// the operator's command would be silently lost rather than silently run. So the run does not stop
// at the card. It taps **Yes, still want this** and requires the command to then execute. Only the
// pair - inert before the tap, executed after it - distinguishes "held pending confirmation" from
// "lost", and that distinction is the entire point of §7.4's design.
//
// `--rehearse` is the fourth assertion, and the control for the other three: it runs the same flow
// with no wait at all, so the message is fresh, and inverts the expectation - **no** card, and the
// command executes immediately. That is what pins the card in the full run to the message's age
// rather than to anything about its text, the topic, or the restart. It also exercises every
// selector in about four minutes, which is worth doing before committing to a 35-minute run.
//
// ## Deliberate deviation: the command is not `git push`
//
// Same reasoning as check 7's two recorded deviations. `push it` against a real repo is an
// irreversible side effect belonging to a check whose entire premise is that the side effect must
// not happen, and - worse for the measurement - a push that simply never happened is indistinguishable
// from a message that was never delivered, which is precisely the confound the Yes-tap exists to
// remove. A command whose execution is *positively* observable in the topic makes both halves
// visible: the token is absent while the card is up, and present within seconds of the tap.
//
// ## It creates its own session
//
// The first draft took a topic substring and ran against whatever was there. That failed on its
// first run for a reason worth keeping: the topic it was pointed at belonged to a session `/ls`
// reported as `dead`, so nothing could have executed and "not executed" was true for entirely the
// wrong reason. Owning the session removes the confound, and the run refuses to start if the
// session never comes up.
//
// Usage:
//   node stale-command-check.js              full run, ~35 min (the Bridge is down for ~32 of them)
//   node stale-command-check.js --rehearse   control run, ~4 min, Bridge stays up
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  connect,
  openGroup,
  openTopic,
  openTopicByTitle,
  sendMessage,
  getMessageTexts,
  getMaxMessageId,
  waitForMessagesAfter,
  buttonByLabel,
} = require("./client.js");

/** Mirrors `STALE_INBOUND_THRESHOLD_MS` in packages/bridge/src/stale-inbound.ts - and is checked
 * against it at startup, see `assertThresholdMatches`. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
/** Clears the `>` in `isStaleInbound` plus poll jitter and the Bridge's own startup time. */
const MARGIN_MS = 2 * 60 * 1000;

const TAG = "[SC-3]";
const TOKEN = "STALE-REPLAY-OK";
// Unique per run, and that is load-bearing rather than tidy. A fixed title meant the rehearsal and
// the real run created two topics with byte-identical titles, and `openTopicByTitle` takes
// `.first()` - which is chatlist order, i.e. most-recent-activity, i.e. it can resolve to a
// different one of the two between the send and the observation half an hour later. This is trap
// (1) from CLAUDE.md one level down: `openTopicByTitle` fixes matching on the last-message preview,
// it does nothing about two topics that genuinely share a title.
const RUN_ID = String(Date.now()).slice(-6);
const TITLE = `Stale-command check session ${RUN_ID}`;
const SETUP_PROMPT = `${TAG} ${TITLE}. Reply with the single word READY and then wait for further instructions.`;
// The tag is what keeps the token unambiguous: the stale prompt contains the token, and so does the
// confirm card (it echoes the original message as its preview). Only the session's own reply carries
// the token *without* the tag, so that is what "executed" is detected by.
//
// Deliberately *not* "and do not run any tool": in this architecture a session answers the operator
// by calling the `reply` tool, so that instruction would suppress the very reply this check measures.
const STALE_PROMPT = `${TAG} Reply with exactly the single token ${TOKEN} and nothing else.`;

const DEV_BRIDGE = path.join(__dirname, "..", "dev-bridge.sh").replace(/\\/g, "/");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function bridge(cmd) {
  return execFileSync("bash", [DEV_BRIDGE, cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const bridgeRunning = () => bridge("status").startsWith("running");

/** Reads the threshold out of the Bridge's own source instead of trusting this file's copy. A check
 * whose wait is shorter than the constant it is testing passes for the wrong reason on every run and
 * looks exactly like a working check while doing it. */
function assertThresholdMatches() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "packages", "bridge", "src", "stale-inbound.ts"), "utf8");
  const m = src.match(/STALE_INBOUND_THRESHOLD_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
  if (!m) throw new Error("could not read STALE_INBOUND_THRESHOLD_MS from stale-inbound.ts");
  const actual = Number(m[1]) * Number(m[2]) * Number(m[3]);
  if (actual !== STALE_THRESHOLD_MS) {
    throw new Error(`threshold drift: stale-inbound.ts says ${actual}ms, this script waits ${STALE_THRESHOLD_MS}ms`);
  }
}

/** The session's own reply: carries the token but not the tag (see the TAG comment above). */
const isExecuted = (t) => t.includes(TOKEN) && !t.includes(TAG);
const isCard = (t) => t.includes("received while offline");

async function sleepWithProgress(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const left = until - Date.now();
    log(`waiting out the staleness threshold - ${Math.ceil(left / 60000)} min left`);
    await new Promise((r) => setTimeout(r, Math.min(60000, left)));
  }
}

(async () => {
  const rehearse = process.argv.includes("--rehearse");
  assertThresholdMatches();
  if (!bridgeRunning()) throw new Error("the Bridge is not running - start it first; this check stops and restarts it itself");

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (!bridgeRunning()) {
      log("restoring the Bridge");
      bridge("start");
    }
  };
  process.on("exit", restore);

  const verdict = { card: false, inertBeforeTap: false, executedAfterTap: false };

  try {
    let { context, page } = await connect();
    await openGroup(page);

    // --- own the session, so "not executed" cannot be true merely because nothing was alive ------
    await openTopic(page, "General");
    const createMid = await getMaxMessageId(page);
    await sendMessage(page, `/new aibridge ${SETUP_PROMPT}`);
    const created = await waitForMessagesAfter(page, createMid, { rounds: 30, intervalMs: 2000, match: (t) => t.includes('Created "') });
    const slug = created.find((t) => t.includes('Created "'))?.match(/Created "([^"]+)"/)?.[1] ?? null;
    if (!slug) throw new Error("no session was created - refusing to measure a topic with nothing behind it");
    log(`created session "${slug}"`);

    // The session must actually answer once before the real test, otherwise a session that is up but
    // wedged would look identical to one correctly holding a stale command.
    await openTopicByTitle(page, TITLE);
    const readyMid = await getMaxMessageId(page);
    const ready = await waitForMessagesAfter(page, readyMid, { rounds: 40, intervalMs: 3000, match: (t) => /\bREADY\b/.test(t) && !t.includes(TAG) });
    if (!ready.length) throw new Error(`session "${slug}" never answered its first turn - it is not healthy enough to measure`);
    log("session answered its first turn; it is live");

    const baselineMid = await getMaxMessageId(page);
    await context.close();

    // --- go offline, then send. Order matters: a Bridge that is still polling consumes the message
    //     immediately and there is no backlog left to be stale. ---
    if (!rehearse) {
      log("stopping the Bridge");
      bridge("stop");
      if (bridgeRunning()) throw new Error("the Bridge is still running after stop - aborting rather than measuring nothing");
      log("the Bridge is down; Telegram will queue the message for up to 24h");
    } else {
      log("rehearsal: Bridge stays up, so the message arrives fresh and must NOT raise a card");
    }

    ({ context, page } = await connect());
    await openGroup(page);
    await openTopicByTitle(page, TITLE);
    await sendMessage(page, STALE_PROMPT);
    log(`sent at ${new Date().toISOString()}`);
    await context.close();

    // --- the wait. Real minutes against Telegram's own `message.date`; nothing is faked. ---
    if (!rehearse) {
      await sleepWithProgress(STALE_THRESHOLD_MS + MARGIN_MS);
      log("starting the Bridge - it will now poll a backlog holding a >30-minute-old command");
      bridge("start");
    }

    // --- observe ---
    ({ context, page } = await connect());
    await openGroup(page);
    await openTopicByTitle(page, TITLE);
    const after = await waitForMessagesAfter(page, baselineMid, {
      rounds: 40,
      intervalMs: 3000,
      match: rehearse ? isExecuted : isCard,
    });
    verdict.card = after.some(isCard);
    verdict.inertBeforeTap = !after.some(isExecuted);
    const ageLabel = (after.find(isCard) || "").match(/received while offline \(([^)]+)\)/)?.[1] ?? "none";
    log(`card: ${verdict.card} (age: ${ageLabel}); executed before any tap: ${!verdict.inertBeforeTap}`);

    if (rehearse) {
      const ok = !verdict.card && !verdict.inertBeforeTap;
      log(`topic tail: ${JSON.stringify(await getMessageTexts(page, 6))}`);
      console.log(`RESULT|rehearse|slug=${slug}|card=${verdict.card}|executed=${!verdict.inertBeforeTap}|${ok ? "PASS" : "FAIL"}`);
      await context.close();
      restore();
      process.exit(ok ? 0 : 1);
    }

    // --- the assertion that makes the other two mean something: held, not lost ---
    if (verdict.card && verdict.inertBeforeTap) {
      const yes = buttonByLabel(page, "Yes, still want this");
      if ((await yes.count()) === 0) throw new Error("card has no 'Yes, still want this' button - cannot prove the message was held rather than lost");
      const beforeTapMid = await getMaxMessageId(page);
      await yes.last().click({ force: true });
      log("tapped 'Yes, still want this' - the command must now execute");
      const replayed = await waitForMessagesAfter(page, beforeTapMid, { rounds: 40, intervalMs: 3000, match: isExecuted });
      verdict.executedAfterTap = replayed.some(isExecuted);
    }

    const pass = verdict.card && verdict.inertBeforeTap && verdict.executedAfterTap;
    log(`topic tail: ${JSON.stringify(await getMessageTexts(page, 8))}`);
    console.log(
      `RESULT|slug=${slug}|card=${verdict.card}|inertBeforeTap=${verdict.inertBeforeTap}|executedAfterTap=${verdict.executedAfterTap}|${pass ? "PASS" : "FAIL"}`,
    );
    await context.close();
    restore();
    process.exit(pass ? 0 : 1);
  } catch (err) {
    restore();
    log(`ERROR: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
})();
