import { describe, expect, test } from "bun:test";
import { describeStartupGateFailures } from "../src/startup-gate-notice.ts";

const allGood = { startupTimedOut: false, channelConnected: true, ptyQuiet: true };

describe("describeStartupGateFailures", () => {
  test("says nothing when all three gates settled normally", () => {
    expect(describeStartupGateFailures("fix-bug", allGood)).toBeUndefined();
  });

  // The noise guard, and the reason this helper exists as a testable function rather than an inline
  // `if`. `waitForPtyQuiet`'s 8s ceiling is routinely reached by an honest cold `npx` on a brand-new
  // worktree, so raising a warning on it alone would put one on nearly every `/new` - and a warning
  // that fires every time is a warning nobody reads by the time a real one arrives.
  test("a noisy PTY on its own is not worth telling the operator about", () => {
    expect(describeStartupGateFailures("fix-bug", { ...allGood, ptyQuiet: false })).toBeUndefined();
  });

  test("a startup that never visibly finished raises it, and names the dialog case", () => {
    const notice = describeStartupGateFailures("fix-bug", { ...allGood, startupTimedOut: true });
    expect(notice).toContain('"fix-bug" was written to before it finished starting');
    expect(notice).toContain("never finished starting up");
    expect(notice).toContain("consent dialog");
    // The two that did settle must not be listed as failures.
    expect(notice).not.toContain("aibridge channel never connected");
    expect(notice).not.toContain("still producing output");
  });

  test("a channel that never connected raises it, and says replies may not arrive at all", () => {
    const notice = describeStartupGateFailures("fix-bug", { ...allGood, channelConnected: false });
    expect(notice).toContain("aibridge channel never connected");
    expect(notice).toContain("may not be able to reply here at all");
  });

  // The live 2026-08-16 SeoWrite case exactly: both severe gates timed out and the PTY was still
  // busy, and every one of the three belongs in the notice once it is being sent anyway.
  test("all three degraded lists all three", () => {
    const notice = describeStartupGateFailures("seowrite-check", { startupTimedOut: true, channelConnected: false, ptyQuiet: false });
    expect(notice).toContain("never finished starting up");
    expect(notice).toContain("aibridge channel never connected");
    expect(notice).toContain("still producing output");
  });

  // Load-bearing: the operator's text is *not* discarded on a degraded gate (the gates are
  // heuristics, and dropping a real message on a heuristic is its own silent failure), so the notice
  // has to say so - otherwise the natural reading is "it failed, nothing was sent" and the operator
  // resends into a session that already has it.
  test("the notice states the message was sent anyway, and gives a next step", () => {
    const notice = describeStartupGateFailures("fix-bug", { ...allGood, channelConnected: false });
    expect(notice).toContain("sent anyway rather than dropped");
    expect(notice).toContain("send it again");
    expect(notice).toContain("/restart");
  });
});
