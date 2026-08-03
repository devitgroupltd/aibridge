/**
 * §3.2: meta keys must be [A-Za-z0-9_] only - a hyphenated key is *silently dropped* by Claude
 * Code with no error, so validating at build time (rather than trusting the caller) is the
 * whole point of this helper. `source` is reserved by Claude Code itself and must never be set
 * here, or it is emitted twice on the resulting `<channel>` tag.
 */
const META_KEY_PATTERN = /^[A-Za-z0-9_]+$/;

export function buildMeta<T extends Record<string, string | number>>(fields: T): T {
  for (const key of Object.keys(fields)) {
    if (key === "source") {
      throw new Error('meta key "source" is reserved by Claude Code and must never be set explicitly');
    }
    if (!META_KEY_PATTERN.test(key)) {
      throw new Error(
        `meta key "${key}" is invalid - only [A-Za-z0-9_] is delivered to Claude, anything else is silently dropped`,
      );
    }
  }
  return { ...fields };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * §10.1.2: with `notifications/claude/channel` confirmed broken upstream, inbound delivery is a
 * literal PTY keystroke injection rather than an MCP push, so this renders the same
 * `<channel source="aibridge" ...>` shape Claude Code itself would have rendered from a working
 * notification - the model sees an identical tag either way, and `reply`'s instructions (§3.1)
 * still make sense unmodified.
 *
 * Deliberately does NOT include a trailing `\r` - confirmed live that writing the tag text and
 * `\r` to the PTY in one chunk leaves it sitting unsubmitted in the input box, plausibly the TUI's
 * bracketed-paste handling swallowing an Enter embedded inside what looks like pasted content.
 * Callers must write the submit keystroke as its own, separate write.
 */
export function renderChannelTag(content: string, meta: Record<string, string | number>): string {
  const safeMeta = buildMeta(meta);
  const attrs = Object.entries(safeMeta)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");
  return `<channel source="aibridge" ${attrs}>${escapeXml(content)}</channel>`;
}
