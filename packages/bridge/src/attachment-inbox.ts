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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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

/** Lands a downloaded attachment inside the session's own inbox - deliberately outside the git
 * worktree (`$STATE/sessions/<slug>/inbox/`, never the worktree path) so nothing accidentally
 * gets committed. Returns the absolute path Claude should be told about. */
export function writeAttachmentToInbox(stateDir: string, slug: string, name: string, bytes: Uint8Array): string {
  const dir = path.join(stateDir, "sessions", slug, "inbox");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, buildInboxFilename(name));
  writeFileSync(fullPath, bytes);
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
