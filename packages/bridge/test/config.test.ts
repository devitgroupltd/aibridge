import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseEnvFile } from "../src/config.ts";

async function withEnvFile(contents: string, run: (envPath: string) => void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-config-test-"));
  const envPath = path.join(dir, ".env");
  await fs.writeFile(envPath, contents);
  try {
    run(envPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const REQUIRED = "CONTROL_BOT_TOKEN=t\nFEED_BOT_TOKEN=f\nSUPERGROUP_CHAT_ID=-1\n";

describe("parseEnvFile", () => {
  test("parses KEY=VALUE lines, skipping comments and blanks", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "CONTROL_BOT_TOKEN=123:abc",
        "SUPERGROUP_CHAT_ID=-1004470540564",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      CONTROL_BOT_TOKEN: "123:abc",
      SUPERGROUP_CHAT_ID: "-1004470540564",
    });
  });

  test("a value may itself contain an = sign", () => {
    const parsed = parseEnvFile("TOKEN=abc=def==");
    expect(parsed.TOKEN).toBe("abc=def==");
  });

  // silent-wrong risk: a line with no `=` must fail loudly, not vanish silently.
  test("throws on a line with no = sign", () => {
    expect(() => parseEnvFile("CONTROL_BOT_TOKEN 123:abc")).toThrow(/malformed line 1/);
  });

  test("throws on an empty key", () => {
    expect(() => parseEnvFile("=novalue")).toThrow(/empty key/);
  });
});

describe("loadConfig - voice.enabled", () => {
  test("defaults to enabled when VOICE_ENABLED is absent entirely", async () => {
    await withEnvFile(REQUIRED, (envPath) => {
      expect(loadConfig(envPath).voice.enabled).toBe(true);
    });
  });

  test("VOICE_ENABLED=false opts out explicitly", async () => {
    await withEnvFile(`${REQUIRED}VOICE_ENABLED=false\n`, (envPath) => {
      expect(loadConfig(envPath).voice.enabled).toBe(false);
    });
  });

  test("VOICE_ENABLED=true stays enabled (redundant but valid)", async () => {
    await withEnvFile(`${REQUIRED}VOICE_ENABLED=true\n`, (envPath) => {
      expect(loadConfig(envPath).voice.enabled).toBe(true);
    });
  });
});

describe("loadConfig - voice.modelPath / threads", () => {
  test("defaults to the small model, not medium - benchmarked live 2026-08-05 (see the plan's changelog)", async () => {
    await withEnvFile(REQUIRED, (envPath) => {
      expect(loadConfig(envPath).voice.modelPath).toMatch(/ggml-small\.bin$/);
    });
  });

  test("WHISPER_MODEL_PATH overrides the default", async () => {
    await withEnvFile(`${REQUIRED}WHISPER_MODEL_PATH=C:\\custom\\model.bin\n`, (envPath) => {
      expect(loadConfig(envPath).voice.modelPath).toBe("C:\\custom\\model.bin");
    });
  });

  test("defaults threads to a positive number (the machine's logical core count) without an override", async () => {
    await withEnvFile(REQUIRED, (envPath) => {
      expect(loadConfig(envPath).voice.threads).toBeGreaterThan(0);
    });
  });

  test("WHISPER_THREADS overrides the default", async () => {
    await withEnvFile(`${REQUIRED}WHISPER_THREADS=2\n`, (envPath) => {
      expect(loadConfig(envPath).voice.threads).toBe(2);
    });
  });
});

describe("loadConfig - nlRouter", () => {
  test("defaults to enabled with no API key, a Haiku-tier model, and the cli backend", async () => {
    await withEnvFile(REQUIRED, (envPath) => {
      const { nlRouter } = loadConfig(envPath);
      expect(nlRouter.enabled).toBe(true);
      expect(nlRouter.apiKey).toBeUndefined();
      expect(nlRouter.model).toBe("claude-haiku-4-5-20251001");
      expect(nlRouter.backend).toBe("cli");
    });
  });

  test("NL_ROUTER_ENABLED=false opts out explicitly", async () => {
    await withEnvFile(`${REQUIRED}NL_ROUTER_ENABLED=false\n`, (envPath) => {
      expect(loadConfig(envPath).nlRouter.enabled).toBe(false);
    });
  });

  test("ANTHROPIC_API_KEY and NL_ROUTER_MODEL both override their defaults", async () => {
    await withEnvFile(`${REQUIRED}ANTHROPIC_API_KEY=sk-ant-test\nNL_ROUTER_MODEL=claude-sonnet-5\n`, (envPath) => {
      const { nlRouter } = loadConfig(envPath);
      expect(nlRouter.apiKey).toBe("sk-ant-test");
      expect(nlRouter.model).toBe("claude-sonnet-5");
    });
  });

  test("backend defaults to cli even once an API key is configured - a key's presence must never silently switch it", async () => {
    await withEnvFile(`${REQUIRED}ANTHROPIC_API_KEY=sk-ant-test\n`, (envPath) => {
      expect(loadConfig(envPath).nlRouter.backend).toBe("cli");
    });
  });

  test("NL_ROUTER_BACKEND=api opts in explicitly (the one-time startup default; /router switches live)", async () => {
    await withEnvFile(`${REQUIRED}ANTHROPIC_API_KEY=sk-ant-test\nNL_ROUTER_BACKEND=api\n`, (envPath) => {
      expect(loadConfig(envPath).nlRouter.backend).toBe("api");
    });
  });

  test("an unrecognised NL_ROUTER_BACKEND value falls back to cli rather than erroring", async () => {
    await withEnvFile(`${REQUIRED}NL_ROUTER_BACKEND=bogus\n`, (envPath) => {
      expect(loadConfig(envPath).nlRouter.backend).toBe("cli");
    });
  });
});
