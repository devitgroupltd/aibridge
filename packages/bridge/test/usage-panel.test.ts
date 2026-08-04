import { describe, expect, test } from "bun:test";
import { formatUsagePanel } from "../src/usage-panel.ts";

// Fixtures captured live 2026-08-04 against Claude Code v2.1.221's real `/usage` overlay (via the
// dev-control-port PTY injection already used for the dialog-detection spike) - not invented JSON.
const FIRST_FRAME = `❯ /usage

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Settings  Status   Config   Usage   Stats

  Session

  Total cost:$0.1039
  Total duration (API):  6s
  Total duration (wall): 1m 43s
  Total code changes:    0 lines added, 0 lines removed
  Usage by model:
      claude-haiku-4-5:  522 input, 12 output, 0 cache read, 0 cache write ($0.0006)
       claude-sonnet-5:  2 input, 287 output, 31.4k cache read, 14.9k cache write ($0.1033)

  Current session
  █████████ 18% used
  Resets 1:20pm (Europe/Kiev)

  Current week (all models)
  ██████████████████████▌ 45% used
  Resets Aug 8, 4pm (Europe/Kiev)
  +50% weekly limits promo through Aug 19 · clau.de/cc-50-promo

  What's contributing to your limits usage?
  Approximate, based on local sessions on this machine — does not include other devices or claude.ai`;

const REFRESHED_FRAME = `${FIRST_FRAME}

  Scanning local sessions…

  Refreshing…

  Esc to cancel
███████████████████████ 46% usedResets Aug 8, 3:59pm (Europe/Kiev)+50% weekly limits promo through Aug 19 · clau.de/cc-50-promo
Current week (Fable) 0% used
What's contributing to your limits usage?Approximate, based on local sessions on this machine — does not include other devices or claude.ai
Scanning local sessions…
Esc to cancel`;

describe("formatUsagePanel", () => {
  test("parses session and weekly bars from the first, unrefreshed frame", () => {
    const result = formatUsagePanel(FIRST_FRAME);
    expect(result).toContain("Session: 18% used - resets 1:20pm (Europe/Kiev)");
    expect(result).toContain("Weekly (all models): 45% used - resets Aug 8, 4pm (Europe/Kiev)");
    expect(result).not.toContain("Fable");
  });

  test("includes Fable once its line appears, keeping the first frame's weekly bar", () => {
    const result = formatUsagePanel(REFRESHED_FRAME);
    expect(result).toContain("Session: 18% used - resets 1:20pm (Europe/Kiev)");
    // The refresh redraws the weekly bar in place with no heading nearby (a real terminal
    // cursor-positioned patch, not a fresh line) - stripAnsi's flat text can't see that patch as
    // "the same field, updated", so the un-refreshed 45%/4pm from the first frame is what survives.
    // Fable's line, in contrast, didn't exist before the refresh, so it's drawn as a whole new line
    // and matches cleanly.
    expect(result).toContain("Weekly (all models): 45% used - resets Aug 8, 4pm (Europe/Kiev)");
    expect(result).toContain("Weekly (Fable): 0% used");
  });

  test("falls back to a raw excerpt when nothing matches", () => {
    const result = formatUsagePanel("some unrelated overlay text");
    expect(result).toContain("Couldn't parse the usage panel");
    expect(result).toContain("some unrelated overlay text");
  });
});
