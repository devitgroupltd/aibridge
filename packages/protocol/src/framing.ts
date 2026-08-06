import { StringDecoder } from "node:string_decoder";
import type { Message } from "./types.ts";

/** The single named pipe every component (Bridge, channel server, hook client) connects to (§2.5). */
export const DEFAULT_PIPE_PATH = "\\\\.\\pipe\\aibridge";

/** Newline-delimited JSON, one object per line, UTF-8 (plan §2.5). */
export function encodeMessage(msg: Message): string {
  return JSON.stringify(msg) + "\n";
}

/** A single line longer than this is treated as a protocol violation rather than buffered forever -
 * without a cap, a peer that never sends a newline grows `buffer` until the daemon is OOM-killed,
 * taking every session with it. Comfortably above the largest legitimate message (a `Write` tool's
 * `tool_input.content` in a hook event). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Buffers partial reads from a stream/socket and yields complete JSON lines as they arrive.
 *
 * A line that fails to parse is skipped and reported via `onError` (default: throw), never silently
 * dropped - a corrupt line is exactly the kind of thing that must be loud, per §9's logging
 * convention. It is skipped *individually*, though: parsing the whole chunk with one `map` used to
 * discard every well-formed message sharing that chunk, so one corrupt byte could swallow a hook's
 * `hello`+`ask` pair and leave Claude blocked for the full hour.
 */
export class NdjsonDecoder {
  private buffer = "";
  // A `Buffer` boundary lands mid-codepoint routinely (any message with Cyrillic text or an emoji
  // past the chunk size), and `chunk.toString("utf8")` per chunk turns that into U+FFFD in
  // otherwise-valid JSON - silent-wrong, no throw, no log. `StringDecoder` holds the incomplete
  // trailing bytes back until the rest arrives.
  private readonly utf8 = new StringDecoder("utf8");

  // Plain field assignment, not a TS constructor parameter property: the Bridge runs under
  // `node --experimental-strip-types`, which strips the syntax without implementing its semantics and
  // refuses to load the module at all (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). `bun test` accepts it
  // happily, so the tests pass while the real daemon can't boot - the same trap rate-governor.ts's
  // `TokenBucket` and feed-coalescer.ts both carry a note about, hit again here.
  private readonly onError?: (line: string, err: unknown) => void;

  constructor(onError?: (line: string, err: unknown) => void) {
    this.onError = onError;
  }

  push(chunk: string | Buffer): Message[] {
    this.buffer += typeof chunk === "string" ? chunk : this.utf8.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    // Byte length, matching the constant's name: `buffer.length` counts UTF-16 code units, so a
    // CJK/emoji-heavy peer could hold ~3x the intended budget before tripping the guard.
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
      this.buffer = "";
      throw new Error(`protocol line exceeded ${MAX_LINE_BYTES} bytes with no newline - dropping the buffer`);
    }
    const out: Message[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as Message);
      } catch (err) {
        if (!this.onError) throw err;
        this.onError(line, err);
      }
    }
    return out;
  }
}
