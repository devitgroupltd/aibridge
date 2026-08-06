// §13 manual check 4 ("terminal race") automated end to end, no human interaction.
//
// Launches one throwaway session with a prompt that raises a real ask-gated permission card
// (a `Write`), then - instead of tapping the Telegram button - answers "at the terminal" via the
// Bridge's own dev-only diagnostic endpoint (`AIBRIDGE_DEV_CONTROL_PORT`, index.ts's `/write?slug=`
// loopback HTTP server, added 2026-08-04 "to send a raw keystroke to a fleet session with no other
// manual-launch wiring") - a real raw PTY write reaching the same ConPTY input stream a human's
// keystrokes at an actual terminal would. Per §6.5, resolution has no protocol event: the Bridge
// heuristically pairs a `PostToolUse` matching a pending prompt's `(session_id, tool_name,
// tool_input)` and edits the card to "✅ allowed (answered at terminal)" with the keyboard
// stripped. This script confirms that edit actually happens - i.e. the card does not hang forever
// waiting for a button tap that will never come - and that the file the write was gated on was
// actually created (proving the terminal answer, not just the card, took effect).
//
// Requires the Bridge running with AIBRIDGE_DEV_CONTROL_PORT set (scripts/dev-bridge.sh start does
// this at port 8799).
//
// Usage: node terminal-race-check.js
const { connect, openGroup, openTopic, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

const DEV_CONTROL_PORT = process.env.AIBRIDGE_DEV_CONTROL_PORT ?? "8799";

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}
function now() {
  return Date.now();
}

async function writeToPty(slug, text) {
  const res = await fetch(`http://127.0.0.1:${DEV_CONTROL_PORT}/write?slug=${encodeURIComponent(slug)}`, {
    method: "POST",
    body: text,
  });
  if (!res.ok) {
    throw new Error(`dev control /write returned ${res.status}: ${await res.text()}`);
  }
}

async function pollForText(page, topicSubstring, predicate, { rounds = 20, intervalMs = 2000 } = {}) {
  for (let i = 0; i < rounds; i++) {
    await openTopic(page, topicSubstring);
    await page.waitForTimeout(500);
    const total = await getMessageCount(page);
    const texts = await getMessageTexts(page, Math.min(total, 12));
    const hit = texts.find(predicate);
    if (hit) return hit;
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

(async () => {
  const { context, page } = await connect();
  await openGroup(page);

  const tag = "[TR]";
  const prompt = `${tag} Create a file named scratch-terminal-race-test.txt containing the text 'terminal race probe' in this repo. Do not commit it.`;

  await openTopic(page, "General");
  const before = await getMessageCount(page);
  await sendMessage(page, `/new aibridge ${prompt}`);

  let slug = null;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= before) continue;
    const texts = await getMessageTexts(page, total - before);
    const created = texts.find((t) => t.includes('Created "'));
    if (created) {
      const m = created.match(/Created "([^"]+)"/);
      slug = m ? m[1] : null;
      break;
    }
  }
  if (!slug) {
    log("FAIL: no \"Created\" confirmation within timeout");
    await context.close();
    process.exit(1);
  }
  log(`session created: slug "${slug}"`);

  // Wait for the real ask-gated permission card to appear in the session's own topic. Card text
  // is rendered by permission-callback.ts's renderPermissionCard: "🔐 <slug> wants to run <tool>".
  const cardAppearedAt = now();
  const card = await pollForText(page, tag, (t) => /wants to run/i.test(t), {
    rounds: 20,
    intervalMs: 2000,
  });
  if (!card) {
    log("FAIL: no permission card appeared within timeout");
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(1500);
    await sendMessage(page, `/rm ${slug}`);
    await context.close();
    process.exit(1);
  }
  const cardLatencyMs = now() - cardAppearedAt;
  log(`permission card appeared after ${cardLatencyMs}ms: ${card.slice(0, 120)}`);

  // Answer "at the terminal" instead of tapping the Telegram button - Enter selects the TUI's
  // highlighted default option, which is "1. Yes".
  await writeToPty(slug, "\r");
  log(`wrote a raw Enter to slug "${slug}"'s PTY via the dev control port (simulated terminal answer)`);

  // Confirm the Telegram card resolves on its own via the PostToolUse heuristic, without ever
  // being tapped - the actual thing this check verifies.
  const resolvedAt = now();
  const resolved = await pollForText(page, tag, (t) => /answered at terminal|✅/i.test(t), {
    rounds: 15,
    intervalMs: 2000,
  });
  const resolutionLatencyMs = now() - resolvedAt;

  if (!resolved) {
    log("FAIL: permission card never resolved after the terminal answer - it hung, exactly the bug this check guards against");
  } else {
    log(`card resolved after ${resolutionLatencyMs}ms: ${resolved.slice(0, 120)}`);
  }

  console.log(
    JSON.stringify(
      {
        slug,
        cardLatencyMs,
        resolvedWithoutTap: Boolean(resolved),
        resolutionLatencyMs: resolved ? resolutionLatencyMs : null,
      },
      null,
      2,
    ),
  );

  await sendMessage(page, `/kill ${slug}`);
  await page.waitForTimeout(1500);
  await sendMessage(page, `/rm ${slug}`);
  await page.waitForTimeout(1500);
  log("cleanup sent (kill + rm)");

  await context.close();
  process.exit(resolved ? 0 : 1);
})();
