import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  addRepoEntry,
  cloneRepo,
  inferDefaultRepoPath,
  isGitUrl,
  parseReposToml,
  removeRepoEntry,
  ReposRegistry,
  resolveRepoNameFuzzy,
  serializeReposToml,
} from "../src/repos-registry.ts";

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

  test("projectMcp parses as a bare boolean, and is absent unless written", () => {
    const entries = parseReposToml('[a]\npath = "/x"\nprojectMcp = true\n[b]\npath = "/y"\nprojectMcp = false\n[c]\npath = "/z"\n');
    expect(entries[0]?.projectMcp).toBe(true);
    expect(entries[1]?.projectMcp).toBe(false);
    expect(entries[2]?.projectMcp).toBeUndefined();
  });

  // Load-bearing rather than pedantry: `projectMcp = "false"` accepted as a string would be truthy
  // at every call site, i.e. a repo whose operator wrote the *rejecting* value would get its MCP
  // servers enabled. This is the one direction this setting must never fail in.
  test("a quoted or misspelled projectMcp is rejected rather than coerced", () => {
    expect(() => parseReposToml('[a]\npath = "/x"\nprojectMcp = "true"\n')).toThrow(/bare true or false/);
    expect(() => parseReposToml('[a]\npath = "/x"\nprojectMcp = "false"\n')).toThrow(/bare true or false/);
    expect(() => parseReposToml('[a]\npath = "/x"\nprojectMcp = yes\n')).toThrow(/bare true or false/);
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

  // `session-supervisor.ts`'s resume path only has the persisted `repoPath`, never the registry
  // name. A miss here is silent - the resumed session just loses its `projectMcp` opt-in and boots
  // back into the consent dialog - so the sloppy-but-legal spellings a hand-edited repos.toml and a
  // Windows path produce all have to resolve.
  test("getByPath matches regardless of separator, case, or a trailing slash", () => {
    const registry = new ReposRegistry(parseReposToml("[seowrite]\npath = 'C:\\data\\projects\\seowrite'\nprojectMcp = true\n"));
    expect(registry.getByPath("C:\\data\\projects\\seowrite")?.name).toBe("seowrite");
    expect(registry.getByPath("c:/data/projects/seowrite")?.name).toBe("seowrite");
    expect(registry.getByPath("C:/DATA/Projects/SeoWrite/")?.name).toBe("seowrite");
    expect(registry.getByPath("c:\\data\\projects\\aibridge")).toBeUndefined();
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

  // `/repos add` rewrites the whole file, so anything written by default here spreads into every
  // other entry on the next add - which is how a closed default quietly becomes an explicit one
  // nobody chose. Only the opted-in value is ever emitted, and it round-trips.
  test("projectMcp is written only when true, and survives a round trip", () => {
    const entries = [
      { name: "a", path: "c:\\repos\\a", projectMcp: true },
      { name: "b", path: "c:\\repos\\b" },
    ];
    const serialized = serializeReposToml(entries);
    expect(serialized).toContain("projectMcp = true");
    expect(serialized.match(/projectMcp/g)).toHaveLength(1);
    expect(parseReposToml(serialized)).toEqual(entries);
  });

  // Single-quoted TOML *literal* strings, because every value here is a Windows path and
  // `path = "C:\data\x"` is not valid TOML - `\d` is an illegal escape in a basic string, so a file
  // this module wrote itself was rejected by anything holding it to the real spec.
  test("emits literal (single-quoted) strings so backslashes need no escaping", () => {
    expect(serializeReposToml([{ name: "a", path: "c:\\data\\projects\\a" }])).toBe("[a]\npath = 'c:\\data\\projects\\a'\n");
  });

  // An apostrophe in a path is perfectly legal on Windows (`C:\Users\Tom O'Neil\repos\x`), unlike `"`
  // which Windows forbids in a filename - so it must not be a hard rejection. A literal string can't
  // escape its own delimiter, so that one case falls back to the double-quoted form, which
  // `parseValue` reads back identically.
  test("falls back to a double-quoted string for a path containing an apostrophe, and round-trips", () => {
    const entries = [{ name: "a", path: "c:\\Users\\Tom O'Neil\\repos\\x" }];
    const serialized = serializeReposToml(entries);
    expect(serialized).toBe("[a]\npath = \"c:\\Users\\Tom O'Neil\\repos\\x\"\n");
    expect(parseReposToml(serialized)).toEqual(entries);
  });

  test("rejects only a value with nowhere left to go - both quote characters at once", () => {
    expect(() => serializeReposToml([{ name: "a", path: `c:\\has'both"quotes` }])).toThrow(/both a single and a double quote/);
  });

  test("rejects a newline, which no single-line TOML value can carry", () => {
    expect(() => serializeReposToml([{ name: "a", path: "c:\\has\nnewline" }])).toThrow(/newline/);
  });
});

describe("isGitUrl", () => {
  test("recognises scheme URLs", () => {
    expect(isGitUrl("https://github.com/example/repo.git")).toBe(true);
    expect(isGitUrl("https://github.com/example/repo")).toBe(true);
    expect(isGitUrl("git://example.com/repo.git")).toBe(true);
    expect(isGitUrl("ssh://git@example.com/repo.git")).toBe(true);
  });

  test("recognises scp-style git@host:path", () => {
    expect(isGitUrl("git@github.com:example/repo.git")).toBe(true);
  });

  test("recognises a bare .git suffix with no scheme", () => {
    expect(isGitUrl("example.com/repo.git")).toBe(true);
  });

  test("rejects Windows and POSIX local paths", () => {
    expect(isGitUrl("c:\\data\\projects\\aibridge")).toBe(false);
    expect(isGitUrl("C:\\data\\projects\\aibridge")).toBe(false);
    expect(isGitUrl("/home/user/repo")).toBe(false);
  });
});

describe("inferDefaultRepoPath", () => {
  test("returns null with no existing repos to infer from", () => {
    expect(inferDefaultRepoPath([], "new")).toBeNull();
  });

  test("infers <shared parent>/<name> when every repo already shares one parent", () => {
    const existing = [
      { name: "a", path: "c:\\data\\projects\\a" },
      { name: "b", path: "c:\\data\\projects\\b", base: "main" },
    ];
    expect(inferDefaultRepoPath(existing, "new")).toBe(path.join("c:\\data\\projects", "new"));
  });

  test("returns null when existing repos don't share a parent", () => {
    const existing = [
      { name: "a", path: "c:\\data\\projects\\a" },
      { name: "b", path: "d:\\elsewhere\\b" },
    ];
    expect(inferDefaultRepoPath(existing, "new")).toBeNull();
  });
});

describe("resolveRepoNameFuzzy", () => {
  test("returns undefined with no repos registered at all", () => {
    expect(resolveRepoNameFuzzy([], "anything")).toBeUndefined();
  });

  test("with exactly one repo registered, always resolves to it regardless of mismatch", () => {
    const only = [{ name: "aibridge", path: "/repos/aibridge" }];
    expect(resolveRepoNameFuzzy(only, "eI-Bridge")).toEqual(only[0]);
    expect(resolveRepoNameFuzzy(only, "completely-unrelated-name")).toEqual(only[0]);
  });

  test("with several repos, resolves the unambiguous closest voice-transcription-style match", () => {
    const repos = [
      { name: "aibridge", path: "/repos/aibridge" },
      { name: "seowrite", path: "/repos/seowrite" },
    ];
    expect(resolveRepoNameFuzzy(repos, "eI-Bridge")).toEqual(repos[0]);
  });

  test("refuses to guess when two repos are equidistant - ambiguous, not a match", () => {
    const repos = [
      { name: "abcd", path: "/repos/abcd" },
      { name: "abce", path: "/repos/abce" },
    ];
    // "abcx" is distance 1 from both - a genuine tie.
    expect(resolveRepoNameFuzzy(repos, "abcx")).toBeUndefined();
  });

  test("refuses to guess when nothing is close enough", () => {
    const repos = [
      { name: "aibridge", path: "/repos/aibridge" },
      { name: "seowrite", path: "/repos/seowrite" },
    ];
    expect(resolveRepoNameFuzzy(repos, "totally-different")).toBeUndefined();
  });

  test("an exact name match among several still resolves (distance 0)", () => {
    const repos = [
      { name: "aibridge", path: "/repos/aibridge" },
      { name: "seowrite", path: "/repos/seowrite" },
    ];
    expect(resolveRepoNameFuzzy(repos, "seowrite")).toEqual(repos[1]);
  });
});

describe("cloneRepo", () => {
  test("clones a local repo path (used here as a stand-in remote) into destPath", () => {
    const source = makeFakeRepoDir();
    // `git clone` a bare `.git`-marker-only dir isn't a real repo clone target - make it a real one.
    execFileSync("git", ["init", "--quiet"], { cwd: source });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "--quiet"], {
      cwd: source,
    });
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "aibridge-clonedest-")), "cloned");
    try {
      cloneRepo(source, dest);
      expect(existsSync(path.join(dest, ".git"))).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(path.dirname(dest), { recursive: true, force: true });
    }
  });

  test("surfaces git's own stderr on failure", () => {
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "aibridge-clonefail-")), "cloned");
    expect(() => cloneRepo("Z:\\nowhere\\not-a-repo", dest)).toThrow(/git clone failed/);
    rmSync(path.dirname(dest), { recursive: true, force: true });
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

  /**
   * The data-loss case. `addRepoEntry` treated *any* parse failure as "no registry yet" and then
   * rewrote the whole file from an empty list. README explicitly tells the operator to hand-edit this
   * file, so one bad line (an unquoted path, say) meant the next `/repos add` silently deleted every
   * other registration - and reported success. "Absent" and "corrupt" have to be different answers.
   */
  test("refuses to rewrite a repos.toml it could not parse, rather than replacing it", () => {
    withTempToml((tomlPath) => {
      const corrupt = "[existing]\npath = C:\\unquoted\\path\n";
      writeFileSync(tomlPath, corrupt);
      const repoDir = makeFakeRepoDir();

      expect(() => addRepoEntry(tomlPath, { name: "new", path: repoDir })).toThrow(/could not be parsed/);
      // Crucially: the original file is still there, untouched.
      expect(readFileSync(tomlPath, "utf8")).toBe(corrupt);

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
