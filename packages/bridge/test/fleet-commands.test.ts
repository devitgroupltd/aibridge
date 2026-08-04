import { describe, expect, test } from "bun:test";
import { parseFleetCommand, renderAttach, renderBudget, renderLsTable } from "../src/fleet-commands.ts";
import type { SessionRow } from "../src/session-store.ts";

describe("parseFleetCommand", () => {
  test("/new <repo> <prompt> with no model flag", () => {
    expect(parseFleetCommand("/new seowrite fix the login bug")).toEqual({
      kind: "new",
      repo: "seowrite",
      prompt: "fix the login bug",
      model: undefined,
    });
  });

  test("/new --opus <repo> <prompt>", () => {
    expect(parseFleetCommand("/new --opus seowrite fix the login bug")).toEqual({
      kind: "new",
      repo: "seowrite",
      prompt: "fix the login bug",
      model: "opus",
    });
  });

  test("/new with no prompt is invalid", () => {
    expect(parseFleetCommand("/new seowrite")).toBeNull();
    expect(parseFleetCommand("/new")).toBeNull();
  });

  test("/ls takes no argument", () => {
    expect(parseFleetCommand("/ls")).toEqual({ kind: "ls" });
  });

  test("/kill, /rm, /attach, /pause with and without a slug", () => {
    expect(parseFleetCommand("/kill fix-bug")).toEqual({ kind: "kill", slug: "fix-bug" });
    expect(parseFleetCommand("/kill")).toEqual({ kind: "kill", slug: undefined });
    expect(parseFleetCommand("/rm fix-bug")).toEqual({ kind: "rm", slug: "fix-bug" });
    expect(parseFleetCommand("/attach fix-bug")).toEqual({ kind: "attach", slug: "fix-bug" });
    expect(parseFleetCommand("/pause fix-bug")).toEqual({ kind: "pause", slug: "fix-bug" });
  });

  test("/usage with and without a slug", () => {
    expect(parseFleetCommand("/usage fix-bug")).toEqual({ kind: "usage", slug: "fix-bug" });
    expect(parseFleetCommand("/usage")).toEqual({ kind: "usage", slug: undefined });
  });

  test("/budget takes no argument", () => {
    expect(parseFleetCommand("/budget")).toEqual({ kind: "budget" });
  });

  test("/rm --dead requests the bulk dead-row filter", () => {
    expect(parseFleetCommand("/rm --dead")).toEqual({ kind: "rm", bulk: { mode: "dead" } });
  });

  test("/rm --prefix <text> requests the bulk prefix filter", () => {
    expect(parseFleetCommand("/rm --prefix say-hello")).toEqual({ kind: "rm", bulk: { mode: "prefix", prefix: "say-hello" } });
  });

  test("/rm --prefix with no argument falls through to the ordinary single-slug form", () => {
    expect(parseFleetCommand("/rm --prefix")).toEqual({ kind: "rm", slug: "--prefix" });
  });

  test("/restart takes no argument", () => {
    expect(parseFleetCommand("/restart")).toEqual({ kind: "restart" });
  });

  test("returns null for anything that isn't one of these commands", () => {
    expect(parseFleetCommand("/model opus")).toBeNull();
    expect(parseFleetCommand("hello")).toBeNull();
    expect(parseFleetCommand("/lsx")).toBeNull();
  });
});

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-123",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "idle",
    turnCardMsg: null,
    paused: false,
    renamed: false,
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderLsTable", () => {
  test("empty fleet", () => {
    expect(renderLsTable([], Date.parse("2026-08-03T00:10:00.000Z"))).toBe("No sessions.");
  });

  test("includes slug, state, model, branch and age; flags a paused session, column-aligned inside an HTML <pre> block", () => {
    const text = renderLsTable([row(), row({ slug: "other", paused: true })], Date.parse("2026-08-03T00:10:00.000Z"));
    expect(text.startsWith("<pre>")).toBe(true);
    expect(text.endsWith("</pre>")).toBe(true);
    expect(text).toContain("fix-bug");
    expect(text).toContain("idle");
    expect(text).toContain("sonnet");
    expect(text).toContain("claude/fix-bug-1");
    expect(text).toContain("10m");
    expect(text).toContain("other");
    expect(text).toContain("idle (paused)");
  });

  test("every data row and the header share the same line length (column padding)", () => {
    const text = renderLsTable([row(), row({ slug: "other", paused: true })], Date.parse("2026-08-03T00:10:00.000Z"));
    const inner = text.slice("<pre>".length, -"</pre>".length);
    const lineLengths = new Set(inner.split("\n").map((l) => l.length));
    expect(lineLengths.size).toBe(1);
  });

  test("HTML-escapes untrusted content (defense in depth - slugs/branches are already sanitized upstream)", () => {
    const text = renderLsTable([row({ branch: "claude/<b>x</b>" })], Date.parse("2026-08-03T00:10:00.000Z"));
    expect(text).not.toContain("<b>x</b>");
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("§5.7's cost column shows a session's lifetime spend, formatted as USD", () => {
    const text = renderLsTable([row()], Date.parse("2026-08-03T00:10:00.000Z"), new Map([["fix-bug", 1.5]]));
    expect(text).toContain("$1.50");
  });

  test("a session missing from the cost map (no session_id yet, or no recorded spend) shows $0.00", () => {
    const text = renderLsTable([row()], Date.parse("2026-08-03T00:10:00.000Z"));
    expect(text).toContain("$0.00");
  });
});

describe("renderBudget", () => {
  test("shows fleet 5h/7d totals and a sorted, nonzero-only per-session breakdown", () => {
    const text = renderBudget(3.5, 12.25, new Map([["a", 1], ["b", 2.5], ["c", 0]]));
    expect(text).toContain("$3.50");
    expect(text).toContain("$12.25");
    const bLine = text.indexOf("b: $2.50");
    const aLine = text.indexOf("a: $1.00");
    expect(bLine).toBeGreaterThan(-1);
    expect(aLine).toBeGreaterThan(bLine);
    expect(text).not.toContain("c: $0.00");
  });

  test("an all-idle fleet omits the per-session breakdown section entirely", () => {
    const text = renderBudget(0, 0, new Map([["a", 0]]));
    expect(text).not.toContain("by session");
  });
});

describe("renderAttach", () => {
  test("includes the slug, the tail (in an HTML <pre> block) and a claude --resume hint when a session_id is known", () => {
    const text = renderAttach(row(), "some ptv output");
    expect(text).toContain("fix-bug");
    expect(text).toContain("<pre>some ptv output</pre>");
    expect(text).toContain("claude --resume sess-123");
  });

  test("falls back to a placeholder hint with no session_id yet", () => {
    const text = renderAttach(row({ sessionId: null }), "output");
    expect(text).toContain("no session_id recorded yet");
  });

  test("HTML-escapes the PTY tail - untrusted terminal output must not inject markup", () => {
    const text = renderAttach(row(), "</pre><b>pwned</b>");
    expect(text).not.toContain("<b>pwned</b>");
    expect(text).toContain("&lt;/pre&gt;&lt;b&gt;pwned&lt;/b&gt;");
  });
});
