import { describe, expect, test } from "bun:test";
import { looksEnglishEnough } from "../src/language-heuristic.ts";

describe("looksEnglishEnough", () => {
  test("plain English text passes", () => {
    expect(looksEnglishEnough("All tests pass, 892 total, 0 failures.")).toBe(true);
  });

  test("symbol/number-only text passes (nothing to block)", () => {
    expect(looksEnglishEnough("42 / 7 = 6 :)")).toBe(true);
  });

  test("Russian/Cyrillic text fails", () => {
    expect(looksEnglishEnough("Проверил все тесты, всё прошло успешно")).toBe(false);
  });

  test("mostly Cyrillic with a couple of English/code tokens mixed in still fails", () => {
    expect(looksEnglishEnough("Запустил bun test и tsc --noEmit, всё зелёное, ошибок нет")).toBe(false);
  });

  test("English text with a handful of foreign proper nouns still passes (stays under threshold)", () => {
    expect(looksEnglishEnough("Deployed to München and São Paulo, both green.")).toBe(true);
  });
});
