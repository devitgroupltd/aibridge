import { describe, expect, test } from "bun:test";
import { ABOUT_TOPICS, buildAboutKeyboard, buildDialogueGroundingText, isAboutCommand, renderAbout, resolveAboutCallback } from "../src/about.ts";

describe("isAboutCommand", () => {
  test("matches a bare /about, with surrounding whitespace tolerated", () => {
    expect(isAboutCommand("/about")).toBe(true);
    expect(isAboutCommand("  /about  ")).toBe(true);
  });

  test("does not match /help, a prefix, or plain chat text", () => {
    expect(isAboutCommand("/help")).toBe(false);
    expect(isAboutCommand("/about me")).toBe(false);
    expect(isAboutCommand("aboutish")).toBe(false);
    expect(isAboutCommand("")).toBe(false);
  });
});

describe("renderAbout", () => {
  test("lists every topic's blurb and points at /help for exact syntax", () => {
    const text = renderAbout();
    for (const topic of Object.values(ABOUT_TOPICS)) {
      expect(text).toContain(topic.blurb);
    }
    expect(text).toContain("/help");
  });
});

// plans/control-topic-nl-dialogue-plan.md §3.3 - grounding text for the control-topic Q&A call.
describe("buildDialogueGroundingText", () => {
  test("includes both renderHelp's and renderAbout's content plus an architecture note", () => {
    const text = buildDialogueGroundingText();
    expect(text).toContain("Fleet commands");
    expect(text).toContain("aibridge lets you run and manage");
    expect(text).toContain("Architecture:");
  });
});

describe("buildAboutKeyboard", () => {
  test("one button per topic, each resolving back to that same topic id", () => {
    const keyboard = buildAboutKeyboard();
    const flat = keyboard.flat();
    expect(flat).toHaveLength(Object.keys(ABOUT_TOPICS).length);
    for (const button of flat) {
      const id = resolveAboutCallback(button.callback_data);
      expect(id).not.toBeNull();
      expect(ABOUT_TOPICS[id as string]?.label).toBe(button.text);
    }
  });
});

describe("resolveAboutCallback", () => {
  test("resolves every known topic id", () => {
    for (const id of Object.keys(ABOUT_TOPICS)) {
      expect(resolveAboutCallback(`about:${id}`)).toBe(id);
    }
  });

  test("rejects an unknown id, a different namespace, and malformed data", () => {
    expect(resolveAboutCallback("about:not_a_real_topic")).toBeNull();
    expect(resolveAboutCallback("run:showcommands")).toBeNull();
    expect(resolveAboutCallback("about:")).toBeNull();
    expect(resolveAboutCallback("garbage")).toBeNull();
  });

  test("rejects an id containing characters outside [a-z_] (tampered callback_data)", () => {
    expect(resolveAboutCallback("about:sessions;drop")).toBeNull();
    expect(resolveAboutCallback("about:Sessions")).toBeNull();
  });
});
