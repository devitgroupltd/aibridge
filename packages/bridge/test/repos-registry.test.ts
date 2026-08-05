import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { addRepoEntry, parseReposToml, removeRepoEntry, ReposRegistry, serializeReposToml } from "../src/repos-registry.ts";

/** A throwaway dir with a `.git` marker - the minimum `addRepoEntry`'s existence check accepts. */
function makeFakeRepoDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aibridge-repo-"));
  mkdirSync(path.join(dir, ".git"));
  return dir;
}

describe("parseReposToml", () => {
  test("parses the plan's own §7.5 example verbatim", () => {
    const entries = parseReposToml(`
[seowrite]
path   = 'c:\\data\\projects\\seowrite'       # the everyday clone - no second copy (§7.1)
base   = "main"
model  = "sonnet"

[somethingelse]
path   = 'c:\\data\\projects\\somethingelse'
base   = "main"
model  = "sonnet"
`);
    expect(entries).toEqual([
      { name: "seowrite", path: "c:\\data\\projects\\seowrite", base: "main", model: "sonnet" },
      { name: "somethingelse", path: "c:\\data\\projects\\somethingelse", base: "main", model: "sonnet" },
    ]);
  });

  test("blank lines and full-line comments are skipped", () => {
    const entries = parseReposToml(`# top comment\n\n[a]\npath = "/repos/x"\n`);
    expect(entries).toEqual([{ name: "a", path: "/repos/x" }]);
  });

  test("rejects a duplicate section name", () => {
    expect(() => parseReposToml('[a]\npath="/x"\n[a]\npath="/y"\n')).toThrow(/duplicate repo name/);
  });

  test("rejects a key before any [section] header", () => {
    expect(() => parseReposToml('path = "/x"\n')).toThrow(/before any \[section\]/);
  });

  test("rejects a repo with no path", () => {
    expect(() => parseReposToml("[a]\nbase = \"main\"\n")).toThrow(/has no "path"/);
  });

  test("rejects an unparseable line", () => {
    expect(() => parseReposToml("[a]\nnot-a-kv-pair\n")).toThrow(/malformed line/);
  });

  test("rejects an unquoted value", () => {
    expect(() => parseReposToml("[a]\npath = /x\n")).toThrow(/expected a quoted string/);
  });
});

describe("ReposRegistry", () => {
  test("looks up by name and lists all registered names", () => {
    const registry = new ReposRegistry(parseReposToml('[seowrite]\npath = "/repos/seowrite"\n[other]\npath = "/repos/other"\n'));
    expect(registry.get("seowrite")?.path).toBe("/repos/seowrite");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.names()).toEqual(["seowrite", "other"]);
  });

  test("all() returns every entry in registration order", () => {
    const registry = new ReposRegistry(parseReposToml('[a]\npath = "/x"\n[b]\npath = "/y"\nmodel = "opus"\n'));
    expect(registry.all()).toEqual([
      { name: "a", path: "/x" },
      { name: "b", path: "/y", model: "opus" },
    ]);
  });
});

describe("serializeReposToml", () => {
  test("round-trips through parseReposToml", () => {
    const entries = [
      { name: "a", path: "c:\\data\\projects\\a", base: "main", model: "sonnet" },
      { name: "b", path: "c:\\data\\projects\\b" },
    ];
    expect(parseReposToml(serializeReposToml(entries))).toEqual(entries);
  });

  test("an empty list serializes to an empty string", () => {
    expect(serializeReposToml([])).toBe("");
  });

  test("rejects a value containing a double quote", () => {
    expect(() => serializeReposToml([{ name: "a", path: 'c:\\has"quote' }])).toThrow(/double quote/);
  });
});

describe("addRepoEntry / removeRepoEntry", () => {
  function withTempToml(run: (tomlPath: string) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "aibridge-repos-"));
    const tomlPath = path.join(dir, "repos.toml");
    try {
      run(tomlPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("adding to a missing file creates it fresh", () => {
    withTempToml((tomlPath) => {
      const repoDir = makeFakeRepoDir();
      addRepoEntry(tomlPath, { name: "fresh", path: repoDir });
      expect(parseReposToml(readFileSync(tomlPath, "utf8"))).toEqual([{ name: "fresh", path: repoDir }]);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  test("adding appends to existing entries and reloads correctly", () => {
    withTempToml((tomlPath) => {
      writeFileSync(tomlPath, '[existing]\npath = "/repos/existing"\n');
      const repoDir = makeFakeRepoDir();
      addRepoEntry(tomlPath, { name: "new", path: repoDir, base: "main", model: "opus" });
      const entries = parseReposToml(readFileSync(tomlPath, "utf8"));
      expect(entries).toEqual([
        { name: "existing", path: "/repos/existing" },
        { name: "new", path: repoDir, base: "main", model: "opus" },
      ]);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  test("rejects an invalid name", () => {
    withTempToml((tomlPath) => {
      expect(() => addRepoEntry(tomlPath, { name: "has space", path: "/x" })).toThrow(/must match/);
    });
  });

  test("rejects a duplicate name", () => {
    withTempToml((tomlPath) => {
      writeFileSync(tomlPath, '[dupe]\npath = "/repos/dupe"\n');
      expect(() => addRepoEntry(tomlPath, { name: "dupe", path: "/other" })).toThrow(/already registered/);
    });
  });

  test("rejects a path that doesn't exist", () => {
    withTempToml((tomlPath) => {
      expect(() => addRepoEntry(tomlPath, { name: "ghost", path: "Z:\\nowhere\\at\\all" })).toThrow(/does not exist/);
    });
  });

  test("rejects a path that exists but has no .git", () => {
    withTempToml((tomlPath) => {
      const dir = mkdtempSync(path.join(tmpdir(), "aibridge-notrepo-"));
      expect(() => addRepoEntry(tomlPath, { name: "notrepo", path: dir })).toThrow(/doesn't look like a git repo/);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  test("removes an existing entry", () => {
    withTempToml((tomlPath) => {
      writeFileSync(tomlPath, '[a]\npath = "/x"\n[b]\npath = "/y"\n');
      removeRepoEntry(tomlPath, "a");
      expect(parseReposToml(readFileSync(tomlPath, "utf8"))).toEqual([{ name: "b", path: "/y" }]);
    });
  });

  test("rejects removing an unknown name", () => {
    withTempToml((tomlPath) => {
      writeFileSync(tomlPath, '[a]\npath = "/x"\n');
      expect(() => removeRepoEntry(tomlPath, "missing")).toThrow(/not registered/);
    });
  });
});
