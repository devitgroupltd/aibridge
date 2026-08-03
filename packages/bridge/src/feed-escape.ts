/**
 * §9 scenario 21: every untrusted string that reaches a feed card (tool summaries built from
 * `tool_input`, error text, `last_assistant_message`) passes through this before interpolation.
 * The card is sent with `parse_mode: "HTML"` so `<pre>` can render tool-argument previews (§5.3),
 * which makes HTML-entity escaping load-bearing rather than cosmetic - an unescaped `<b>` in a
 * file path would actually render as bold in the operator's client. Bidi overrides and the
 * zero-width joiner are stripped outright rather than escaped: there is no legitimate reason for
 * either to appear in a tool argument, and both exist specifically to make text render as
 * something other than what it is.
 */

// U+200D (ZWJ), U+200E/U+200F (LRM/RLM), U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), U+2066-U+2069
// (the directional-isolate block) - the standard bidi-control-character set plus the zero-width
// joiner, written as explicit \u escapes so the source stays legible in any editor/encoding.
const UNSAFE_CONTROL_CHARS = /[‍‎‏‪-‮⁦-⁩]/g;

export function escapeForFeed(text: string): string {
  const stripped = text.replace(UNSAFE_CONTROL_CHARS, "");
  return stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
