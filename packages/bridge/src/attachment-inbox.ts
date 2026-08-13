/**
 * §5.6 "Attachments and compaction": a phone is a camera, and the most natural way to report a
 * bug from one is a screenshot. Photos, documents, videos, video notes, and forwarded/uploaded
 * audio files sent to a session topic are downloaded here and announced to the session by path -
 * "Claude then reads it with the normal file tools, which is the whole trick: no protocol
 * extension is needed, because a path in context is enough." Unlike voice notes (transcribe then
 * discard, see voice-transcribe.ts), an attachment's bytes are meant to persist so Claude can
 * actually open them.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import { gitCommonDir } from "./worktree.ts";
import type { LogFn } from "./logger.ts";

/** The attachment inbox's own directory name, inside each session's worktree - exported so
 * `worktree-fs.ts`'s `/browse`/`/find` scan can exclude it by the same literal name instead of a
 * second hardcoded copy that could drift out of sync. */
export const INBOX_DIR_NAME = ".aibridge-inbox";

export type AttachmentKind = "image" | "document" | "video" | "audio" | "video note";

/** Telegram's Bot API hard-caps `getFile` downloads at 20MB, regardless of what aibridge wants -
 * lifting it needs a self-hosted local Bot API server, out of scope here. Checked before spending
 * a round-trip on a download that would just fail partway. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

/** A Telegram-supplied `file_name` is untrusted input - `path.basename` alone defeats `../`
 * traversal (the basename of `../../etc/passwd` is just `passwd`), but a name can still smuggle
 * control/exotic characters or be empty, so this also collapses to a safe charset. Scenario 36. */
export function sanitizeAttachmentFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : "file";
}

/** No `document.file_name` (common for forwarded media, always true of `photo`/`video_note`) -
 * fall back to a mime-derived extension, or a bare default if even that's missing/unrecognised. */
export function guessAttachmentFilename(kind: AttachmentKind, fileName: string | undefined, mimeType: string | undefined): string {
  if (fileName && fileName.trim().length > 0) return fileName;
  const ext = mimeType ? MIME_EXTENSIONS[mimeType] : undefined;
  if (ext) return `${kind === "video note" ? "video-note" : kind}.${ext}`;
  const fallbackExt = kind === "image" ? "jpg" : kind === "video" || kind === "video note" ? "mp4" : kind === "audio" ? "mp3" : "bin";
  return `${kind === "video note" ? "video-note" : kind}.${fallbackExt}`;
}

/** Timestamp + short random id prefix, ahead of the sanitized name - keeps attachments from the
 * same session ordered and prevents two files landed in the same second from colliding. */
export function buildInboxFilename(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = randomUUID().slice(0, 6);
  return `${stamp}-${rand}-${sanitizeAttachmentFilename(name)}`;
}

/** One state per worktree: `undefined` (never resolved yet), `null` (not a real git worktree), or
 * `{ commonDir, done }` (`gitCommonDir` resolved; `done` once `info/exclude` has been confirmed to
 * carry the inbox line). Keyed by `worktreePath` up front - available with no subprocess call at
 * all - so a *second* attachment to the same worktree skips `gitCommonDir`'s own git subprocess
 * spawn entirely, not just the file I/O after it. §9, found during review: an earlier version split
 * this into two separate collections (a worktree->commonDir map plus a commonDir-keyed "done" set);
 * keeping the two in sync turned out to be exactly the kind of fragility that class of split invites
 * - collapsed into one map, one entry, one place to reason about.
 *
 * A `null` result (not a real git worktree) is cached too, on the reasoning that
 * `writeAttachmentToInbox` only ever runs after `launchSession` has already cut the worktree, so a
 * `null` here reflects a genuinely broken worktree rather than a transient race worth re-checking on
 * every subsequent attachment.
 *
 * Because this cache would otherwise outlive a single session: `worktreePath` is always
 * `<worktreesRoot>/<slug>` (session-launcher.ts), and `/rm` frees a slug's name - and therefore that
 * exact path - the moment its row is removed. A later `/new` against a *different* repo can be
 * handed that identical, now-stale-cached path (§9, found live during review). Without
 * `forgetInboxGitignoreCache` (called from `session-lifecycle-commands.ts`'s `removeSessionRow`),
 * the new session's first attachment would silently reuse the *old* repo's resolved common dir, and
 * the new repo's own `.git/info/exclude` would never get the `.aibridge-inbox/` line appended. */
const inboxGitignoreState = new Map<string, { commonDir: string; done: boolean } | null>();

/** Must be called whenever a worktree is torn down and its path could later be handed to a
 * *different* repo - see `inboxGitignoreState`'s own doc comment above for why this cache would
 * otherwise go stale across a slug's reuse. */
export function forgetInboxGitignoreCache(worktreePath: string): void {
  inboxGitignoreState.delete(worktreePath);
}

/** `.aibridge-inbox/` must never show up in `git status`/`git add -A` inside the worktree - Claude
 * itself decides when to `git commit`/`git push` (both already gated behind an explicit `ask`
 * approval in settings.ts, so this isn't the only guard), but a stray attachment turning up in a
 * diff the operator has to notice and reject by hand is exactly the surprise §5.6 wants to avoid.
 * A tracked `.gitignore` edit would itself show up as a diff in the target repo, so this writes to
 * the worktree's *shared* `info/exclude` instead - `git worktree add` gives every worktree its own
 * `.git` *file* (not directory) pointing at a common dir under the main clone's
 * `.git/worktrees/<name>/`, and `info/exclude` lives in that shared common dir, not per-worktree.
 * `gitCommonDir` (worktree.ts) is reused rather than a second copy of the same relative-vs-absolute/
 * realpath resolution - it already handles the Windows drive-letter-casing and 8.3-short-name
 * pitfalls that comment documents, and `assertWorktreeBelongsTo` already depends on it being correct.
 *
 * Best-effort: a failure here must never block landing the attachment itself, but is logged (unlike
 * a bare swallowed exception) so a persistently-failing repo shows up somewhere other than an
 * operator eventually noticing an untracked `.aibridge-inbox/` in a diff. Not marked `done` on
 * failure, so a later attachment against the same repo gets another chance rather than being stuck
 * unexcluded for the rest of the process's life. */
function ensureInboxGitignored(worktreePath: string, log: LogFn): void {
  let state = inboxGitignoreState.get(worktreePath);
  if (state === undefined) {
    const commonDir = gitCommonDir(worktreePath);
    state = commonDir === null ? null : { commonDir, done: false };
    inboxGitignoreState.set(worktreePath, state);
  }
  if (state === null || state.done) return;
  try {
    const excludeDir = path.join(state.commonDir, "info");
    const excludePath = path.join(excludeDir, "exclude");
    mkdirSync(excludeDir, { recursive: true });
    let existing = "";
    try {
      existing = readFileSync(excludePath, "utf8");
    } catch {
      // Doesn't exist yet - a fresh repo's `git init` normally creates it, but nothing here
      // depends on that; an empty starting point is fine either way.
    }
    const line = `${INBOX_DIR_NAME}/`;
    if (!existing.split(/\r?\n/).some((l) => l.trim() === line)) {
      const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      appendFileSync(excludePath, `${sep}${line}\n`);
    }
    state.done = true;
  } catch (err) {
    log("WARN", `couldn't add ${INBOX_DIR_NAME}/ to ${worktreePath}'s git exclude list: ${(err as Error).message}`);
  }
}

/** Lands a downloaded attachment inside the session's own worktree, under a fixed subdirectory
 * (`INBOX_DIR_NAME`) excluded from git via `ensureInboxGitignored` above. Returns the absolute path
 * Claude should be told about.
 *
 * Previously lived under `$STATE/sessions/<slug>/inbox/`, deliberately outside the worktree so
 * nothing could accidentally get committed. Moved in after that location turned out to collide with
 * `settings.ts`'s `Read(~/**)`/`Edit(~/**)` deny rule: `$STATE` is `%LOCALAPPDATA%\aibridge`, itself
 * under the user's home directory `~`, and - because deny always wins over allow regardless of
 * specificity (§6.2, live-verified) - that blanket deny silently blocked Claude from ever reading an
 * attachment it had just been told about, no matter how narrowly an allow rule tried to carve the
 * inbox path back out. The worktree lives entirely outside `~` (`c:\data\worktrees\<slug>` by
 * default), so putting the inbox there sidesteps the conflict without touching the secret-protection
 * rule at all - the "not committed" guarantee moves from "outside the worktree" to "git-ignored
 * inside it" instead.
 *
 * §9, found live 2026-08-09: this used to write synchronously - up to `TELEGRAM_MAX_DOWNLOAD_BYTES`
 * (20MB) blocking the whole single-threaded Bridge (every other session's `getUpdates`/permission
 * card/reply) for the duration of the write. `fs/promises` here instead; every caller already awaits
 * everything around it. */
export async function writeAttachmentToInbox(worktreePath: string, name: string, bytes: Uint8Array, log: LogFn = () => {}): Promise<string> {
  ensureInboxGitignored(worktreePath, log);
  const dir = path.join(worktreePath, INBOX_DIR_NAME);
  await fsPromises.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, buildInboxFilename(name));
  await fsPromises.writeFile(fullPath, bytes);
  return fullPath;
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "an image",
  document: "a document",
  video: "a video",
  audio: "an audio file",
  "video note": "a video note",
};

/** "an image" / "a document" / ... - shared by the announcement text below and by index.ts's
 * control-topic guidance message, so the two can't drift on article/wording. */
export function attachmentKindLabel(kind: AttachmentKind): string {
  return KIND_LABEL[kind];
}

/** The whole trick, per §5.6: a plain-text announcement naming the landed path, exactly like an
 * operator typing "check out /path/to/thing.png" themselves. A caption sent alongside the
 * attachment (Telegram supports exactly one, on the message itself) rides along on its own line,
 * the same way it appears under the media in the Telegram UI. */
export function buildAttachmentAnnouncement(kind: AttachmentKind, absPath: string, caption?: string): string {
  const base = `operator sent ${KIND_LABEL[kind]}: ${absPath}`;
  const trimmedCaption = caption?.trim();
  return trimmedCaption ? `${base}\n${trimmedCaption}` : base;
}
