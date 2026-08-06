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
