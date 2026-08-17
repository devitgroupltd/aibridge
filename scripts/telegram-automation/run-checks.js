// Runs the live checks in this folder back to back and prints one table.
//
// Why this exists: there are ~19 scripts here, only one browser may run at a time
// (`launchPersistentContext` refuses a second instance against the persisted profile), and each is
// invoked by hand. In practice that means they get run when something is already suspected, never as
// regression coverage - so a feature that quietly broke three weeks ago is found by the next live
// failure rather than by the check that exists for it.
//
// ## The three classes, and why the distinction is the whole point
//
// A runner that prints PASS for everything it does not understand is worse than no runner - that is
// the same "a check that cannot fail for the right reason" trap this folder keeps re-learning. So
// every script is classified explicitly:
//
//   - `verdict`     - the script decides its own outcome (a `RESULT|...|PASS` line, or a `PASS:`/
//                     `FAIL:` log line). The runner reports what the script said, nothing more.
//   - `measurement` - the script prints numbers and JSON for a human to read and does not claim
//                     pass or fail at all (rate-storm-check's own header explains why its FAIL was
//                     never a finding). Always reported as READ-LOG, never as a pass.
//   - excluded      - needs arguments, or is a one-off tied to a fix that has landed. Named in the
//                     output rather than silently dropped, so "the runner ran everything" is never
//                     a thing anyone believes by accident.
//
// An included script whose classifier finds no verdict reports UNKNOWN, which counts as a failure
// for the exit code. Silence is not a pass.
//
// Usage:
//   node run-checks.js                 # the default set: self-verdicting checks, sequential
//   node run-checks.js --all           # also the measurement scripts (slower, no verdicts)
//   node run-checks.js --slow          # also ask-timeout-check.js, which waits a real hour
//   node run-checks.js --only turn-watchdog,sandbox
//   node run-checks.js --list
//
// Full output of every run is written to run-checks-logs/<timestamp>/<name>.log, always - a verdict
// with its evidence thrown away is not much of a verdict, and piping a run through `tail` is how two
// real findings were lost earlier in this project's history.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);

/** The last `RESULT|...|PASS|FAIL` line - the machine-readable contract the newer checks emit. */
function resultLine(out) {
  const lines = out.split("\n").filter((l) => l.includes("RESULT|"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  if (/\|PASS\s*$/.test(last.trim())) return { verdict: "PASS", detail: last.trim() };
  if (/\|FAIL\s*$/.test(last.trim())) return { verdict: "FAIL", detail: last.trim() };
  return null;
}

/** The last `[iso] PASS...`/`FAIL...`/`EXPECTED-FAIL...` line the older checks log to stderr. Last
 * rather than first: an early abort logs `FAIL: no session created` and stops, and that abort is the
 * outcome. */
function logVerdict(out) {
  const lines = out.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[[^\]]+\]\s+(EXPECTED-FAIL|PASS|FAIL)\b(.*)$/.exec(lines[i]);
    if (m) return { verdict: m[1], detail: `${m[1]}${m[2]}`.slice(0, 200) };
  }
  return null;
}

const eitherVerdict = (out) => resultLine(out) ?? logVerdict(out);

const CHECKS = [
  // Self-verdicting. `expect` is what a healthy run says - anything else is a regression, including
  // sandbox-check's EXPECTED-FAIL, which is §13 check 7's accepted gap and the acceptance test
  // Phase 6b has to flip. If that one ever starts saying PASS, that is news and the table should
  // say so rather than quietly going green.
  { name: "turn-watchdog", script: "turn-watchdog-check.js", ref: "the modal-eats-the-message detector, false-positive direction", kind: "verdict", expect: "PASS", classify: eitherVerdict },
  { name: "stale-command", script: "stale-command-check.js", ref: "§13 check 3 (stale command confirmed, not executed)", kind: "verdict", expect: "PASS", classify: eitherVerdict },
  { name: "clock-jump", script: "clock-jump-check.js", ref: "§13 check 2's scriptable half (pending card survives a wall-clock jump)", kind: "verdict", expect: "PASS", classify: eitherVerdict },
  { name: "seowrite-guardrail", script: "seowrite-guardrail-check.js", ref: "§13 check 5 (a)(b)(d) against SeoWrite's own guard hooks", kind: "verdict", expect: "PASS", classify: eitherVerdict },
  { name: "guardrail", script: "guardrail-check.js", ref: "§13 check 5(c) (a normal commit raises a real button)", kind: "verdict", expect: "PASS", classify: eitherVerdict },
  { name: "long-prompt", script: "long-prompt-check.js", ref: "P2-7 (message delivery at length, by marker position)", kind: "verdict", expect: "PASS", classify: eitherVerdict },
  { name: "sandbox", script: "sandbox-check.js", ref: "§13 check 7 - records the accepted Phase 6b gap", kind: "verdict", expect: "EXPECTED-FAIL", classify: eitherVerdict },

  // Measurement only. These print JSON and latencies and deliberately claim nothing; they are here
  // so one command can still exercise them, not so the table can call them green.
  { name: "terminal-race", script: "terminal-race-check.js", ref: "§13 check 4 (a card answered at the terminal resolves in Telegram)", kind: "measurement" },
  { name: "rate-storm", script: "rate-storm-check.js", ref: "§13 check 6 (P0 permission delivery under a four-session storm)", kind: "measurement" },
  { name: "quiet-mode", script: "quiet-mode-check.js", ref: "§5.4 point 4 (quiet mode under a real feed storm)", kind: "measurement" },
  { name: "always-rule", script: "always-rule-check.js", ref: "§12 Phase 2's open question (does an Always rule take effect mid-conversation)", kind: "measurement" },

  // An hour of real waiting, by design - §6.4's ask ceiling cannot be measured any faster.
  { name: "ask-timeout", script: "ask-timeout-check.js", ref: "§6.4's 3540s ask ceiling", kind: "verdict", expect: "PASS", classify: eitherVerdict, slow: true },
];

/** Named rather than omitted: a runner silently skipping half the folder is exactly the kind of
 * quiet cap this project keeps writing rules against. */
const EXCLUDED = [
  ["stop-live-check.js", "needs a <slug> argument"],
  ["verify-orphan-rm.js", "one-off for §4.5.2, needs an orphaned topic to exist"],
  ["verify-caption-repo-pick.js", "needs an image path and caption"],
  ["interject-test.js", "needs a topic and two prompts"],
  ["reply-context-test.js", "needs a topic argument"],
  ["reply-retry-test.js", "needs a topic argument"],
  ["reply-retry-nl-test.js", "needs a topic argument"],
  ["reply-retry-attachment-test.js", "needs a topic, a file and a caption"],
  ["check-topic-index.js", "inspection helper, not a check"],
  ["check-topic.js", "inspection helper, not a check"],
  ["inspect-topic.js", "inspection helper, not a check"],
  ["inspect-last-message.js", "inspection helper, not a check"],
  ["inspect-chatlist.js", "inspection helper, not a check"],
  ["list-topics.js", "inspection helper, not a check"],
  ["peek.js", "inspection helper, not a check"],
  ["reload-and-list.js", "inspection helper, not a check"],
  ["watch-thinking.js", "inspection helper, not a check"],
  ["tap-button.js", "interaction helper, not a check"],
  ["tap-topic-button.js", "interaction helper, not a check"],
  ["send-command.js", "interaction helper, not a check"],
  ["send-to-topic.js", "interaction helper, not a check"],
  ["send-by-index.js", "interaction helper, not a check"],
  ["send-attachment.js", "interaction helper, not a check"],
  ["send-session-message.js", "interaction helper, not a check"],
  ["login.js", "one-time interactive login"],
  ["client.js", "shared library"],
];

/**
 * Every `.js` in this folder must be either run or explicitly excluded. Without this, the runner
 * silently ossifies: someone writes a new check next month, never adds it here, and one command
 * that claims to run the checks quietly runs all-but-that-one forever. Reported rather than thrown -
 * an unaccounted script is a gap in this file, not a reason to refuse to run anything.
 */
function unaccountedScripts() {
  const known = new Set([...CHECKS.map((c) => c.script), ...EXCLUDED.map(([f]) => f), "run-checks.js"]);
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".js") && !known.has(f))
    .sort();
}

function runOne(check, logDir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, check.script)], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
    let combined = "";
    child.stdout.on("data", (d) => {
      combined += d.toString();
    });
    child.stderr.on("data", (d) => {
      combined += d.toString();
    });
    child.on("close", (code) => {
      const logPath = path.join(logDir, `${check.name}.log`);
      fs.writeFileSync(logPath, combined);
      const found = check.classify ? check.classify(combined) : null;
      resolve({ check, code, elapsedMs: Date.now() - started, found, logPath });
    });
  });
}

/**
 * The classification the table prints. `OK`/`REGRESSED` rather than PASS/FAIL on purpose: what
 * matters is whether the outcome matches what a healthy run says, and for sandbox-check a healthy
 * run says EXPECTED-FAIL. A measurement script is always READ-LOG, and an included script whose
 * verdict cannot be found is UNKNOWN, which is a failure - a runner that treats "I could not tell"
 * as "fine" is the exact trap this folder exists to avoid.
 */
function statusOf(r) {
  if (r.check.kind === "measurement") return "READ-LOG";
  if (!r.found) return "UNKNOWN";
  if (r.found.verdict === r.check.expect) return "OK";
  return r.found.verdict === "PASS" ? "CHANGED" : "REGRESSED";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    for (const c of CHECKS) console.log(`${c.name.padEnd(20)} ${c.kind.padEnd(12)} ${c.slow ? "(--slow) " : ""}${c.ref}`);
    console.log("");
    for (const [file, why] of EXCLUDED) console.log(`  excluded: ${file} - ${why}`);
    const unaccounted = unaccountedScripts();
    if (unaccounted.length > 0) console.log(`\n  UNACCOUNTED (add to CHECKS or EXCLUDED in run-checks.js): ${unaccounted.join(", ")}`);
    return;
  }

  const onlyArg = argv[argv.indexOf("--only") + 1];
  const only = argv.includes("--only") && onlyArg ? onlyArg.split(",").map((s) => s.trim()) : null;
  const wantAll = argv.includes("--all");
  const wantSlow = argv.includes("--slow");

  const selected = CHECKS.filter((c) => {
    if (only) return only.includes(c.name);
    if (c.slow) return wantSlow;
    if (c.kind === "measurement") return wantAll;
    return true;
  });
  if (selected.length === 0) {
    log("nothing selected - try --list");
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = path.join(__dirname, "run-checks-logs", stamp);
  fs.mkdirSync(logDir, { recursive: true });
  const unaccounted = unaccountedScripts();
  if (unaccounted.length > 0) log(`WARNING: ${unaccounted.length} script(s) in this folder are in neither CHECKS nor EXCLUDED and will not run: ${unaccounted.join(", ")}`);
  log(`running ${selected.length} check(s) sequentially - only one browser may use the persisted profile at a time`);
  log(`logs: ${logDir}`);

  const results = [];
  for (const [i, check] of selected.entries()) {
    log(`(${i + 1}/${selected.length}) ${check.name} - ${check.script}`);
    const r = await runOne(check, logDir);
    results.push(r);
    log(`    -> ${statusOf(r)} in ${Math.round(r.elapsedMs / 1000)}s${r.found ? ` (${r.found.verdict})` : ""}`);
  }

  console.log("");
  console.log("check                status      time   detail");
  console.log("-".repeat(100));
  for (const r of results) {
    const detail = r.found?.detail ?? (r.check.kind === "measurement" ? `read ${path.basename(r.logPath)}` : `no verdict found - read ${path.basename(r.logPath)}`);
    console.log(`${r.check.name.padEnd(20)} ${statusOf(r).padEnd(11)} ${`${Math.round(r.elapsedMs / 1000)}s`.padEnd(6)} ${detail.slice(0, 120)}`);
  }
  console.log("");
  const notRun = CHECKS.filter((c) => !selected.includes(c));
  if (notRun.length > 0) console.log(`not run this time: ${notRun.map((c) => c.name).join(", ")}`);
  console.log(`excluded from the runner entirely (${EXCLUDED.length}): see --list`);
  console.log(`logs: ${logDir}`);

  const bad = results.filter((r) => ["REGRESSED", "UNKNOWN", "CHANGED"].includes(statusOf(r)));
  process.exitCode = bad.length > 0 ? 1 : 0;
}

// Exported, and gated on `require.main`, because merely `require`-ing this file used to *start a
// 40-minute run*: a bare IIFE fired on import, launched a browser and began creating live Telegram
// sessions. Found the hard way while trying to import `resultLine` to test it - the import ran two
// real checks before it was killed. A module whose side effect is "drive the operator's Telegram
// account" must not have that side effect on import.
module.exports = { CHECKS, EXCLUDED, resultLine, logVerdict, statusOf, unaccountedScripts };

if (require.main === module) {
  main().catch((err) => {
    log(`ERROR: ${err.stack ?? err}`);
    process.exitCode = 1;
  });
}
