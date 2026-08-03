import { describe, expect, test } from "bun:test";
import { escapeForFeed } from "../src/feed-escape.ts";

describe("escapeForFeed", () => {
  test("§9 scenario 21: a fake closing pre/bold tag renders inert", () => {
    const out = escapeForFeed("</pre><b>approved</b>");
    expect(out).toBe("&lt;/pre&gt;&lt;b&gt;approved&lt;/b&gt;");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("</pre>");
  });

  test("§9 scenario 21: a bidi override is stripped, not just escaped", () => {
    const out = escapeForFeed("safe‮txt.exe‬");
    expect(out).toBe("safetxt.exe");
    expect(out).not.toContain("‮");
  });

  test("§9 scenario 21: a zero-width joiner is stripped", () => {
    const out = escapeForFeed("normal‍text");
    expect(out).toBe("normaltext");
  });

  test("an ampersand is entity-escaped", () => {
    expect(escapeForFeed("a & b")).toBe("a &amp; b");
  });

  test("plain file paths and commands are unaffected beyond entity escaping", () => {
    expect(escapeForFeed("src/Billing/InvoiceService.cs")).toBe("src/Billing/InvoiceService.cs");
    expect(escapeForFeed("npm run build")).toBe("npm run build");
  });
});
