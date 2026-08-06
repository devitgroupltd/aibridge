/**
 * Last-line-of-defence output filter, sitting right before `handleReply` in `pipe-server.ts` hands
 * text to Telegram. §6.2's `Read`/`Edit` `deny` rules (`settings.ts`) are the input-side control -
 * they stop Claude's *own* tools from opening a secret file - but §8.3 records the gap those rules
 * cannot close: a script the session writes and runs itself reads the file regardless, and nothing
 * stops Claude from then quoting that content back in a `reply` call. This module is the chokepoint
 * that actually holds for that case, because every reply and every send_file caption passes through
 * here no matter how its content was obtained upstream.
 *
 * Deliberately pattern-based rather than a secrets-scanner integration: it is meant to catch the
 * shape of "this looks like key material" or "this looks like a live path into a place secrets
 * live", not to be a general-purpose credential scanner. False positives (redacting something that
 * happened to look like a key) are an acceptable cost; false negatives on the specific shapes below
 * are not, since there is no second chance once a message reaches Telegram.
 */

interface ScrubRule {
  /** Short tag for the log line and the placeholder text - never shown to the operator otherwise. */
  tag: string;
  pattern: RegExp;
}

const RULES: ScrubRule[] = [
  // PEM-style private key blocks (SSH, TLS, PGP) - the single highest-value pattern, since a whole
  // key block is unambiguous and unlike a lone token has no legitimate reason to appear in a reply.
  { tag: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // AWS access key ids are a fixed, recognisable shape (§8.2's ~/.aws deny covers the credentials
  // file itself; this catches one pasted into a reply from somewhere else, e.g. an env dump).
  { tag: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub's own token prefixes (ghp_, gho_, ghu_, ghs_, ghr_) - fixed-length, low false-positive.
  { tag: "github-token", pattern: /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g },
  // A .env-shaped "SOMETHING_KEY=value" / "SOMETHING_SECRET=value" / "...TOKEN=..." /
  // "...PASSWORD=..." line - the generic catch-all for the class of thing Read(.env) already
  // denies at the source; this is what still catches it if a subprocess read the file instead.
  { tag: "env-assignment", pattern: /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*\S+/g },
];

export interface ScrubResult {
  text: string;
  /** Which rule tags actually matched, in the order they fired - empty when nothing was redacted. */
  triggered: string[];
}

/**
 * Never throws, never blocks - a rule that fails to compile or match correctly should degrade to
 * "nothing redacted", not to dropping the whole reply. Runs synchronously; every pattern above is
 * bounded (no catastrophic backtracking - `[\s\S]*?` is lazy and anchored by a literal closing
 * marker), so this stays cheap on the hot path of every reply.
 */
export function scrubSecrets(text: string): ScrubResult {
  let scrubbed = text;
  const triggered: string[] = [];
  for (const rule of RULES) {
    // Every pattern above carries the `g` flag, which makes `RegExp.prototype.test`/`exec` stateful
    // across calls via `lastIndex` - fine for `.replace` (its `Symbol.replace` resets `lastIndex`
    // itself before matching) but a real bug if this ever called `.test()` on the same module-level
    // rule object across invocations: a leftover `lastIndex` from a previous call could start the
    // next match partway through the string and silently miss a hit at the front. Comparing the
    // replaced string against the input avoids `.test()`/`.exec()` entirely, so there is no shared
    // state to get wrong here.
    const next = scrubbed.replace(rule.pattern, `[redacted:${rule.tag}]`);
    if (next !== scrubbed) triggered.push(rule.tag);
    scrubbed = next;
  }
  return { text: scrubbed, triggered };
}
