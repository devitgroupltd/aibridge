import type { Message } from "./types.ts";

/** Newline-delimited JSON, one object per line, UTF-8 (plan §2.5). */
export function encodeMessage(msg: Message): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Buffers partial reads from a stream/socket and yields complete JSON lines as they arrive.
 * A line that fails to parse throws rather than being silently dropped - a corrupt line is
 * exactly the kind of thing that must be loud, per §9's logging convention.
 */
export class NdjsonDecoder {
  private buffer = "";

  push(chunk: string | Buffer): Message[] {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line) as Message);
  }
}
