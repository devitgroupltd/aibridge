import { describe, expect, test } from "bun:test";
import { parseReposToml, ReposRegistry } from "../src/repos-registry.ts";

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
});
