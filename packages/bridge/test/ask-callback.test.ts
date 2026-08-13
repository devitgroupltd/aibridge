import { describe, expect, test } from "bun:test";
import {
  buildAskKeyboard,
  renderAskAnsweredCard,
  renderAskCancelledCard,
  renderAskCard,
  resolveAskCallback,
  sweepExpiredAsks,
  type ExpiringAskRegistry,
} from "../src/ask-callback.ts";

describe("resolveAskCallback", () => {
  test("resolves id, question index and option index from a real tool_use_id-shaped id", () => {
    expect(resolveAskCallback("ask:toolu_013ZNWVrhNiVB6prCBanHSyp:0:1")).toEqual({
      id: "toolu_013ZNWVrhNiVB6prCBanHSyp",
      questionIndex: 0,
      optionIndex: 1,
    });
  });

  test("rejects anything not matching the ask: shape", () => {
    expect(resolveAskCallback("perm:abcde:a")).toBeNull();
    expect(resolveAskCallback("ask:toolu_1:0")).toBeNull();
    expect(resolveAskCallback("garbage")).toBeNull();
  });
});

describe("buildAskKeyboard", () => {
  test("builds one row per option, matching resolveAskCallback's own encoding", () => {
    const keyboard = buildAskKeyboard("toolu_1", 0, [{ label: "Red" }, { label: "Blue" }]);
    expect(keyboard).toEqual([
      [{ text: "Red", callback_data: "ask:toolu_1:0:0" }],
      [{ text: "Blue", callback_data: "ask:toolu_1:0:1" }],
    ]);
    for (const row of keyboard) {
      for (const button of row) {
        expect(resolveAskCallback(button.callback_data!)).not.toBeNull();
      }
    }
  });
});

describe("card rendering", () => {
  test("renderAskCard includes the slug, header and question", () => {
    const text = renderAskCard("test-session", "Pick a color", "Color");
    expect(text).toContain("test-session");
    expect(text).toContain("Color");
    expect(text).toContain("Pick a color");
  });

  test("renderAskAnsweredCard includes the chosen label", () => {
    const text = renderAskAnsweredCard("test-session", "Pick a color", "Color", "Red");
    expect(text).toContain("Red");
  });

  test("renderAskCancelledCard marks the question as cancelled without naming any option", () => {
    const text = renderAskCancelledCard("test-session", "Pick a color", "Color");
    expect(text).toContain("cancelled");
  });
});

describe("sweepExpiredAsks", () => {
  function fakeRegistry(entries: ReturnType<ExpiringAskRegistry["expired"]>): ExpiringAskRegistry {
    return { expired: () => entries };
  }

  const askEntry = (slug: string, id: string) => ({
    id,
    slug,
    questions: [{ question: "Pick a color", header: "Color", messageId: 55 }],
  });

  test("cancels each expired ask and edits its card in place", () => {
    const cancelled: string[] = [];
    const finalized: Array<{ messageId: number; text: string }> = [];

    sweepExpiredAsks(
      fakeRegistry([askEntry("fix-bug", "toolu_1")]),
      (id) => cancelled.push(id),
      async (messageId, text) => {
        finalized.push({ messageId, text });
      },
      () => {},
      () => {
        throw new Error("finalizeMessage should not reject in this test");
      },
    );

    expect(cancelled).toEqual(["toolu_1"]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.messageId).toBe(55);
    expect(finalized[0]?.text).toContain("cancelled");
  });

  // The half this originally missed. `cancelAsk` unblocks the hook, so the session is working again
  // the instant the sweep runs - but the row still said `awaiting_input`, because the only place
  // that moved it back was the button-tap path in `callback-query-router.ts`. Found live 2026-08-13:
  // a row frozen at `awaiting_input` with an hour-stale `last_event_utc` while its session ran on.
  test("reports the resolved slug so the row can leave awaiting_input", () => {
    const resolved: string[] = [];

    sweepExpiredAsks(
      fakeRegistry([askEntry("fix-bug", "toolu_1"), askEntry("other-task", "toolu_2")]),
      () => {},
      async () => {},
      (slug) => resolved.push(slug),
      () => {},
    );

    expect(resolved).toEqual(["fix-bug", "other-task"]);
  });

  // Ordering guard: a slug reported *before* its ask is actually cancelled would move the row to
  // `working` while the hook was still blocked - briefly true by luck today, wrong the moment
  // anything downstream reads the state synchronously.
  test("cancels the ask before reporting the slug as resolved", () => {
    const order: string[] = [];

    sweepExpiredAsks(
      fakeRegistry([askEntry("fix-bug", "toolu_1")]),
      () => order.push("cancel"),
      async () => {},
      () => order.push("resolve"),
      () => {},
    );

    expect(order).toEqual(["cancel", "resolve"]);
  });

  test("skips the card edit for a question that was already answered, but still cancels the ask", () => {
    const finalized: number[] = [];
    const cancelled: string[] = [];

    sweepExpiredAsks(
      fakeRegistry([
        {
          id: "toolu_1",
          slug: "fix-bug",
          questions: [
            { question: "Pick a color", header: "Color", messageId: 55, answerLabel: "Red" },
            { question: "Pick a size", header: "Size", messageId: 56 },
          ],
        },
      ]),
      (id) => cancelled.push(id),
      async (messageId) => {
        finalized.push(messageId);
      },
      () => {},
      () => {},
    );

    expect(cancelled).toEqual(["toolu_1"]);
    expect(finalized).toEqual([56]);
  });

  test("is a no-op when nothing has expired", () => {
    let touched = false;
    sweepExpiredAsks(fakeRegistry([]), () => { touched = true; }, async () => {}, () => { touched = true; }, () => {});
    expect(touched).toBe(false);
  });

  // A failing Telegram edit must never stop the cancel from having happened - the hook is already
  // unblocked by then, and throwing here would take the whole 60s sweep down with it.
  test("routes a rejected card edit to onFinalizeError instead of throwing", async () => {
    const errors: string[] = [];
    sweepExpiredAsks(
      fakeRegistry([askEntry("fix-bug", "toolu_1")]),
      () => {},
      async () => {
        throw new Error("message to edit not found");
      },
      () => {},
      (err) => errors.push(err.message),
    );
    await Promise.resolve();
    expect(errors).toEqual(["message to edit not found"]);
  });
});
