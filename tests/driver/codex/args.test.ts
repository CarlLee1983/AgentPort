import { describe, expect, it } from "vitest";

import { buildCodexArgs } from "../../../src/driver/codex/args.js";

describe("buildCodexArgs", () => {
  it("start：固定旗標並依 policy 對應 --sandbox，prompt 前有 --", () => {
    expect(
      buildCodexArgs({ prompt: "hi", policy: "read-only", extra_args: [] }),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--",
      "hi",
    ]);
  });

  it("workspace-write 對應 workspace-write", () => {
    const args = buildCodexArgs({
      prompt: "hi",
      policy: "workspace-write",
      extra_args: [],
    });
    expect(args).toContain("workspace-write");
  });

  it("full 對應 danger-full-access", () => {
    const args = buildCodexArgs({
      prompt: "hi",
      policy: "full",
      extra_args: [],
    });
    expect(args).toContain("danger-full-access");
  });

  it("extra_args 附在 -- 之前", () => {
    const args = buildCodexArgs({
      prompt: "hi",
      policy: "read-only",
      extra_args: ["--model", "o3"],
    });
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "o3",
      "--",
      "hi",
    ]);
  });

  it("有 runtime_session_id 時走 resume，沙箱改用 -c sandbox_mode（resume 沒有 --sandbox），-- 後接 thread id 與 prompt", () => {
    const args = buildCodexArgs({
      prompt: "剛才寫了什麼檔案",
      policy: "workspace-write",
      extra_args: [],
      runtime_session_id: "01a0c200-a57f-70d0-a07f-5438e02083d5",
    });
    expect(args).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "--",
      "01a0c200-a57f-70d0-a07f-5438e02083d5",
      "剛才寫了什麼檔案",
    ]);
  });

  it("resume 時 extra_args 附在 -- 之前，thread id 與 prompt 接在 -- 之後", () => {
    const args = buildCodexArgs({
      prompt: "hi",
      policy: "full",
      extra_args: ["--model", "o3"],
      runtime_session_id: "thread-1",
    });
    expect(args).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="danger-full-access"',
      "--model",
      "o3",
      "--",
      "thread-1",
      "hi",
    ]);
  });

  it("prompt 剛好長得像旗標（--help）時仍原樣接在 -- 之後，不會被當成引數", () => {
    const args = buildCodexArgs({
      prompt: "--help",
      policy: "read-only",
      extra_args: [],
    });
    expect(args.slice(-2)).toEqual(["--", "--help"]);
    expect(args.filter((arg) => arg === "--")).toHaveLength(1);
  });
});
