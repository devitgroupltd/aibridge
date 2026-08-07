/**
 * Cheap ASCII-letter-ratio heuristic, not real language detection - good enough to stop rename-once
 * (`index.ts`'s `onReplySent`) from flipping a topic's title into a non-English script (Cyrillic,
 * CJK, etc.) once a session's first reply comes back in the operator's own language (§ the
 * language-mirroring system prompt in `session-launcher.ts`). A reply with some foreign-language
 * flavour (a proper noun, an error message, a bit of code) still passes - only letter characters
 * count, and the threshold is generous, because this only needs to catch "this reply is
 * fundamentally in another script", not judge English quality.
 */
export function looksEnglishEnough(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true; // no letters at all (pure code/symbols/numbers) - nothing to block
  const nonAscii = letters.filter((ch) => ch.charCodeAt(0) > 127).length;
  return nonAscii / letters.length < 0.3;
}
