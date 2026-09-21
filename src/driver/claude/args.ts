import type { Policy } from "../../config/schema.js";

/** policy 三級對應 Claude 的 `--permission-mode`（specs/agentport-v2.md「Runtime Driver」）。 */
const POLICY_TO_PERMISSION_MODE: Record<Policy, string> = {
  "read-only": "plan",
  "workspace-write": "acceptEdits",
  full: "bypassPermissions",
};

export interface BuildClaudeArgsInput {
  prompt: string;
  policy: Policy;
  extra_args: string[];
  /** 有值即 `--resume`，代表接續既有的 Runtime Session。 */
  runtime_session_id?: string;
}

/**
 * 組出 `claude -p` 的命令列引數。純函式：不 spawn、不讀環境。
 * 固定加 `--output-format stream-json --verbose --permission-prompts none`；
 * 不加 `--ignore-user-config` / `--setting-sources`，尊重管理者個人的 CLI 設定。
 *
 * `prompt` 前一律加 `--`：`extra_args` 放在 `--` 之前，`prompt` 本身接在 `--`
 * 之後當純文字，即使 prompt 剛好長得像旗標（如 `--dangerously-skip-permissions`）
 * 也不會被 `claude` 當成引數解析（本機 2.1.278 實測 `claude -p -- "--help ..."`
 * 正常把它當文字回覆，見 04 票 code review 的引數注入修正）。
 */
export function buildClaudeArgs(input: BuildClaudeArgsInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "none",
    "--permission-mode",
    POLICY_TO_PERMISSION_MODE[input.policy],
  ];
  if (input.runtime_session_id) {
    args.push("--resume", input.runtime_session_id);
  }
  args.push(...input.extra_args);
  args.push("--", input.prompt);
  return args;
}
