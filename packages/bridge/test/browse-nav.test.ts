import { describe, expect, test } from "bun:test";
import {
  BrowseRegistry,
  buildDirKeyboard,
  buildFileActionKeyboard,
  buildHitsKeyboard,
  parseBrowseCommand,
  parseFindCommand,
  renderDirText,
  renderHitsText,
  resolveBrowseCallback,
} from "../src/browse-nav.ts";
import type { DirListing, SearchHit } from "../src/worktree-fs.ts";

describe("parseBrowseCommand", () => {
  test("a bare /browse starts at the worktree root", () => {
    expect(parseBrowseCommand("/browse")).toEqual({ path: "" });
  });

  test("/browse <path> carries the path through, trimmed", () => {
    expect(parseBrowseCommand("/browse  src/utils  ")).toEqual({ path: "src/utils" });
  });

  test("returns null for anything else", () => {
    expect(parseBrowseCommand("/find src")).toBeNull();
    expect(parseBrowseCommand("browse")).toBeNull();
  });
});

describe("parseFindCommand", () => {
  test("requires a non-empty query - a bare /find is not \"search everything\"", () => {
    expect(parseFindCommand("/find")).toBeNull();
    expect(parseFindCommand("/find   ")).toBeNull();
  });

  test("/find <query> carries the query through, trimmed", () => {
    expect(parseFindCommand("/find  some term  ")).toEqual({ query: "some term" });
  });

  test("returns null for anything else", () => {
    expect(parseFindCommand("/browse src")).toBeNull();
  });
});

describe("BrowseRegistry", () => {
  test("get() is non-consuming - a folder's id survives repeated taps (Prev/Next)", () => {
    const registry = new BrowseRegistry();
    const id = registry.add("my-slug", { kind: "dir", relPath: "src" });
    expect(registry.get(id)?.entry).toEqual({ kind: "dir", relPath: "src" });
    expect(registry.get(id)?.entry).toEqual({ kind: "dir", relPath: "src" }); // still there
  });

  test("an unknown id returns undefined without throwing", () => {
    const registry = new BrowseRegistry();
    expect(() => registry.get("nope")).not.toThrow();
    expect(registry.get("nope")).toBeUndefined();
  });

  test("an expired id is refused even though it still matches a real entry", () => {
    let now = 0;
    const registry = new BrowseRegistry({ now: () => now, ttlMs: 1000 });
    const id = registry.add("my-slug", { kind: "dir", relPath: "" });
    now = 1001;
    expect(registry.get(id)).toBeUndefined();
  });

  test("sweep() clears expired entries without touching live ones", () => {
    let now = 0;
    const registry = new BrowseRegistry({ now: () => now, ttlMs: 1000 });
    const staleId = registry.add("my-slug", { kind: "dir", relPath: "old" });
    now = 1001;
    const freshId = registry.add("my-slug", { kind: "dir", relPath: "new" });
    registry.sweep();
    expect(registry.get(staleId)).toBeUndefined();
    expect(registry.get(freshId)?.entry).toEqual({ kind: "dir", relPath: "new" });
  });
});

describe("resolveBrowseCallback", () => {
  test("parses each of the four namespaces", () => {
    expect(resolveBrowseCallback("br:abc12345:0")).toEqual({ kind: "dir", id: "abc12345", page: 0 });
    expect(resolveBrowseCallback("bf:abc12345")).toEqual({ kind: "file_menu", id: "abc12345" });
    expect(resolveBrowseCallback("bv:abc12345:view")).toEqual({ kind: "file_action", id: "abc12345", action: "view" });
    expect(resolveBrowseCallback("bv:abc12345:send")).toEqual({ kind: "file_action", id: "abc12345", action: "send" });
    expect(resolveBrowseCallback("bs:abc12345:2")).toEqual({ kind: "hits", id: "abc12345", page: 2 });
  });

  test("rejects malformed/tampered callback_data", () => {
    expect(resolveBrowseCallback("bv:abc12345:delete")).toBeNull();
    expect(resolveBrowseCallback("br:abc12345")).toBeNull();
    expect(resolveBrowseCallback("perm:abc12345:y")).toBeNull();
    expect(resolveBrowseCallback("garbage")).toBeNull();
  });
});

function dirListing(overrides: Partial<DirListing> = {}): DirListing {
  return {
    relPath: "",
    entries: [
      { name: "src", isDir: true },
      { name: "README.md", isDir: false },
    ],
    page: 0,
    totalPages: 1,
    ...overrides,
  };
}

describe("buildDirKeyboard / renderDirText", () => {
  test("every minted button resolves back through resolveBrowseCallback", () => {
    const registry = new BrowseRegistry();
    const keyboard = buildDirKeyboard(registry, "my-slug", dirListing());
    for (const row of keyboard) {
      for (const btn of row) {
        expect(resolveBrowseCallback(btn.callback_data!)).not.toBeNull();
      }
    }
  });

  test("a folder row mints a 'br:' id pointing at the child path; a file row mints a 'bf:' id", () => {
    const registry = new BrowseRegistry();
    const keyboard = buildDirKeyboard(registry, "my-slug", dirListing());
    const folderBtn = keyboard.flat().find((b) => b.text.includes("src"))!;
    const fileBtn = keyboard.flat().find((b) => b.text.includes("README.md"))!;
    const folderAction = resolveBrowseCallback(folderBtn.callback_data!);
    const fileAction = resolveBrowseCallback(fileBtn.callback_data!);
    expect(folderAction?.kind).toBe("dir");
    expect(fileAction?.kind).toBe("file_menu");
    expect(registry.get((folderAction as { id: string }).id)?.entry).toEqual({ kind: "dir", relPath: "src" });
    expect(registry.get((fileAction as { id: string }).id)?.entry).toEqual({ kind: "file", relPath: "README.md" });
  });

  test("shows a '..' row when not at the root, and never at the root", () => {
    const registry = new BrowseRegistry();
    const atRoot = buildDirKeyboard(registry, "my-slug", dirListing({ relPath: "" }));
    const nested = buildDirKeyboard(registry, "my-slug", dirListing({ relPath: "src/nested" }));
    expect(atRoot.flat().some((b) => b.text.includes(".."))).toBe(false);
    expect(nested.flat().some((b) => b.text.includes(".."))).toBe(true);
  });

  test("renderDirText labels the root and shows a page suffix only when paginated", () => {
    expect(renderDirText(dirListing({ relPath: "" }))).toContain("root");
    expect(renderDirText(dirListing({ relPath: "src" }))).toContain("/src");
    expect(renderDirText(dirListing({ totalPages: 2, page: 0 }))).toContain("page 1/2");
    expect(renderDirText(dirListing({ totalPages: 1 }))).not.toContain("page");
  });
});

describe("buildHitsKeyboard / renderHitsText", () => {
  const hits: SearchHit[] = [
    { relPath: "src/index.ts", reason: "name" },
    { relPath: "src/nested/deep.ts", reason: "content", line: 12, snippet: "const needle = 1;" },
  ];

  test("every hit row mints a 'bf:' id carrying its matchLine (for content hits)", () => {
    const registry = new BrowseRegistry();
    const hitsetId = registry.add("my-slug", { kind: "hitset", query: "needle", hits, truncated: false, contentSearchSkipped: false });
    const keyboard = buildHitsKeyboard(registry, "my-slug", hitsetId, hits, 0);
    const rows = keyboard.flat();
    const contentBtn = rows.find((b) => b.text.includes("deep.ts"))!;
    const action = resolveBrowseCallback(contentBtn.callback_data!);
    expect(registry.get((action as { id: string }).id)?.entry).toEqual({ kind: "file", relPath: "src/nested/deep.ts", matchLine: 12 });
  });

  test("pagination reuses the same hitset id (no re-search on Prev/Next)", () => {
    const registry = new BrowseRegistry();
    const manyHits: SearchHit[] = Array.from({ length: 20 }, (_, i) => ({ relPath: `f${i}.ts`, reason: "name" as const }));
    const hitsetId = registry.add("my-slug", { kind: "hitset", query: "f", hits: manyHits, truncated: false, contentSearchSkipped: false });
    const page0 = buildHitsKeyboard(registry, "my-slug", hitsetId, manyHits, 0);
    const nextBtn = page0.flat().find((b) => b.text.includes("Next"))!;
    expect(nextBtn.callback_data).toBe(`bs:${hitsetId}:1`);
  });

  test("renderHitsText reports no matches, truncation, and the rg-unavailable note distinctly", () => {
    expect(renderHitsText("xyz", { hits: [], truncated: false, contentSearchSkipped: false }, 0)).toContain("No matches");
    expect(renderHitsText("xyz", { hits: [], truncated: false, contentSearchSkipped: true }, 0)).toContain("rg not found");
    expect(renderHitsText("xyz", { hits, truncated: true, contentSearchSkipped: false }, 0)).toContain("narrow your query");
  });
});

describe("buildFileActionKeyboard", () => {
  test("always offers View and Send; only offers GitHub when a link was resolved", () => {
    const withLink = buildFileActionKeyboard("abc12345", "https://github.com/x/y/blob/main/f.ts").flat();
    const withoutLink = buildFileActionKeyboard("abc12345", null).flat();
    expect(withLink.some((b) => b.text.includes("GitHub"))).toBe(true);
    expect(withoutLink.some((b) => b.text.includes("GitHub"))).toBe(false);
    expect(withLink.find((b) => b.text.includes("GitHub"))?.url).toBe("https://github.com/x/y/blob/main/f.ts");
  });

  test("View/Send buttons carry the same id, callback-parseable", () => {
    const keyboard = buildFileActionKeyboard("abc12345", null).flat();
    expect(resolveBrowseCallback(keyboard[0]!.callback_data!)).toEqual({ kind: "file_action", id: "abc12345", action: "view" });
    expect(resolveBrowseCallback(keyboard[1]!.callback_data!)).toEqual({ kind: "file_action", id: "abc12345", action: "send" });
  });
});
