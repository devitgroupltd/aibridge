import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Self-hosted voice transcription (Whisper via whisper.cpp), chosen over a cloud API per the
 * voice-input design decision - see the plan's changelog entry. Two things intentionally live
 * here rather than being asserted as fact elsewhere:
 *
 * - whisper-server's `/inference` JSON response shape is documented only as "supports
 *   `response_format=json`" (github.com/ggml-org/whisper.cpp examples/server) - the actual field
 *   names were not independently confirmed against a live server before this shipped. Same
 *   discipline as this project's own `tool_use_id`/`claude/channel` lessons: `parseWhisperServerResponse`
 *   below is deliberately permissive (accepts a bare string body too) and throws with the raw body
 *   on anything it doesn't recognise, rather than silently returning something wrong.
 * - whisper-server does not document a `language` field in its response even with `language: "auto"`
 *   requested - so no detected-language value is surfaced to the confirm card. If live verification
 *   later shows one exists, surfacing it is a small addition here, not a redesign.
 */

export interface WhisperServerConfig {
  whisperServerExe: string;
  modelPath: string;
  port: number;
  /** whisper-server defaults to 4 threads regardless of the machine's real core count. Benchmarked
   * live 2026-08-05 on a 6-core box: an 8s clip went medium/4t 16.1s -> medium/6t 13.2s ->
   * small/6t 3.7s - model size was the real bottleneck, threads a smaller but free win on top of
   * it. Defaults to every logical core (see config.ts) since inference is brief and infrequent
   * enough that a few seconds of full CPU beats a slow transcription. */
  threads: number;
}

export interface WhisperServerHandle {
  stop(): void;
  /** Switches the live server to a different model via `/load` (see `loadWhisperModel` below) -
   * no process restart, so no re-download/re-check of `existsSync` beyond what `/load` itself
   * does. Rejects, leaving `currentModelPath()` unchanged, if the switch fails - never marks a
   * failed switch as the new current model. */
  switchModel(modelPath: string): Promise<void>;
  /** The model path currently loaded - starts as `cfg.modelPath`, updates only after a successful
   * `switchModel`. Lets `/voice` (voice-model.ts) show what's active without a second variable
   * threaded through index.ts to keep in sync. */
  currentModelPath(): string;
}

/**
 * Supervises a long-lived whisper-server child process - the model (hundreds of MB to a few GB)
 * loads once at startup and is reused for every voice note, the same rationale as the Bridge's PTY
 * supervisor: reloading it per message would add several seconds of dead time to every single
 * voice note. Restarts on unexpected exit with a fixed backoff; a deliberate `stop()` (Bridge
 * shutdown) does not restart.
 */
export function startWhisperServer(cfg: WhisperServerConfig, log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void): WhisperServerHandle {
  let stopped = false;
  let child: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let currentModelPath = cfg.modelPath;
  const serverUrl = `http://127.0.0.1:${cfg.port}`;

  // Voice input can default to enabled (see the voice-input design decision) without assuming
  // the setup step has actually been run on this machine - a missing binary/model is reported
  // once and left alone, not retried every 3s forever the way a real crash-after-starting is.
  if (!existsSync(cfg.whisperServerExe) || !existsSync(cfg.modelPath)) {
    log(
      "WARN",
      `voice input is enabled but whisper-server/model isn't installed yet (looked for ${cfg.whisperServerExe} and ${cfg.modelPath}) - run scripts/setup-windows.ps1's voice step, or set VOICE_ENABLED=false to silence this.`,
    );
    return {
      stop() {},
      async switchModel() {
        throw new Error("whisper-server isn't running (binary/model missing at startup)");
      },
      currentModelPath: () => currentModelPath,
    };
  }

  const launch = () => {
    if (stopped) return;
    child = spawn(
      cfg.whisperServerExe,
      ["-m", currentModelPath, "--port", String(cfg.port), "--host", "127.0.0.1", "--threads", String(cfg.threads)],
      { stdio: "ignore" },
    );
    child.on("exit", (code) => {
      child = null;
      if (stopped) return;
      log("WARN", `whisper-server exited (code ${code}) - restarting in 3s`);
      restartTimer = setTimeout(launch, 3000);
    });
    child.on("error", (err) => {
      log("ERROR", `whisper-server failed to start: ${(err as Error).message}`);
    });
  };
  launch();

  return {
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill();
    },
    async switchModel(modelPath: string) {
      await loadWhisperModel(serverUrl, modelPath);
      currentModelPath = modelPath;
    },
    currentModelPath: () => currentModelPath,
  };
}

/** `/load` - live-verified 2026-08-05 against a real running whisper-server: switching from
 * `small` to `medium` and back worked with no process restart (confirmed by re-running /inference
 * and seeing the expected model's latency each time), the smaller model reloading in well under a
 * second. Multipart, like `sendDocument`/`TelegramClient` elsewhere in this codebase, since the
 * documented usage is `-F model=<path>` rather than a JSON body. */
export async function loadWhisperModel(serverUrl: string, modelPath: string): Promise<void> {
  const form = new FormData();
  form.append("model", modelPath);
  const res = await fetch(`${serverUrl}/load`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`whisper-server /load failed: ${res.status} ${res.statusText}`);
  }
}

/** Telegram voice notes arrive as Ogg/Opus; whisper.cpp expects 16kHz mono PCM. */
export function convertOggToWav(ffmpegPath: string, oggPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-y", "-i", oggPath, "-ac", "1", "-ar", "16000", wavPath], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export interface TranscribeResult {
  text: string;
}

/** whisper.cpp decodes in short timestamped segments and joins their text with `\n` - segment
 * cuts are driven by audio timing, not word boundaries, so a cut landing mid-word produces a
 * literal newline inside a word (e.g. "улучш\nить"). Whisper's own segment text carries a leading
 * space at real word boundaries but not mid-word, so that's the signal used here: a newline with
 * no adjacent space on either side is a mid-word split and is deleted outright (rejoining the
 * word); a newline with an adjacent space is a real segment/word boundary and collapses to one
 * space, same as any other run of whitespace. */
function collapseSegmentBreaks(text: string): string {
  return text.replace(/([^\S\n]*)\n([^\S\n]*)/g, (_match, before: string, after: string) => (before || after ? " " : ""));
}

/** Parses whisper-server's `/inference` response body. See the module doc comment for why this
 * is deliberately permissive rather than asserting one exact shape. */
export function parseWhisperServerResponse(body: unknown): TranscribeResult {
  if (typeof body === "string") {
    const text = collapseSegmentBreaks(body.trim());
    if (text.length === 0) throw new Error("whisper-server returned an empty transcript body");
    return { text };
  }
  if (body && typeof body === "object" && "text" in body && typeof (body as { text: unknown }).text === "string") {
    return { text: collapseSegmentBreaks((body as { text: string }).text.trim()) };
  }
  throw new Error(`unrecognised whisper-server response shape: ${JSON.stringify(body)}`);
}

/** POSTs a WAV file to the local whisper-server's `/inference` endpoint. `language: "auto"` per
 * the voice-input design decision - voice notes may be in English, Russian, Ukrainian or
 * Azerbaijani, so nothing here pins one language. */
export async function transcribeWav(serverUrl: string, wavPath: string): Promise<TranscribeResult> {
  const bytes = await fs.readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), path.basename(wavPath));
  form.append("response_format", "json");
  form.append("language", "auto");
  const res = await fetch(`${serverUrl}/inference`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`whisper-server /inference failed: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();
  return parseWhisperServerResponse(body);
}

/**
 * End-to-end: raw Ogg/Opus bytes (as downloaded from Telegram) -> transcript text. Writes to a
 * per-call temp file pair under the OS temp dir and always cleans up, success or failure - a voice
 * note's audio is exactly the kind of content that should not linger on disk after use.
 */
export async function transcribeVoiceNote(cfg: { ffmpegPath: string; serverUrl: string }, oggBytes: Uint8Array): Promise<TranscribeResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-"));
  const oggPath = path.join(tmpDir, "in.ogg");
  const wavPath = path.join(tmpDir, "out.wav");
  try {
    await fs.writeFile(oggPath, oggBytes);
    await convertOggToWav(cfg.ffmpegPath, oggPath, wavPath);
    return await transcribeWav(cfg.serverUrl, wavPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
