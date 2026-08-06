import { describe, expect, test } from "bun:test";
import { buildPermissionKeyboard, renderPermissionCard, resolvePermCallback } from "../src/permission-callback.ts";

describe("resolvePermCallback", () => {
  test("resolves allow, deny and always", () => {
    expect(resolvePermCallback("perm:abcde:a")).toEqual({ requestId: "abcde", action: "allow" });
    expect(resolvePermCallback("perm:abcde:d")).toEqual({ requestId: "abcde", action: "deny" });
    expect(resolvePermCallback("perm:abcde:A")).toEqual({ requestId: "abcde", action: "always" });
  });

  test("rejects an unknown action code (tampered callback_data)", () => {
    expect(resolvePermCallback("perm:abcde:x")).toBeNull();
  });

  test("rejects anything not matching the perm: shape", () => {
    expect(resolvePermCallback("run:builtin:compact")).toBeNull();
    expect(resolvePermCallback("perm:abcde")).toBeNull();
    expect(resolvePermCallback("garbage")).toBeNull();
  });
});

describe("buildPermissionKeyboard", () => {
  test("builds an allow/deny row and an always row, matching resolvePermCallback's own encoding", () => {
    const keyboard = buildPermissionKeyboard("abcde");
    const flat = keyboard.flat().map((btn) => btn.callback_data!);
    for (const data of flat) {
      expect(resolvePermCallback(data)).not.toBeNull();
    }
    expect(flat).toEqual(["perm:abcde:a", "perm:abcde:d", "perm:abcde:A"]);
  });
});

describe("renderPermissionCard", () => {
  test("includes the tool name, description and input preview", () => {
    const text = renderPermissionCard({
      slug: "refactor-billing",
      toolName: "Bash",
      description: "Commit the billing fix",
      inputPreview: '{ "command": "git commit -m \\"fix\\"" }',
    });
    expect(text).toContain("refactor-billing");
    expect(text).toContain("Bash");
    expect(text).toContain("Commit the billing fix");
    expect(text).toContain("git commit");
  });
});
