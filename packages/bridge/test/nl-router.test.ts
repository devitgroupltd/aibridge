import { describe, expect, test } from "bun:test";
import { mapRouterOutput } from "../src/nl-router.ts";

const CONTROL: { isControl: true; hasSession: false } = { isControl: true, hasSession: false };
const SESSION: { isControl: false; hasSession: true } = { isControl: false, hasSession: true };

describe("mapRouterOutput - one case per kind", () => {
  test("new: requires both repo and prompt", () => {
    expect(mapRouterOutput({ kind: "new", repo: "seowrite", prompt: "fix the bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "new", repo: "seowrite", prompt: "fix the bug", model: undefined },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "new", repo: "seowrite" }, CONTROL)).toEqual({ matched: false });
  });

  test("new: rejected outside the control topic, same scoping as dispatchInboundMessage", () => {
    expect(mapRouterOutput({ kind: "new", repo: "seowrite", prompt: "fix it" }, SESSION)).toEqual({ matched: false });
  });

  test("ls: no fields needed", () => {
    expect(mapRouterOutput({ kind: "ls" }, CONTROL)).toEqual({ matched: true, command: { kind: "ls" }, destructive: false });
  });

  test("kill: single-slug is destructive even without --all", () => {
    expect(mapRouterOutput({ kind: "kill", slug: "fix-bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "kill", slug: "fix-bug", all: false },
      destructive: true,
    });
  });

  test("kill: bare (no slug) inside a session topic - relies on dispatch's own currentSlug fallback", () => {
    expect(mapRouterOutput({ kind: "kill" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "kill", slug: undefined, all: false },
      destructive: true,
    });
  });

  test("rm: --all bulk", () => {
    expect(mapRouterOutput({ kind: "rm", all: true }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: { mode: "all" } },
      destructive: true,
    });
  });

  test("rm: --dead bulk", () => {
    expect(mapRouterOutput({ kind: "rm", bulkMode: "dead" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: { mode: "dead" } },
      destructive: true,
    });
  });

  test("rm: --prefix bulk requires bulkPrefix", () => {
    expect(mapRouterOutput({ kind: "rm", bulkMode: "prefix", bulkPrefix: "fix-" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: { mode: "prefix", prefix: "fix-" } },
      destructive: true,
    });
    // bulkMode 'prefix' with no bulkPrefix falls through to a plain single-slug rm, not a crash.
    expect(mapRouterOutput({ kind: "rm", bulkMode: "prefix" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: undefined },
      destructive: true,
    });
  });

  test("attach/pause/usage: optional slug, none destructive", () => {
    expect(mapRouterOutput({ kind: "attach", slug: "fix-bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "attach", slug: "fix-bug" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "pause" }, SESSION)).toEqual({ matched: true, command: { kind: "pause", slug: undefined }, destructive: false });
    expect(mapRouterOutput({ kind: "usage" }, SESSION)).toEqual({ matched: true, command: { kind: "usage", slug: undefined }, destructive: false });
  });

  test("budget: control-topic only", () => {
    expect(mapRouterOutput({ kind: "budget" }, CONTROL)).toEqual({ matched: true, command: { kind: "budget" }, destructive: false });
    expect(mapRouterOutput({ kind: "budget" }, SESSION)).toEqual({ matched: false });
  });

  test("restart and deploy are destructive", () => {
    expect(mapRouterOutput({ kind: "restart" }, CONTROL)).toEqual({ matched: true, command: { kind: "restart" }, destructive: true });
    expect(mapRouterOutput({ kind: "deploy", slug: "fix-bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "deploy", slug: "fix-bug" },
      destructive: true,
    });
    // deploy requires a slug - there's nothing sensible to deploy without one.
    expect(mapRouterOutput({ kind: "deploy" }, CONTROL)).toEqual({ matched: false });
  });

  test("detail and verbose: not destructive, validate their enum fields", () => {
    expect(mapRouterOutput({ kind: "detail", slug: "fix-bug", level: "full" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "detail", slug: "fix-bug", level: "full" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "verbose", on: true }, SESSION)).toEqual({
      matched: true,
      command: { kind: "verbose", slug: undefined, on: true },
      destructive: false,
    });
  });

  test("settings, autostart, voice: not destructive", () => {
    expect(mapRouterOutput({ kind: "settings" }, CONTROL)).toEqual({ matched: true, command: { kind: "settings" }, destructive: false });
    expect(mapRouterOutput({ kind: "autostart", autostartAction: "status" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "autostart", action: "status" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "autostart", autostartAction: "bogus" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "voice", voiceModel: "medium" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "voice", model: "medium" },
      destructive: false,
    });
  });

  test("repos: list/add/rm, only rm is destructive", () => {
    expect(mapRouterOutput({ kind: "repos", reposAction: "list" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "repos", action: "list" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "repos", reposAction: "add", reposName: "seowrite" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "repos", action: "add", name: "seowrite", path: undefined, base: undefined },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "repos", reposAction: "rm", reposName: "seowrite" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "repos", action: "rm", name: "seowrite" },
      destructive: true,
    });
    // add/rm without a name is a no-match, not a crash.
    expect(mapRouterOutput({ kind: "repos", reposAction: "add" }, CONTROL)).toEqual({ matched: false });
  });

  test("session_model/session_mode/session_effort: require a session, and a valid enum value", () => {
    expect(mapRouterOutput({ kind: "session_model", model: "opus" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "model", model: "opus" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "session_model", model: "opus" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "session_model", model: "not-a-real-model" }, SESSION)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "session_mode", mode: "plan" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "mode", mode: "plan" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "session_effort", effort: "high" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "effort", effort: "high" },
      destructive: false,
    });
  });

  test("forward: always a no-match, by design - it means 'not a command'", () => {
    expect(mapRouterOutput({ kind: "forward" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "forward" }, SESSION)).toEqual({ matched: false });
  });

  test("an unrecognised or missing kind is a no-match, not a throw", () => {
    expect(() => mapRouterOutput({}, CONTROL)).not.toThrow();
    expect(mapRouterOutput({}, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "not-a-real-kind" }, CONTROL)).toEqual({ matched: false });
  });
});
