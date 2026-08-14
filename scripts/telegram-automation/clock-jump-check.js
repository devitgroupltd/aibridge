// §13 check 2's answerable half: **a pending permission card must survive a large wall-clock jump.**
//
// Check 2 reads "Close the lid for 30 minutes with a session mid-turn. On resume, the topic shows an
// accurate state and no phantom pending prompts." On this host the literal check is unrunnable by
// anybody, operator included - it is a VMware guest with no battery, `powercfg /a` reports S3,
// hibernation and S0 Low Power Idle all unsupported (only S1), and `powercfg /q SCHEME_CURRENT
// SUB_BUTTONS` publishes no lid-close action, which Windows only does when a lid exists. There is no
// lid, and no modern standby to resume from.
//
// But "no phantom pending prompts" was never really about sleeping. It is about a **wall-clock
// jump**, and `monotonic-clock.ts` names three causes in one breath: "a laptop sleep/resume, an NTP
// correction, or a manual clock change". A suspend is only the most familiar way to provoke it. The
// failure mode that module exists to prevent is precise and worth restating: if any TTL check used
// `Date.now()`, a two-hour jump would make every pending prompt read as two hours old at once and
// the next sweep would deny them all - a mass silent denial, not a loud failure. That is exactly
// what this measures, without needing a power transition at all.
//
// Feasible here specifically because this guest's clock is free-running: `VMwareToolboxCmd timesync
// status` reports **Disabled** and `w32time` is **Stopped**, so a deliberate jump is not snapped
// back mid-measurement by the host or by NTP. Verify that again if this ever runs elsewhere - a
// silent resync would make the jump smaller than intended and the check would pass without having
// tested anything.
//
// ## What makes it fail for the right reason
//
// The mutation is a one-word edit: in `permission-registry.ts`, `this.now = opts.now ?? monotonicNowMs`
// -> `?? Date.now`. With `Date.now`, the +2h jump puts the entry 2 hours past its 30-minute TTL and
// the very next 60s sweep denies it and rewrites the card to "expired". The check then fails on both
// assertions below.
//
// Nothing else in the suite catches that edit, and not for the reason it first looks like: ten tests
// in `permission-registry.test.ts` alone do construct `new PermissionRegistry()` on the default
// clock. They simply never span a wall-clock jump. Over a test's few milliseconds `Date.now` and
// `monotonicNowMs` are indistinguishable - both put the entry ~0ms from `createdAt`, nowhere near the
// 30-minute TTL - so both clocks pass every one of them. The two only diverge when wall time moves
// and elapsed time does not, which is exactly what no in-process test can manufacture and exactly
// what this script manufactures.
//
// Tapping Allow at the end is not decoration. A card whose registry entry is gone still renders as a
// card; only resolving it proves the entry survived rather than merely the pixels.
//
// Requires an elevated shell (`Set-Date`). The clock is restored in a `finally` and again on exit.
//
// Usage: node clock-jump-check.js [--hours 2]
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { connect, openGroup, openTopic, openTopicByTitle, sendMessage, getMessageTexts, getMaxMessageId, waitForMessagesAfter, buttonByLabel } = require("./client.js");

const TAG = "[CJ-2]";
const TITLE = "Clock-jump check session for check 2";
// Needs a real `ask` escalation, so the same shape as guardrail-check.js's check 5(c) prompt: a
// commit on a feature branch, which §6.1.1 puts in `permissions.ask` explicitly.
const PROMPT = `${TAG} ${TITLE}. Create a file named clock-jump-scratch.txt containing the single line "clock jump check", then run "git add clock-jump-scratch.txt" and then "git commit -m \\"clock jump check - throwaway\\"". This is a disposable session branch.`;
/** One sweep is 60s (index.ts); wait comfortably past two so the jump cannot be missed. */
const SWEEP_WAIT_MS = 150 * 1000;

const DEV_BRIDGE = path.join(__dirname, "..", "dev-bridge.sh").replace(/\\/g, "/");
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);
const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
/** `VMwareToolboxCmd timesync status` prints its answer and *then* exits nonzero when sync is off,
 * so a plain `ps()` throws on exactly the healthy case this check wants to see. Reads stdout either
 * way rather than treating the exit code as the answer. */
const psAllowFail = (cmd) => {
  try {
    return ps(cmd);
  } catch (err) {
    return String(err.stdout ?? "").trim();
  }
};
const bridgeRunning = () => execFileSync("bash", [DEV_BRIDGE, "status"], { encoding: "utf8" }).trim().startsWith("running");

/** Relative, never absolute: `-Adjust` preserves the elapsed time of the test itself, so restoring
 * by the negation lands back on the true time rather than on whatever it was when we started. */
const shiftClock = (hours) => ps(`Set-Date -Adjust (New-TimeSpan -Hours ${hours}) | Out-Null`);

(async () => {
  const hoursArg = process.argv.indexOf("--hours");
  const HOURS = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 2;

  // `S-1-5-32-544` (the builtin Administrators SID), never `IsInRole('Administrator')` - the string
  // form is not the builtin role name and returns False even in an elevated shell, which had this
  // check refusing to run on a session that was in fact elevated.
  if (ps("[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('S-1-5-32-544')") !== "True") {
    throw new Error("Set-Date needs an elevated shell - rerun as administrator");
  }
  if (psAllowFail(`$c="C:\\Program Files\\VMware\\VMware Tools\\VMwareToolboxCmd.exe"; if (Test-Path $c) { & $c timesync status } else { "absent" }`) === "Enabled") {
    throw new Error("VMware Tools time sync is Enabled - it would snap the clock back mid-measurement; disable it or this check proves nothing");
  }
  if (!bridgeRunning()) throw new Error("the Bridge is not running - start it first");

  let shifted = false;
  const restoreClock = () => {
    if (!shifted) return;
    shifted = false;
    shiftClock(-HOURS);
    log(`clock restored (${-HOURS}h); now ${new Date().toISOString()}`);
  };
  process.on("exit", restoreClock);

  const verdict = { cardBefore: false, survived: false, resolvable: false };
  try {
    let { context, page } = await connect();
    await openGroup(page);

    await openTopic(page, "General");
    const createMid = await getMaxMessageId(page);
    await sendMessage(page, `/new aibridge ${PROMPT}`);
    const created = await waitForMessagesAfter(page, createMid, { rounds: 30, intervalMs: 2000, match: (t) => t.includes('Created "') });
    const slug = created.find((t) => t.includes('Created "'))?.match(/Created "([^"]+)"/)?.[1] ?? null;
    if (!slug) throw new Error("no session was created");
    log(`created session "${slug}"`);

    // Same vacuity trap guardrail-check.js documents: with auto-permission on, the commit is
    // auto-allowed, no card is ever raised, and this check measures nothing while looking fine.
    await openTopic(page, "General");
    const autoMid = await getMaxMessageId(page);
    await sendMessage(page, `/auto permission ${slug} off`);
    const auto = await waitForMessagesAfter(page, autoMid, { rounds: 15, intervalMs: 1000, match: (t) => t.includes("Auto-permission is now off") });
    if (!auto.length) throw new Error("could not turn auto-permission off - refusing to run, the result would be vacuous");
    log("auto-permission off confirmed");

    // Wait for a real card.
    await openTopicByTitle(page, TITLE);
    let buttons = [];
    for (let i = 0; i < 24 && !buttons.some((b) => b.includes("Allow")); i++) {
      await page.waitForTimeout(5000);
      buttons = await page.locator(".reply-markup-button").allInnerTexts();
    }
    verdict.cardBefore = buttons.some((b) => b.includes("Allow"));
    if (!verdict.cardBefore) throw new Error(`no permission card appeared for "${slug}" - nothing to survive the jump`);
    log(`card is up: [${buttons.join(" | ")}]`);
    await context.close(); // closed across the jump: a 2h skew mid-session upsets Chromium's own timers

    // --- the jump ---
    shifted = true;
    shiftClock(HOURS);
    log(`clock jumped +${HOURS}h; now ${new Date().toISOString()} - waiting ${SWEEP_WAIT_MS / 1000}s for at least two sweeps`);
    await new Promise((r) => setTimeout(r, SWEEP_WAIT_MS));
    restoreClock();

    // --- observe ---
    ({ context, page } = await connect());
    await openGroup(page);
    await openTopicByTitle(page, TITLE);
    const texts = await getMessageTexts(page, 15);
    buttons = await page.locator(".reply-markup-button").allInnerTexts();
    const expired = texts.some((t) => t.includes("expired"));
    verdict.survived = buttons.some((b) => b.includes("Allow")) && !expired;
    log(`after the jump: buttons [${buttons.join(" | ")}], any "expired" text: ${expired}`);

    if (verdict.survived) {
      const allow = buttonByLabel(page, "Allow");
      const beforeTapMid = await getMaxMessageId(page);
      await allow.last().click({ force: true });
      log("tapped Allow - the entry must still resolve, not just render");
      const after = await waitForMessagesAfter(page, beforeTapMid, { rounds: 30, intervalMs: 3000, match: (t) => /Allowed|working|clock-jump-scratch|commit/i.test(t) });
      verdict.resolvable = after.length > 0;
    }

    const pass = verdict.cardBefore && verdict.survived && verdict.resolvable;
    log(`topic tail: ${JSON.stringify(await getMessageTexts(page, 6))}`);
    console.log(`RESULT|slug=${slug}|cardBefore=${verdict.cardBefore}|survivedJump=${verdict.survived}|resolvable=${verdict.resolvable}|${pass ? "PASS" : "FAIL"}`);
    await context.close();
    restoreClock();
    process.exit(pass ? 0 : 1);
  } catch (err) {
    restoreClock();
    log(`ERROR: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
})();
