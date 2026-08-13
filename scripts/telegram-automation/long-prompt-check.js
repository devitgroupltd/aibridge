// P2-7 (codebase-hardening-plan.md): a long `/new` prompt reached the session with its middle
// missing - it replied "Your message came through truncated, I'm missing step 1 entirely" while the
// Telegram side showed the message complete. Observed once on 2026-08-13 and undiagnosed, which is
// what this script is for: it makes the failure *measurable* instead of anecdotal.
//
// The prompt is built from numbered position markers (`A01 A02 ... Ann`) padded to a target length,
// so the session's reply doesn't just say whether something was lost - it says exactly *where*. A
// gap in the middle of the marker sequence is a dropped chunk; a truncated tail is a length cap; a
// missing head is the reader starting late. Those are three different bugs needing three different
// fixes, and no amount of re-reading `sendChannelText` distinguishes between them.
//
// Two write paths, which are not the same situation:
//   `/new`   - the very first write into a brand-new PTY, immediately after the three startup gates
//              (`session.ready`, `waitForChannelConnected`, `waitForPtyQuiet`). The live failure was
//              on this one.
//   in-topic - an ordinary later turn into a settled session: the same `sendChannelText` code path
//              with none of the startup timing around it.
// If only `/new` loses bytes the fault is in the startup sequence; if both do, it is the write.
//
// **Every round uses its own marker letter (A, B, C, ...), and that is load-bearing, not tidiness.**
// The first version keyed on a shared `M` prefix and matched the *previous* round's reply, still on
// screen, "confirming" an intact delivery for a round whose message had barely been sent. Same class
// of vacuous-green result as the three traps in client.js's doc comments.
//
// Usage: node long-prompt-check.js [len1] [len2] ...     (default: 1500 2500 3500)
//   The first length goes through `/new`; the rest are sent into that session's own topic.
const { connect, openGroup, openTopic, openTopicByTitle, sendMessage, getMessageTexts, getMaxMessageId, waitForMessagesAfter } = require("./client.js");

const LENGTHS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const TARGETS = LENGTHS.length > 0 ? LENGTHS : [1500, 2500, 3500];
const TAG = "[LPC]";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * One line, no newlines anywhere: `sendMessage` types into Telegram's composer, where Enter *sends*,
 * so a multi-line prompt is posted as one message per line (that is P1-13's trigger, not this one -
 * see sandbox-check.js's own note).
 */
function buildMarkedBody(letter, targetChars) {
  // Filler between the markers rather than markers alone: a wall of `A01 A02 A03` is not a realistic
  // prompt shape, and what is being measured is a byte count moving through a pipe, so there has to
  // be text between the markers for a dropped chunk to take with it.
  const FILLER = "and then keep reading past this filler to";
  const markers = [];
  let body = "";
  let n = 1;
  while (body.length < targetChars) {
    const marker = `${letter}${String(n).padStart(2, "0")}`;
    markers.push(marker);
    body += `${marker} ${FILLER} `;
    n += 1;
  }
  return { markers, body: body.trim() };
}

// The reply must be distinguishable from the prompt's own echo, which necessarily *describes* the
// answer format. The literal `MARKERS|` never appears in a prompt - it is spelled out in words - so
// only a real reply can match it. sandbox-check.js hit exactly this trap and "finished" 11s in
// against its own instructions.
function answerFor(letter) {
  return new RegExp(`MARKERS\\s*\\|\\s*((?:${letter}\\d{2}[\\s,]*)+)`, "i");
}

function ask(letter) {
  return `Then reply with one line: the word MARKERS, a pipe, then every ${letter}-marker token you can actually see in this message, space-separated, in order. Do not invent any you cannot see and do not run any tools.`;
}

function report(name, letter, targetChars, promptChars, markers, replyText) {
  const seen = new Set((replyText.match(new RegExp(`${letter}\\d{2}`, "g")) ?? []).map((m) => m.toUpperCase()));
  const missing = markers.filter((m) => !seen.has(m));
  // Where the loss sits is the whole diagnosis: a gap between two present markers is a dropped
  // chunk, a missing tail is a length cap, a missing head is the reader starting late.
  const shape =
    missing.length === 0
      ? "intact"
      : missing[0] === markers[0]
        ? "head-missing"
        : missing[missing.length - 1] === markers[markers.length - 1]
          ? "tail-missing"
          : "middle-missing";
  return {
    name,
    letter,
    targetChars,
    promptChars,
    totalMarkers: markers.length,
    seen: seen.size,
    missing,
    firstSeen: markers.find((m) => seen.has(m)) ?? null,
    lastSeen: [...markers].reverse().find((m) => seen.has(m)) ?? null,
    shape,
  };
}

/** Keyed on this round's own letter, so a previous round's reply sitting on screen can never satisfy
 * it. `getMaxMessageId` rather than a bubble count - Web K prunes bubbles that scroll out of view,
 * so the count can fall while a reply lands (client.js's own doc comment). */
async function waitForAnswer(page, letter, rounds = 30) {
  const pattern = answerFor(letter);
  for (let round = 0; round < rounds; round++) {
    await page.waitForTimeout(10000);
    await openTopicByTitle(page, TAG);
    await page.waitForTimeout(800);
    const texts = await getMessageTexts(page, 40);
    const answer = pattern.exec(texts.join("\n"));
    if (answer) return { answer: answer[1], texts };
    log(`  round ${round + 1}: waiting for a MARKERS line carrying ${letter}-markers`);
  }
  return { answer: null, texts: [] };
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");

  const results = [];

  // --- path 1: the initial `/new` write, the one the live failure was on ----------------------
  const first = buildMarkedBody(LETTERS[0], TARGETS[0]);
  const firstPrompt = `${TAG} This is a message-delivery check by this machine's operator - nothing to build. ${first.body} ${ask(LETTERS[0])}`;
  log(`/new prompt is ${firstPrompt.length} chars with ${first.markers.length} markers (${first.markers[0]}..${first.markers[first.markers.length - 1]})`);

  let slug = null;
  {
    const afterMid = await getMaxMessageId(page);
    await sendMessage(page, `/new aibridge ${firstPrompt}`);
    const texts = await waitForMessagesAfter(page, afterMid, { rounds: 20, intervalMs: 2000, match: (t) => t.includes('Created "') });
    slug = texts.find((t) => t.includes('Created "'))?.match(/Created "([^"]+)"/)?.[1] ?? null;
  }
  if (!slug) {
    log("FAIL: no session created - cannot run any round");
    await context.close();
    process.exit(1);
  }
  log(`created session "${slug}"`);

  {
    const { answer, texts } = await waitForAnswer(page, LETTERS[0]);
    if (answer === null) {
      log("path 1 (/new): no MARKERS line came back - INCONCLUSIVE, not a pass");
      console.log("=== topic tail ===");
      for (const t of texts.slice(-8)) console.log(t.replace(/\s+/g, " ").slice(0, 300));
      results.push({ name: "new", letter: LETTERS[0], targetChars: TARGETS[0], inconclusive: true });
    } else {
      results.push(report("new", LETTERS[0], TARGETS[0], firstPrompt.length, first.markers, answer));
    }
  }

  // --- paths 2..n: ordinary later turns into the same, now-settled session --------------------
  for (let i = 1; i < TARGETS.length; i++) {
    const letter = LETTERS[i];
    const { markers, body } = buildMarkedBody(letter, TARGETS[i]);
    const prompt = `Round ${i + 1}, same rules. ${body} ${ask(letter)}`;
    // Telegram's own per-message ceiling. Worth failing loudly on rather than silently measuring a
    // message the client itself refused to send.
    if (prompt.length > 4096) {
      log(`SKIP round ${i + 1}: ${prompt.length} chars exceeds Telegram's 4096-char message limit`);
      results.push({ name: `in-topic-${i + 1}`, letter, targetChars: TARGETS[i], skipped: "over Telegram's 4096-char limit" });
      continue;
    }
    log(`round ${i + 1} prompt is ${prompt.length} chars with ${markers.length} markers (${markers[0]}..${markers[markers.length - 1]})`);
    await openTopicByTitle(page, TAG);
    await page.waitForTimeout(500);
    await sendMessage(page, prompt);
    const { answer, texts } = await waitForAnswer(page, letter);
    if (answer === null) {
      log(`round ${i + 1} (in-topic): no MARKERS line carrying ${letter}-markers came back - INCONCLUSIVE, not a pass`);
      console.log("=== topic tail ===");
      for (const t of texts.slice(-8)) console.log(t.replace(/\s+/g, " ").slice(0, 300));
      results.push({ name: `in-topic-${i + 1}`, letter, targetChars: TARGETS[i], inconclusive: true });
    } else {
      results.push(report(`in-topic-${i + 1}`, letter, TARGETS[i], prompt.length, markers, answer));
    }
  }

  console.log(JSON.stringify({ slug, results }, null, 2));
  // A round that measured nothing is neither a pass nor a failure, and must not be quietly rounded
  // into either. An earlier version reported PASS with a round still inconclusive - the same class of
  // unearned verdict this whole rig has been bitten by repeatedly.
  const measured = results.filter((r) => r.shape);
  const unmeasured = results.length - measured.length;
  const lost = measured.filter((r) => r.shape !== "intact");
  if (lost.length > 0) {
    log("REPRODUCED: at least one round lost part of its message - see `shape` and `missing` above");
  } else if (unmeasured > 0) {
    log(`INCONCLUSIVE: ${unmeasured} of ${results.length} round(s) measured nothing, so this run cannot report a pass. Re-run, and read the topic tail above for why they went unanswered.`);
  } else {
    log(`PASS: every marker survived every round (up to ${Math.max(...measured.map((r) => r.promptChars))} chars)`);
  }

  log(`session "${slug}" left in place - /kill ${slug} && /remove ${slug} to clean up`);
  await context.close();
})();
