import type { Policy } from "../../config/schema.js";

/** policy 三級對應 Codex 的 sandbox 值（specs/agentport-v2.md「Runtime Driver」）。 */
const POLICY_TO_SANDBOX: Record<Policy, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  full: "danger-full-access",
};

export interface BuildCodexArgsInput {
  prompt: string;
  policy: Policy;
  extra_args: string[];
  /** 有值即接續既有的 Runtime Session（`codex exec resume`）。 */
  runtime_session_id?: string;
}

/**
 * 組出 `codex exec` 的命令列引數。純函式：不 spawn、不讀環境。
 *
 * `codex exec resume` 沒有 `-s/--sandbox` 選項（`codex exec resume --help` 本機實測，
 * 0.155.0），沙箱改用 `-c sandbox_mode="<值>"` 覆寫 config；實測（research/codex-exec.md
 * 之外，本票另行驗證）確認 `-c sandbox_mode="read-only"` 在 resume 時確實擋下寫入。
 * 兩種模式都固定加 `--json --skip-git-repo-check`，不加 `--ignore-user-config`，
 * 尊重管理者個人的 `~/.codex/config.toml`。
 *
 * `extra_args` 一律放在 `--` 之前；`prompt`（start）或 `thread_id prompt`
 * （resume）接在 `--` 之後當純位置參數，即使內容剛好長得像旗標（如
 * `--sandbox danger-full-access`）也不會被 `codex` 的 clap 解析器吃掉（本機
 * 0.155.0 實測 `codex exec ... -- "--sandbox ..."` 與 `codex exec resume ... --
 * <id> "--sandbox ..."` 都正常把它當文字，見 04/05 票 code review 的引數注入修正）。
 */
export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  const sandbox = POLICY_TO_SANDBOX[input.policy];
  if (input.runtime_session_id) {
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      `sandbox_mode="${sandbox}"`,
      ...input.extra_args,
      "--",
      input.runtime_session_id,
      input.prompt,
    ];
  }
  return [
    "exec",
    "--json",
    "--sandbox",
    sandbox,
    "--skip-git-repo-check",
    ...input.extra_args,
    "--",
    input.prompt,
  ];
}
