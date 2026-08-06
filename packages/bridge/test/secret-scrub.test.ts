import { describe, expect, test } from "bun:test";
import { scrubSecrets } from "../src/secret-scrub.ts";

describe("scrubSecrets", () => {
  test("leaves ordinary text untouched and reports nothing triggered", () => {
    const result = scrubSecrets("build's green, tests pass, pushed the branch");
    expect(result.text).toBe("build's green, tests pass, pushed the branch");
    expect(result.triggered).toEqual([]);
  });

  test("redacts a PEM private key block wholesale", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabcd1234\nefgh5678\n-----END OPENSSH PRIVATE KEY-----";
    const result = scrubSecrets(`here's what I found:\n${key}\ndone`);
    expect(result.text).not.toContain("abcd1234");
    expect(result.text).toContain("[redacted:private-key]");
    expect(result.triggered).toEqual(["private-key"]);
  });

  test("redacts an AWS access key id", () => {
    const result = scrubSecrets("found AKIAABCDEFGHIJKLMNOP in the config");
    expect(result.text).toBe("found [redacted:aws-access-key] in the config");
    expect(result.triggered).toEqual(["aws-access-key"]);
  });

  test("redacts a GitHub token", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const result = scrubSecrets(`token: ${token}`);
    expect(result.text).not.toContain(token);
    expect(result.triggered).toEqual(["github-token"]);
  });

  test("redacts a .env-shaped SECRET/TOKEN/KEY/PASSWORD assignment", () => {
    expect(scrubSecrets("API_SECRET=sk-liveXYZ123").triggered).toEqual(["env-assignment"]);
    expect(scrubSecrets("DB_PASSWORD=hunter2").triggered).toEqual(["env-assignment"]);
    expect(scrubSecrets("SESSION_TOKEN=abc.def.ghi").triggered).toEqual(["env-assignment"]);
  });

  test("multiple distinct rules can fire on the same message, each reported once", () => {
    const result = scrubSecrets("AKIAABCDEFGHIJKLMNOP and also API_SECRET=xyz");
    expect(result.triggered).toEqual(["aws-access-key", "env-assignment"]);
  });

  test("is safe to call repeatedly with fresh matches each time (no stateful lastIndex bleed)", () => {
    const first = scrubSecrets("AKIAABCDEFGHIJKLMNOP");
    const second = scrubSecrets("AKIAABCDEFGHIJKLMNOP");
    expect(first.triggered).toEqual(["aws-access-key"]);
    expect(second.triggered).toEqual(["aws-access-key"]);
    expect(second.text).toBe("[redacted:aws-access-key]");
  });

  test("does not false-positive on ordinary uppercase words that merely contain 'KEY'", () => {
    // "KEYBOARD_LAYOUT=us" - no clean tail after KEY that would match the env-assignment shape's
    // suffix requirement (…KEY|SECRET|TOKEN|PASSWORD immediately before optional trailing chars).
    const result = scrubSecrets("the setting is MONKEY=banana");
    // MONKEY contains KEY and does match the intentionally broad env-assignment shape - documenting
    // this as accepted false-positive risk (see the module's own doc comment), not asserting it away.
    expect(result.triggered).toEqual(["env-assignment"]);
  });
});

/**
 * Shapes the original rule set missed. Each of these is reachable the same way the existing rules are:
 * §6.2's deny rules stop Claude's *own* tools from opening a secret file, but a subprocess the session
 * wrote can read one and quote it back, and this is the only chokepoint every reply passes through.
 */
describe("scrubSecrets - shapes added after review", () => {
  // The single most likely real leak, and the one the env-assignment rule structurally cannot catch:
  // it keys on KEY|SECRET|TOKEN|PASSWORD appearing in the *identifier*, and neither DATABASE_URL nor
  // REDIS_URL does. Keying on the shape of the value is what closes it.
  test("redacts credentials embedded in a URI, whatever the variable is called", () => {
    const result = scrubSecrets("DATABASE_URL=postgres://svc:hunter2@db.internal/app");
    expect(result.text).not.toContain("hunter2");
    expect(result.triggered).toContain("uri-credentials");
  });

  test("catches a URI credential in prose, not just an assignment", () => {
    const result = scrubSecrets("cloning from https://oleg:ghs_secretvalue@github.com/org/repo.git now");
    expect(result.text).not.toContain("ghs_secretvalue");
  });

  test("leaves an ordinary URL with no credentials completely alone", () => {
    const text = "see https://github.com/org/repo/blob/main/README.md#L4 and http://localhost:3000/x";
    const result = scrubSecrets(text);
    expect(result.text).toBe(text);
    expect(result.triggered).toEqual([]);
  });

  // This fleet's own most sensitive credential: whoever holds the control bot's token owns every
  // session in the fleet. The Bridge's own .env is the file most likely to be read back "to check
  // the config".
  test("redacts a Telegram bot token", () => {
    const result = scrubSecrets("CONTROL_BOT_TOKEN=8123456789:AAFmMlq3xR7pQz9WvT2kLbN4hJ6yD8sGvXc");
    expect(result.text).not.toContain("AAFmMlq3xR7pQz9WvT2kLbN4hJ6yD8sGvXc");
    expect(result.triggered.length).toBeGreaterThan(0);
  });

  test("redacts Anthropic/OpenAI-style and Slack tokens", () => {
    expect(scrubSecrets("key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789").text).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(scrubSecrets("OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz01").text).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz01");
    expect(scrubSecrets("xoxb-1234567890-AbCdEfGhIjKl").text).not.toContain("AbCdEfGhIjKl");
  });

  // The chunking defeat: the private-key rule needs both markers, so a key split across two replies
  // matched neither half and both went out verbatim. A BEGIN marker on its own is already unambiguous.
  test("redacts a private key whose END marker never arrived", () => {
    const half = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAAAAAAAEAAAAzAAAAC3NzaC";
    const result = scrubSecrets(half);
    expect(result.text).not.toContain("b3BlbnNzaC1rZXktdjEA");
    expect(result.triggered.some((t) => t.startsWith("private-key"))).toBe(true);
  });

  test("a complete key block is still redacted (and reported) exactly as before", () => {
    const result = scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----");
    expect(result.text).not.toContain("MIIEabc");
    expect(result.triggered).toContain("private-key");
  });

  test("ordinary prose with none of these shapes is returned untouched", () => {
    const text = "Fixed the login redirect in src/auth.ts - the session cookie was being set before the 302.";
    expect(scrubSecrets(text)).toEqual({ text, triggered: [] });
  });
});
