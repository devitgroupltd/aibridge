/**
 * Chunking an outbound message to fit Telegram's per-message cap.
 *
 * Lived in `pipe-server.ts` until now, purely because a reply arriving over the pipe was the first
 * thing that needed it - but this is a pure string function with no knowledge of the pipe, the
 * protocol, or a session, and `card-senders.ts` was already reaching into the transport module to
 * borrow it. Its test file has been called `telegram-split.test.ts` since the day it was written,
 * which is the clearest statement of where it belongs.
 */

/** Telegram's own limit is 4096 UTF-16 code units per message; the headroom absorbs the entity
 * expansion Telegram counts after parsing. */
export const TELEGRAM_TEXT_LIMIT = 3900;

/** Splits at line boundaries where it can, mid-line only when a single line is itself too long.
 * Returns `[]` for text that is empty or whitespace-only - Telegram 400s on that too. */
export function splitForTelegram(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    // A single line longer than the whole budget can't be kept intact - hard-split it.
    while (rest.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      // Back off one code unit if the cut would land between a surrogate pair, which would otherwise
      // send a lone surrogate (Telegram counts UTF-16 code units, so a limit boundary lands there for
      // any emoji-heavy line).
      const cut = isHighSurrogate(rest.charCodeAt(limit - 1)) ? limit - 1 : limit;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    const candidate = current.length === 0 ? rest : `${current}\n${rest}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
