import { describe, expect, it } from "vitest";

import { buildClaudeArgs } from "../../../src/driver/claude/args.js";

describe("buildClaudeArgs", () => {
  it("組出固定旗標並依 policy 對應 permission-mode，prompt 前有 --", () => {
    expect(
      buildClaudeArgs({ prompt: "hi", policy: "read-only", extra_args: [] }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompts",
      "none",
      "--permission-mode",
      "plan",
      "--",
      "hi",
    ]);
  });

  it("workspace-write 對應 acceptEdits", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      policy: "workspace-write",
      extra_args: [],
    });
    expect(args).toContain("acceptEdits");
  });

  it("full 對應 bypassPermissions", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      policy: "full",
      extra_args: [],
    });
    expect(args).toContain("bypassPermissions");
  });

  it("有 runtime_session_id 時在 -- 之前附加 --resume", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      policy: "full",
      extra_args: [],
      runtime_session_id: "abc-123",
    });
    expect(args.slice(-4)).toEqual(["--resume", "abc-123", "--", "hi"]);
  });

  it("extra_args 附在 -- 之前，--resume 之後", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      policy: "full",
      extra_args: ["--model", "opus"],
      runtime_session_id: "abc-123",
    });
    expect(args.slice(-6)).toEqual([
      "--resume",
      "abc-123",
      "--model",
      "opus",
      "--",
      "hi",
    ]);
  });

  it("prompt 剛好長得像旗標（--help）時仍原樣接在 -- 之後，不會被當成引數", () => {
    const args = buildClaudeArgs({
      prompt: "--help",
      policy: "read-only",
      extra_args: [],
    });
    expect(args.slice(-2)).toEqual(["--", "--help"]);
    expect(args.filter((arg) => arg === "--")).toHaveLength(1);
  });
});
