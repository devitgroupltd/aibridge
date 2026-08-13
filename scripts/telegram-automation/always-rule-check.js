// The §12 Phase 2 open question, automated end to end, no human interaction:
//
//   "whether a running session hot-reloads its `--settings` file mid-conversation, so an `Always`
//    tap's derived rule is confirmed *written*, not confirmed *effective on the very next matching
//    call* - unverified."
//
// The gap matters because the two outcomes look identical to the Bridge: `rule-derivation.ts`
// writes `Bash(git config *)` into the session's settings file either way and reports success. If
// Claude Code only reads `--settings` at startup, every `♾️ Always allow this pattern` tap is a
// no-op for the rest of that conversation and the operator keeps tapping the same card, with
// nothing anywhere saying so.
//
// Method: one throwaway session runs `mkdir -p archeck-probe-a`, tap `♾️ Always`, confirm the rule
// really landed in the settings file, then ask the same session - same PTY, same conversation, no
// restart - to run `mkdir -p archeck-probe-b`: a *different* command that the derived rule
// (`Bash(mkdir -p *)`, `deriveAlwaysRule`'s first-two-tokens generalisation) covers. A second card
// means no hot-reload; no card plus the directory appearing means the rule took effect on the very
// next matching call.
//
// Why `mkdir` and not a read-only command: the first version of this check used
// `git config --get user.name` and never got a card at all, because Claude Code recognises
// read-only commands and approves them itself without consulting the permission relay. The command
// under test has to actually mutate something. `mkdir -p` also keeps both calls behind one derived
// rule (the first two tokens are identical), and writes only inside the throwaway worktree, which
// `/remove` deletes at the end.
//
// Three conditions all have to hold before a card can appear, and each cost this check a run when
// it didn't: the session must be in `manual` mode (the fleet default here is `auto`), it must have
// `/auto permission off` (new sessions inherit `bypass_permission=1` from `/default permission on`,
// and the Bridge then auto-allows without posting anything), and the command must not be one Claude
// Code auto-approves on its own.
//
// The topic is opened once and polled in place rather than re-opened per round (the way
// terminal-race-check.js does it): a session's topic is renamed off its slug on its first real
// `reply` (§4.4's rename-once), so re-navigating by slug substring mid-run is a race this check
// would otherwise lose.
//
// Usage: node always-rule-check.js
const fs = require("fs");
const path = require("path");
const { connect, openGroup, openTopic, openTopicByTitle, sendMessage, getMessageTexts, getMessageCount } = require("./client.js");

const STATE_DIR = path.join(process.env.LOCALAPPDATA, "aibridge");

/**
 * Two variants, because the answer differs by tool and the difference is the point:
 *
 * - `bash` - `mkdir -p a` then `mkdir -p b`, both covered by the derived `Bash(mkdir -p *)`.
 * - `write` - two `Write` calls, covered by the derived bare `Write` rule.
 *
 * `pipe-server.ts`'s own re-read-the-settings-file-and-auto-approve path (the one that makes the
 * bash variant come out clean) is gated on `msg.tool_name === "Bash"`, so the write variant is what
 * says whether `♾️ Always` means anything for every other tool.
 */
const VARIANTS = {
  bash: {
    expectedRule: "Bash(mkdir -p *)",
    first: { instruction: "Run exactly this one Bash command and nothing else: mkdir -p archeck-probe-a", artifact: "archeck-probe-a" },
    second: { instruction: "Now run exactly this one Bash command and nothing else: mkdir -p archeck-probe-b", artifact: "archeck-probe-b" },
  },
  write: {
    expectedRule: "Write",
    first: {
      instruction: "Create a file named archeck-write-a.txt containing exactly the text probe-a. Use the Write tool. Do not run any Bash command.",
      artifact: "archeck-write-a.txt",
    },
    second: {
      instruction: "Now create a file named archeck-write-b.txt containing exactly the text probe-b. Use the Write tool. Do not run any Bash command.",
      artifact: "archeck-write-b.txt",
    },
  },
};
const VARIANT_NAME = process.env.ARCHECK_VARIANT ?? "bash";
const VARIANT = VARIANTS[VARIANT_NAME];
if (!VARIANT) throw new Error(`unknown ARCHECK_VARIANT "${VARIANT_NAME}" (expected: ${Object.keys(VARIANTS).join(", ")})`);
const EXPECTED_RULE = VARIANT.expectedRule;
/** Where the two commands land, so "did it actually run?" is a filesystem check rather than a
 * text match on Telegram bubbles - the earlier text-matching version could match this script's own
 * instruction message and report a hot-reload that never happened. */
const WORKTREES_ROOT = String.raw`C:\data\worktrees`;
const CARD_RE = /wants to run/i;
/** A session topic is titled from its prompt (not its slug), so this fragment of `prompt` below is
 * what identifies the topic in the sidebar. Keep the two in sync. */
const TOPIC_TITLE_HINT = "Reply with the single word";

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function readSettingsRules(slug) {
  const file = path.join(STATE_DIR, "sessions", slug, "settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed.permissions?.allow ?? [];
  } catch (err) {
    log(`could not read ${file}: ${err.message}`);
    return null;
  }
}

/** Polls the *currently open* topic for a bubble past `baseline` matching `predicate`. */
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

(async () => {
  const { context, page } = await connect();
  await openGroup(page);

  // The session is created with a deliberately inert prompt and only *then* switched to manual
  // mode: the fleet's default session mode is whatever `/default mode` last set (currently `auto`),
  // and in auto mode Claude Code approves a `git config` call itself without ever consulting the
  // permission relay - a first run of this check produced no card at all for exactly that reason,
  // which would have read as "hot-reload works" if the script hadn't demanded positive evidence.
  const prompt = `archeck Reply with the single word ready and then wait. Do not run any command, do not read or write any file.`;

  await openTopicByTitle(page, "General");

  // Clear the dead row a previous run of this script may have left behind (its own cleanup `/rm`
  // is sent at exit and can lose the race with the browser closing). Deliberately per-slug rather
  // than `/remove --dead`, which would also sweep unrelated dead rows the operator may want kept.
  const stale = process.env.ARCHECK_STALE_SLUG;
  if (stale) {
    await sendMessage(page, `/remove ${stale}`);
    await page.waitForTimeout(3000);
    log(`sent cleanup /remove for a previous run's leftover slug "${stale}"`);
  }

  const controlBaseline = await getMessageCount(page);
  await sendMessage(page, `/new aibridge ${prompt}`);

  // 90s, not 30s: `/new` creates the topic, cuts a worktree and spawns a PTY before it confirms,
  // and a first run of this check timed out at 30s on a launch that had genuinely failed - the
  // real reason ("Failed to launch session ...") was sitting in the control topic unread, so the
  // failure branch below now reports that text instead of a bare timeout.
  let slug = null;
  let launchFailure = null;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const total = await getMessageCount(page);
    if (total <= controlBaseline) continue;
    const texts = await getMessageTexts(page, total - controlBaseline);
    launchFailure = texts.find((t) => t.includes("Failed to launch session")) ?? null;
    if (launchFailure) break;
    const created = texts.find((t) => t.includes('Created "'));
    if (created) {
      slug = created.match(/Created "([^"]+)"/)?.[1] ?? null;
      break;
    }
  }
  if (launchFailure) {
    log(`FAIL: /new reported a launch failure: ${launchFailure.replace(/\n/g, " | ")}`);
    await context.close();
    process.exit(1);
  }
  if (!slug) {
    log('FAIL: no "Created" confirmation within 90s');
    await context.close();
    process.exit(1);
  }
  log(`session created: slug "${slug}"`);

  const result = { slug, firstCardSeen: false, ruleWritten: null, secondCardSeen: null, verdict: "inconclusive" };

  // Open the session's own topic once, by *title*, and stay in it for the rest of the run. Two
  // things make `openTopic(page, slug)` wrong here, both found live: the row match would also hit
  // the control topic (whose preview then reads `Created "<slug>" ...`), and a session topic is
  // titled from its prompt, not its slug - so the slug matches no title at all.
  await openTopicByTitle(page, TOPIC_TITLE_HINT);
  await page.waitForTimeout(1000);

  const rulesBefore = readSettingsRules(slug);
  log(`settings allow-list before the tap: ${rulesBefore ? rulesBefore.length : "?"} rules, contains ${EXPECTED_RULE}: ${rulesBefore?.includes(EXPECTED_RULE)}`);

  // `/mode` is session-scoped (§4.2.2), so it goes in the session's own topic, and it drives the
  // TUI's Shift+Tab cycle over the PTY rather than editing a file. Gated on the Bridge's own
  // "Switched <slug> to manual mode" confirmation rather than a fixed sleep: without it, a command
  // that silently went nowhere (e.g. into the control topic, as two earlier runs did) reads as a
  // session that simply never raised a card.
  const modeAskedAt = await getMessageCount(page);
  await sendMessage(page, "/mode manual");
  const modeConfirmed = await pollInPlace(page, modeAskedAt, (t) => /Switched .* to manual mode/i.test(t), { rounds: 10 });
  if (!modeConfirmed) {
    log("FAIL: no 'Switched ... to manual mode' confirmation - the /mode command did not reach this session's topic");
    console.log(JSON.stringify(result, null, 2));
    await openTopicByTitle(page, "General");
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(1500);
    await sendMessage(page, `/remove ${slug}`);
    await context.close();
    process.exit(1);
  }
  log(`mode switched: ${modeConfirmed.slice(0, 80)}`);
  await page.waitForTimeout(3000);

  // Manual mode alone is not enough. `/default permission on` is set on this fleet, so every new
  // session inherits `bypass_permission = 1` and the *Bridge* auto-allows each request without ever
  // posting a card (bypass-and-autoanswer-plan.md's `/auto permission`) - found live on the third
  // run of this check, where the session ran `git config` unprompted while its TUI correctly read
  // "manual mode on". The two switches are independent: mode governs what Claude Code escalates,
  // `/auto permission` governs what the Bridge does with an escalation once it arrives.
  const autoAskedAt = await getMessageCount(page);
  await sendMessage(page, "/auto permission off");
  const autoConfirmed = await pollInPlace(page, autoAskedAt, (t) => /Auto-permission is now off/i.test(t), { rounds: 10 });
  if (!autoConfirmed) {
    log("FAIL: no 'Auto-permission is now off' confirmation - cards would be auto-allowed and never posted");
    console.log(JSON.stringify(result, null, 2));
    await openTopicByTitle(page, "General");
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(1500);
    await sendMessage(page, `/remove ${slug}`);
    await context.close();
    process.exit(1);
  }
  log(`auto-permission disabled: ${autoConfirmed.slice(0, 80)}`);
  await page.waitForTimeout(2000);

  const askedAt = await getMessageCount(page);
  await sendMessage(
    page,
    `${VARIANT.first.instruction} - then reply when it is done.`,
  );
  log(`[${VARIANT_NAME}] asked for: ${VARIANT.first.instruction}`);

  const firstCard = await pollInPlace(page, askedAt, (t) => CARD_RE.test(t), { rounds: 45 });
  if (!firstCard) {
    log(`FAIL: no permission card for the first ${VARIANT_NAME} call despite /mode manual and /auto permission off - nothing reached the permission relay, so this run measures nothing`);
    console.log(JSON.stringify(result, null, 2));
    await openTopicByTitle(page, "General");
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(1500);
    await sendMessage(page, `/remove ${slug}`);
    await context.close();
    process.exit(1);
  }
  result.firstCardSeen = true;
  log(`permission card 1: ${firstCard.slice(0, 140).replace(/\n/g, " | ")}`);

  const alwaysButton = page.locator(".reply-markup-button", { hasText: "Always allow this pattern" }).last();
  await alwaysButton.waitFor({ state: "visible", timeout: 15000 });
  await alwaysButton.click({ force: true });
  log("tapped ♾️ Always allow this pattern");
  await page.waitForTimeout(4000);

  const rulesAfter = readSettingsRules(slug);
  result.ruleWritten = Boolean(rulesAfter?.includes(EXPECTED_RULE));
  log(`settings allow-list after the tap contains ${EXPECTED_RULE}: ${result.ruleWritten}`);
  if (!result.ruleWritten) {
    log("FAIL: the tap did not write the derived rule at all - this is a different bug from the one under test");
    console.log(JSON.stringify(result, null, 2));
    await openTopicByTitle(page, "General");
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(1500);
    await sendMessage(page, `/remove ${slug}`);
    await context.close();
    process.exit(1);
  }

  // Wait for the *first* command to actually complete before asking for the second, and prove it
  // from disk rather than from a fixed sleep - if the Always tap's own allow verdict never reached
  // the session, the second half of this check would be measuring nothing.
  const firstDir = path.join(WORKTREES_ROOT, slug, VARIANT.first.artifact);
  for (let i = 0; i < 20 && !fs.existsSync(firstDir); i++) await page.waitForTimeout(1000);
  if (!fs.existsSync(firstDir)) {
    log(`FAIL: ${firstDir} never appeared - the Always tap wrote the rule but its allow verdict did not run the command`);
    console.log(JSON.stringify(result, null, 2));
    await openTopicByTitle(page, "General");
    await sendMessage(page, `/kill ${slug}`);
    await page.waitForTimeout(1500);
    await sendMessage(page, `/remove ${slug}`);
    await context.close();
    process.exit(1);
  }
  log(`first command ran: ${firstDir} exists`);
  await page.waitForTimeout(3000);

  const beforeSecond = await getMessageCount(page);
  await sendMessage(
    page,
    `${VARIANT.second.instruction} - then reply when it is done.`,
  );
  log(`[${VARIANT_NAME}] asked for the second call, covered by the freshly written ${EXPECTED_RULE}`);

  // Either a second card appears (no hot-reload) or the command runs without one. Both are checked
  // every round: a card is decisive on its own, and "no card" needs positive evidence the command
  // actually ran, or a session that merely stalled would read as a pass. That evidence is the
  // directory on disk, not a Telegram bubble - an earlier text-matching version of this check could
  // match the script's own instruction message and declare a hot-reload that never happened.
  const secondDir = path.join(WORKTREES_ROOT, slug, VARIANT.second.artifact);
  let secondCard = null;
  let ranWithoutCard = false;
  for (let i = 0; i < 45; i++) {
    const total = await getMessageCount(page);
    if (total > beforeSecond) {
      const texts = await getMessageTexts(page, total - beforeSecond);
      secondCard = texts.find((t) => CARD_RE.test(t)) ?? null;
      if (secondCard) break;
    }
    if (fs.existsSync(secondDir)) {
      ranWithoutCard = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  result.secondCardSeen = Boolean(secondCard);
  if (secondCard) {
    result.verdict = "NOT hot-reloaded - the Always rule did not take effect on the next matching call";
    log(`permission card 2 appeared: ${secondCard.slice(0, 140).replace(/\n/g, " | ")}`);
  } else if (ranWithoutCard) {
    result.verdict = "hot-reloaded - the Always rule took effect mid-conversation, no second card";
    log(`no second card; ${secondDir} exists, so the command really ran`);
  } else {
    result.verdict = "inconclusive - neither a second card nor evidence the command ran";
    log("inconclusive: no second card, but also no sign the command executed");
  }

  console.log(JSON.stringify(result, null, 2));

  await openTopicByTitle(page, "General");
  await page.waitForTimeout(1000);
  await sendMessage(page, `/kill ${slug}`);
  await page.waitForTimeout(2000);
  await sendMessage(page, `/remove ${slug}`);
  await page.waitForTimeout(2000);
  log("cleanup sent (kill + rm)");

  await context.close();
  process.exit(result.verdict.startsWith("inconclusive") ? 1 : 0);
})();
