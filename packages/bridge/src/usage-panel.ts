/**
 * §4.2's `/usage`: parses Claude Code's own `/usage` TUI overlay (confirmed live 2026-08-04 against
 * v2.1.221 - not documented anywhere, so this is built from a captured real render, same discipline
 * as `hook-events.ts`). The overlay renders twice: an immediate frame with "Current session" and
 * "Current week (all models)", then a refresh a second or two later that adds "Current week (Fable)"
 * (only once a per-model breakdown is known - absent on plans without Fable access). The refresh is
 * a real terminal cursor-positioned patch of just the bar/percentage characters, with no heading
 * nearby in the raw byte stream - `stripAnsi`'s flat text can't reconstruct "same field, updated" out
 * of that, so the session/weekly numbers stay pinned to the first frame's values, which is an
 * accurate (if very slightly stale, matching the panel's own "Approximate" caveat) reading. Fable's
 * line, by contrast, is drawn fresh in full since it didn't exist before the refresh, so it always
 * matches cleanly.
 */

function lastMatch(text: string, re: RegExp): RegExpMatchArray | undefined {
  const matches = [...text.matchAll(re)];
  return matches.at(-1);
}

/** Formats the stripped (ANSI-free) `/usage` overlay text into a short plain-text summary. Returns
 * a fallback with a raw excerpt if none of the expected blocks are found, rather than throwing -
 * the overlay's exact wording is Anthropic's to change without notice. */
export function formatUsagePanel(plainText: string): string {
  const session = lastMatch(plainText, /Current session[\s\S]{0,80}?(\d+)%\s*used[\s\S]{0,120}?Resets\s+([^\n]+)/g);
  const weekly = lastMatch(plainText, /Current week \(all models\)[\s\S]{0,80}?(\d+)%\s*used[\s\S]{0,120}?Resets\s+([^\n]+)/g);
  const fable = lastMatch(plainText, /Current week \(Fable\)[^\n]*?(\d+)%\s*used/g);

  const lines: string[] = [];
  if (session) lines.push(`Session: ${session[1]}% used - resets ${(session[2] ?? "").trim()}`);
  if (weekly) lines.push(`Weekly (all models): ${weekly[1]}% used - resets ${(weekly[2] ?? "").trim()}`);
  if (fable) lines.push(`Weekly (Fable): ${fable[1]}% used`);

  if (lines.length === 0) return `Couldn't parse the usage panel - raw excerpt:\n${plainText.slice(0, 500)}`;
  return lines.join("\n");
}
