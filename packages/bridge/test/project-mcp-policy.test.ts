import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectMcpPolicy, readProjectMcpServerNames } from "../src/project-mcp-policy.ts";

function repoWith(mcpJson: string | undefined): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-mcp-policy-"));
  if (mcpJson !== undefined) writeFileSync(path.join(dir, ".mcp.json"), mcpJson);
  return dir;
}

describe("readProjectMcpServerNames", () => {
  test("returns the declared server names in file order", () => {
    const repo = repoWith(JSON.stringify({ mcpServers: { graylog: { command: "node" }, sentry: { type: "http", url: "https://example" }, trello: { command: "node" } } }));
    expect(readProjectMcpServerNames(repo)).toEqual(["graylog", "sentry", "trello"]);
  });

  // The common case - aibridge's own repo ships no .mcp.json - and it must not be an error.
  test("no .mcp.json is not a failure", () => {
    expect(readProjectMcpServerNames(repoWith(undefined))).toEqual([]);
  });

  // A target repo's broken file is that repo's problem. Refusing to launch a session over it would
  // make aibridge's availability depend on a file it does not own, and `[]` is also the safe answer:
  // nothing is written, and Claude Code's own dialog is still there as the backstop.
  test("a malformed .mcp.json degrades to nothing-to-say, loudly", () => {
    const logs: string[] = [];
    expect(readProjectMcpServerNames(repoWith("{ not json"), (_l, m) => logs.push(m))).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(".mcp.json");
  });

  test("a valid file with no mcpServers key is empty, not a crash", () => {
    expect(readProjectMcpServerNames(repoWith(JSON.stringify({ other: true })))).toEqual([]);
  });
});

describe("buildProjectMcpPolicy", () => {
  // The whole point of the default. A repo that has not opted in gets its servers rejected, which is
  // what stops Claude Code raising the consent dialog that ate an operator's first prompt.
  test("closed by default: names go into disabledMcpjsonServers", () => {
    expect(buildProjectMcpPolicy(["graylog", "trello"], false)).toEqual({ disabledMcpjsonServers: ["graylog", "trello"] });
  });

  test("opted in: the same names go into enabledMcpjsonServers", () => {
    expect(buildProjectMcpPolicy(["graylog", "trello"], true)).toEqual({ enabledMcpjsonServers: ["graylog", "trello"] });
  });

  // Deliberately not enableAllProjectMcpServers: what gets approved is what the repo declared at
  // launch, so a server added to .mcp.json later still raises a dialog rather than inheriting an
  // approval nobody made about it.
  test("the opted-in form never sets enableAllProjectMcpServers", () => {
    expect(buildProjectMcpPolicy(["graylog"], true)).not.toHaveProperty("enableAllProjectMcpServers");
  });

  // Saying nothing is not the same as saying "reject": an empty disabledMcpjsonServers in every
  // session's settings file is noise that invites the reader to think a policy is in force.
  test("a repo with no project servers produces no keys at all", () => {
    expect(buildProjectMcpPolicy([], false)).toEqual({});
    expect(buildProjectMcpPolicy([], true)).toEqual({});
  });
});
