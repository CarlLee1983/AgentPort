import { runTurn } from "../turn.js";
import type { RuntimeDriver, Turn, TurnHooks, TurnInput } from "../types.js";
import { buildCodexArgs } from "./args.js";
import { createCodexParser } from "./events.js";

export interface CreateCodexDriverInput {
  /** `codex` 可執行檔路徑或裸名（走 PATH），來自設定檔 `[runtimes.codex].command`。 */
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * `--resume` 一個不存在的 thread id 時完全沒有 JSONL 輸出，只能看 stderr（本票
 * 實測固定含這句原始錯誤文字），對映成 `session_unresumable`。
 */
function classifyStderr(stderrTail: string): "session_unresumable" | undefined {
  return stderrTail.includes("no rollout found for thread id")
    ? "session_unresumable"
    : undefined;
}

/**
 * `codex exec --json` 的 Runtime Driver。stdin 由 `spawnLines` 固定 ignore
 * （Codex 讀到 EOF 才開始）；不加 `--ignore-user-config`，尊重管理者個人的
 * `~/.codex/config.toml`。子程序結束若未見終態事件（`completed` / `failed`），
 * 以定型訊息組出 `failed`；spawn 失敗（如 ENOENT）同樣回 `failed`。
 */
export function createCodexDriver(
  input: CreateCodexDriverInput,
): RuntimeDriver {
  function start(turnInput: TurnInput, hooks?: TurnHooks): Turn {
    const args = buildCodexArgs({
      prompt: turnInput.prompt,
      policy: turnInput.policy,
      extra_args: turnInput.extra_args,
    });
    return runTurn({
      name: "codex",
      command: input.command,
      args,
      workspace: turnInput.workspace,
      env: input.env,
      parser: createCodexParser(),
      ...(hooks?.onRawLine
        ? {
            onRawLine: (line: string) => {
              hooks.onRawLine?.(line);
            },
          }
        : {}),
      classifyStderr,
    });
  }

  function resume(
    turnInput: TurnInput & { runtime_session_id: string },
    hooks?: TurnHooks,
  ): Turn {
    const args = buildCodexArgs({
      prompt: turnInput.prompt,
      policy: turnInput.policy,
      extra_args: turnInput.extra_args,
      runtime_session_id: turnInput.runtime_session_id,
    });
    return runTurn({
      name: "codex",
      command: input.command,
      args,
      workspace: turnInput.workspace,
      env: input.env,
      parser: createCodexParser(),
      ...(hooks?.onRawLine
        ? {
            onRawLine: (line: string) => {
              hooks.onRawLine?.(line);
            },
          }
        : {}),
      classifyStderr,
    });
  }

  return { start, resume };
}
