import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  convertOggToWav,
  parseWhisperServerResponse,
  transcribeVoiceNote,
  transcribeWav,
} from "../src/voice-transcribe.ts";

describe("parseWhisperServerResponse", () => {
  test("reads the documented {text: ...} shape", () => {
    expect(parseWhisperServerResponse({ text: "hello world" })).toEqual({ text: "hello world" });
  });

  test("trims surrounding whitespace", () => {
    expect(parseWhisperServerResponse({ text: "  hello world  \n" })).toEqual({ text: "hello world" });
  });

  test("also accepts a bare string body - the response shape was not independently confirmed live", () => {
    expect(parseWhisperServerResponse("hello world")).toEqual({ text: "hello world" });
  });

  test("throws, naming the raw body, on a shape with neither a string body nor a text field", () => {
    expect(() => parseWhisperServerResponse({ transcript: "hello" })).toThrow(/unrecognised whisper-server response/);
    expect(() => parseWhisperServerResponse(null)).toThrow();
    expect(() => parseWhisperServerResponse(42)).toThrow();
  });

  test("throws on an empty string body rather than silently returning an empty transcript", () => {
    expect(() => parseWhisperServerResponse("   ")).toThrow(/empty transcript/);
  });
});

// The next two describe blocks are integration tests against the real ffmpeg binary on this
// machine (confirmed present) - this project prefers a real local double over mocking fetch/
// child_process (see stub-telegram's own doc comment), and ffmpeg's actual CLI behaviour (exit
// code, WAV header shape) is exactly the kind of contract worth verifying for real rather than
// assuming.
const ffmpegAvailable = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const describeFfmpeg = ffmpegAvailable ? describe : describe.skip;

describeFfmpeg("convertOggToWav (real ffmpeg)", () => {
  let tmpDir: string;
  let oggPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-test-"));
    oggPath = path.join(tmpDir, "in.ogg");
    // A synthetic half-second silent Opus/Ogg file - stands in for a real Telegram voice note
    // without needing one recorded by hand.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.5", "-c:a", "libopus", oggPath], { stdio: "ignore" });
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("produces a 16kHz mono WAV whisper.cpp can consume", async () => {
    const wavPath = path.join(tmpDir, "out.wav");
    await convertOggToWav("ffmpeg", oggPath, wavPath);

    const header = await fs.readFile(wavPath);
    expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    expect(channels).toBe(1);
    expect(sampleRate).toBe(16000);
  });

  test("rejects on a nonexistent input file rather than silently producing an empty WAV", async () => {
    await expect(convertOggToWav("ffmpeg", path.join(tmpDir, "does-not-exist.ogg"), path.join(tmpDir, "out2.wav"))).rejects.toThrow();
  });
});

describe("transcribeWav / transcribeVoiceNote (fake whisper-server)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let serverUrl: string;
  let responseText = "hello world";
  let statusCode = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname === "/inference" && req.method === "POST") {
          if (statusCode !== 200) return new Response("error", { status: statusCode });
          return Response.json({ text: responseText });
        }
        return new Response("not found", { status: 404 });
      },
    });
    serverUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("posts the wav and returns the parsed transcript", async () => {
    responseText = "run the tests";
    statusCode = 200;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-wav-"));
    const wavPath = path.join(tmpDir, "out.wav");
    await fs.writeFile(wavPath, new Uint8Array([0, 1, 2, 3])); // content is opaque to the fake server
    try {
      expect(await transcribeWav(serverUrl, wavPath)).toEqual({ text: "run the tests" });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws with the status on a non-2xx response", async () => {
    statusCode = 500;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-wav-"));
    const wavPath = path.join(tmpDir, "out.wav");
    await fs.writeFile(wavPath, new Uint8Array([0]));
    try {
      await expect(transcribeWav(serverUrl, wavPath)).rejects.toThrow(/500/);
    } finally {
      statusCode = 200;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  if (ffmpegAvailable) {
    test("transcribeVoiceNote: real ogg bytes -> ffmpeg -> fake server -> transcript, and cleans up its temp dir", async () => {
      responseText = "проверь тесты";
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-e2e-"));
      const oggPath = path.join(tmpDir, "in.ogg");
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.3", "-c:a", "libopus", oggPath], { stdio: "ignore" });
      const oggBytes = await fs.readFile(oggPath);

      const before = await fs.readdir(os.tmpdir());
      const result = await transcribeVoiceNote({ ffmpegPath: "ffmpeg", serverUrl }, oggBytes);
      const after = await fs.readdir(os.tmpdir());

      expect(result).toEqual({ text: "проверь тесты" });
      // No new aibridge-voice-* directory left behind under the OS temp dir once the call resolves.
      const leaked = after.filter((name) => name.startsWith("aibridge-voice-") && !before.includes(name));
      expect(leaked).toEqual([]);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  }
});
