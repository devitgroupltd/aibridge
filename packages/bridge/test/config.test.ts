import { describe, expect, test } from "bun:test";
import { parseEnvFile } from "../src/config.ts";

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
