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
