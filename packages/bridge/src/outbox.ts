/**
 * §5.8 "Screenshots and outbound files": the symmetric counterpart to attachment-inbox.ts. Claude
 * can save a file (a Playwright screenshot, a desktop capture, anything else) under this
 * session's own outbox directory and hand its path to the new `send_file` channel tool; the
 * Bridge is the only thing that decides whether that lands in Telegram, and it never trusts a
 * path the channel server sends verbatim - `resolveOutboxPath` is the one gate every `send_file`
 * message passes through before a byte is read off disk.
 *
 * Deliberately its own directory, not the inbox: an attachment landing in the inbox is operator-
 * supplied input Claude reads; a file in the outbox is Claude-produced output waiting to be sent.
 * Mixing them would let a `send_file` call exfiltrate whatever the operator last uploaded, not
 * just what Claude itself wrote.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Extensions Telegram will render inline as a photo via `sendPhoto` rather than a generic
 * `sendDocument` download - deliberately narrow (Telegram's own `sendPhoto` accepts only these
 * formats); anything else, including a legitimate screenshot saved as e.g. `.bmp`, safely falls
 * back to `sendDocument`. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function isImagePath(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function outboxDir(stateDir: string, slug: string): string {
  return path.join(stateDir, "sessions", slug, "outbox");
}

/** Creates the directory if missing and returns its absolute path - called at session launch so
 * the path Claude is told about (via `AIBRIDGE_OUTBOX_DIR`) always exists, the same eagerness as
 * the settings file itself. */
export function ensureOutboxDir(stateDir: string, slug: string): string {
  const dir = outboxDir(stateDir, slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolves a `send_file` request's path against this session's outbox, returning the real
 * absolute path if (and only if) it names a file inside that directory, or `null` otherwise.
 * `path.resolve` collapses any `../` before the containment check runs, so a request for
 * `<outbox>/../../etc/passwd` resolves outside the directory and is rejected here rather than
 * relying on the caller to have sanitized anything - the channel server's `path` argument is
 * operator-adjacent input (Claude decides it, but Claude's own turn can itself be steered by
 * untrusted content read earlier in the same session), never trusted the way an inbox path is.
 */
export function resolveOutboxPath(stateDir: string, slug: string, requestedPath: string): string | null {
  const dir = path.resolve(outboxDir(stateDir, slug));
  const resolved = path.resolve(requestedPath);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}
