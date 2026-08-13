// One-off: §13 manual check 6 ("rate storm") automated end to end, no human interaction.
// Launches three throwaway sessions via /new plus reuses the existing idle `test-session` -
// four Sonnet units total, exactly WEIGHTED_CAP (concurrency-cap.ts) - all doing tool-heavy work
// at once, one of them (RS3) ending in a real ask-gated git commit. While all four are mid-turn,
// repeatedly probes /ls from the control topic to measure whether P0 traffic stays responsive
// under P2 feed pressure, and separately measures how long a real permission card takes to
// appear/resolve during the same storm. Cleans up the three throwaway sessions afterward;
// `test-session` is left alone (idle, as it started).
//
// The permission half depends on RS3 actually raising a card, which depends on that session's
// auto-permission being OFF - and new sessions inherit `/default permission`, which the operator
// may well have left ON. Live 2026-08-13 that is exactly what happened: every RS3 commit was
// silently auto-allowed, no card was ever raised, and this script reported
// "FAIL: no permission card appeared" for a pure configuration reason - a red verdict it had not
// earned, indistinguishable from a real starvation failure. So the run now turns bypass off for
// its own RS3 session (never the operator's global `/default`, which is theirs and must survive a
// crashed run), and if a card still fails to appear it reads RS3's topic to tell "bypass beat us"
// apart from "the storm starved P0" instead of blaming the Bridge for either.
//
// Fixing that surfaced two further reasons this half had never once measured anything, both in the
// probe rather than the Bridge - it was looking in the wrong topic (see `waitForButton`) for a
// button label that cannot exist in the DOM (see `buttonByLabel` in client.js). So its
// "FAIL: no permission card appeared" was never a finding: the check had been reporting red since
// the day it was written, against cards that were on screen the whole time.
//
// Usage: node rate-storm-check.js
const { connect, openGroup, openTopic, openTopicByTitle, sendMessage, getMessageTexts, getMaxMessageId, waitForMessagesAfter, buttonByLabel } = require("./client.js");

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}
function now() {
  return Date.now();
}

// Keyed on `data-mid`, not the rendered bubble count: Web K prunes bubbles out of the DOM as the
// topic fills, so under exactly the load this check creates a count baseline stops growing and every
// round times out against replies that did arrive (see getMaxMessageId in client.js). The `match`
// skips the echo of the command itself so the measured latency is time-to-*reply*.
async function sendAndWait(page, topicSubstring, text, { rounds = 15, intervalMs = 2000 } = {}) {
  await openTopic(page, topicSubstring);
  await page.waitForTimeout(800);
  const afterMid = await getMaxMessageId(page);
  const t0 = now();
  await sendMessage(page, text);
  const texts = await waitForMessagesAfter(page, afterMid, { rounds, intervalMs, match: (t) => !t.startsWith(text) });
  return { elapsedMs: now() - t0, texts };
}

// `openTopicByTitle`, not `openTopic`: the latter matches the whole chatlist row *including the
// last-message preview*, and the control topic's preview still reads `/new aibridge [RS3] ...` from
// this run's own session creation - so an `openTopic(page, "[RS3]")` matches the control topic too,
// and `.first()` picks it because the /ls probe loop just made it the most recently active row.
// Live 2026-08-13: every round of this probe was hunting for an Allow button in the control topic
// while the real card sat unread in RS3's own topic, and the run reported "no permission card
// appeared" - a Bridge failure that never happened. Same pitfall always-rule-check.js hit on
// 2026-08-12; see openTopicByTitle's doc comment. Session topics are titled from their prompt, so
// the "[RS3]" tag prefixed to that prompt is what matches here.
async function waitForButton(page, topicTitleSubstring, buttonText, { rounds = 8, intervalMs = 3000 } = {}) {
  const t0 = now();
  for (let i = 0; i < rounds; i++) {
    await openTopicByTitle(page, topicTitleSubstring);
    await page.waitForTimeout(500);
    const btn = buttonByLabel(page, buttonText).last();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      return { elapsedMs: now() - t0, btn };
    }
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

// RS3's commit path can raise more than one card (Write, `git add`, `git commit` are each
// independently ask-gated/unlisted) - resolve every card that appears rather than assuming
// exactly one, stopping once none appears within the window.
async function resolveAllPrompts(page, topicTitleSubstring, { maxTaps = 5 } = {}) {
  const taps = [];
  for (let i = 0; i < maxTaps; i++) {
    const found = await waitForButton(page, topicTitleSubstring, "Allow"); // no emoji - see buttonByLabel
    if (!found) break;
    await found.btn.click({ force: true });
    taps.push(found.elapsedMs);
    log(`tapped "Allow" #${taps.length} for ${topicTitleSubstring} after ${found.elapsedMs}ms wait`);
    await page.waitForTimeout(2500);
  }
  return taps;
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);

  const prompts = [
    {
      tag: "[RS1]",
      text: '[RS1] Run "git log --oneline -20" in this repo, then reply with just the most recent commit\'s one-line summary. Do not modify anything.',
    },
    {
      tag: "[RS2]",
      text: '[RS2] Run "rg -n TODO packages/bridge/src" in this repo and reply with how many matches you found. Do not modify anything.',
    },
    {
      tag: "[RS3]",
      text: "[RS3] Create a file named scratch-rate-storm-test.txt containing the text 'throwaway rate-storm test', then git add it and git commit -m \"rate-storm test commit (throwaway, safe to discard)\". This is a disposable test branch, safe to commit to.",
    },
  ];

  const slugs = [];
  await openTopic(page, "General");
  for (const p of prompts) {
    const afterMid = await getMaxMessageId(page);
    const t0 = now();
    await sendMessage(page, `/new aibridge ${p.text}`);
    const created = await waitForMessagesAfter(page, afterMid, { rounds: 15, intervalMs: 2000, match: (t) => t.includes('Created "') });
    const matched = created.find((t) => t.includes('Created "')) ?? null;
    const elapsed = now() - t0;
    if (!matched) {
      log(`FAIL: no "Created" confirmation for ${p.tag} within timeout`);
      slugs.push(null);
      continue;
    }
    const m = matched.match(/Created "([^"]+)"/);
    const slug = m ? m[1] : null;
    log(`${p.tag} -> slug "${slug}" (confirmed in ${elapsed}ms)`);
    slugs.push(slug);

    // RS3 is the only session whose permission behaviour is measured, so it is the only one whose
    // bypass we touch. Sent immediately on confirmation rather than later: the session is already
    // booting `claude` and its first ask-gated call (the Write) is seconds away, so every step
    // between here and this command is a step the race can be lost in.
    if (p.tag === "[RS3]" && slug) {
      const r = await sendAndWait(page, "General", `/auto permission ${slug} off`, { rounds: 10, intervalMs: 1000 });
      const confirmed = r.texts.some((t) => t.includes("Auto-permission is now off"));
      log(
        confirmed
          ? `[RS3] auto-permission off confirmed in ${r.elapsedMs}ms - commit will raise a real card`
          : `WARN: no "Auto-permission is now off" confirmation for "${slug}" - the permission half below may be measuring nothing`,
      );
    }
    await page.waitForTimeout(1500);
  }

  // The existing idle `test-session` occupies the 4th weighted unit just by existing - it isn't
  // actively poked here. Its real Telegram topic title is whatever prompt originally launched it
  // (not its slug), which drifts session to session and risks colliding with older leftover
  // topics sharing similar text (confirmed live 2026-08-06: this step crashed on exactly that
  // ambiguity) - not worth the fragility for what's a minor addition to storm coverage.
  log("test-session (4th weighted unit) left idle - not actively poked, see comment above");

  // P0 responsiveness probe: repeated /ls against the control topic while all four sessions are
  // mid-turn and the feed is under load from three concurrent sessions' tool calls.
  const lsLatencies = [];
  for (let round = 0; round < 5; round++) {
    const r = await sendAndWait(page, "General", "/ls", { rounds: 15, intervalMs: 1500 });
    lsLatencies.push(r.elapsedMs);
    log(`/ls round ${round + 1}: ${r.elapsedMs}ms`);
    await page.waitForTimeout(4000);
  }

  // Permission-card probe: RS3's write+commit path should raise one or more real ask-gated
  // cards. Resolve all of them and record how long the first one took to appear - proving P0
  // (permission delivery) isn't starved by the P2 feed storm from the other three sessions.
  let permTaps = [];
  let permOutcome = "skipped";
  if (slugs[2]) {
    permTaps = await resolveAllPrompts(page, "[RS3]");
    if (permTaps.length > 0) {
      permOutcome = "measured";
    } else {
      // No card is two very different findings and the difference is visible in RS3's own topic:
      // the Bridge posts a note naming *why* it auto-allowed. `auto permission` means this run's
      // `/auto permission off` lost the race against RS3's first ask-gated call, so the storm was
      // never actually put to the test - a rig miss, not a Bridge failure, and reporting it as FAIL
      // is what made this check untrustworthy in the first place. Anything else really is P0
      // delivery failing under P2 load, which is the whole point of check 6.
      await openTopicByTitle(page, "[RS3]");
      await page.waitForTimeout(800);
      const tail = await getMessageTexts(page, 40);
      if (tail.some((t) => t.includes("auto-approved (auto permission)"))) {
        permOutcome = "inconclusive-bypass-race";
        log('INCONCLUSIVE: RS3\'s prompts were auto-allowed by auto-permission before "/auto permission off" took effect - permission latency not measured this run (rig race, not a Bridge failure)');
      } else {
        permOutcome = "fail-no-card";
        log("FAIL: no permission card appeared for [RS3] within timeout, and nothing auto-allowed it either - P0 permission delivery genuinely did not arrive under storm load");
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        slugs,
        lsLatenciesMs: lsLatencies,
        permOutcome,
        // Time from *this probe starting to look* to the card being on screen - not request->card,
        // which needs the moment Claude escalated and is only visible in bridge.log. The probe runs
        // after the /ls loop, so a value at the first poll (~2s, the openTopicByTitle settle) means
        // the card was already up and waiting throughout the storm, which is the pass condition
        // check 6 actually cares about. Cross-check the true latency in bridge.log against
        // `hook client connected for event "PermissionRequest"` for the same slug.
        permCardFoundAfterMs: permTaps[0] ?? null,
        allPermTapFoundAfterMs: permTaps,
      },
      null,
      2,
    ),
  );

  // Cleanup: kill + rm the three throwaway sessions. test-session is left alone (idle, as it
  // started) - it isn't this script's to remove.
  await openTopic(page, "General");
  for (const slug of slugs) {
    if (!slug) continue;
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(2000);
    await sendMessage(page, `/remove ${slug}`);
    await page.waitForTimeout(2000);
  }
  log("cleanup sent (kill + rm for each throwaway session)");

  await context.close();
})();
