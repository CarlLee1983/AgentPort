import * as os from "node:os";

import { runTurn } from "../turn.js";
import type { RuntimeDriver, Turn, TurnHooks, TurnInput } from "../types.js";
import { buildClaudeArgs } from "./args.js";
import { createClaudeParser } from "./events.js";

export interface CreateClaudeDriverInput {
  /** `claude` 可執行檔路徑或裸名（走 PATH），來自設定檔 `[runtimes.claude].command`。 */
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 確保 `USER` 存在：macOS 上 Claude 讀 login Keychain 用 `security find-generic-password
 * -a $USER`，`USER` 沒設就查錯帳號、變成「未登入」（research/claude-headless.md §4.2）。
 * `os.userInfo()` 在極少數環境（如找不到目前使用者的 passwd 項目）會丟例外，
 * 丟例外就放棄補值，讓後續行為維持原樣而不是讓整個 Driver 建構失敗。
 */
function withUser(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.USER) {
    return env;
  }
  try {
    return { ...env, USER: os.userInfo().username };
  } catch {
    return env;
  }
}

/**
 * `claude -p --output-format stream-json` 的 Runtime Driver。
 * `env` 一定確保含 `USER`；不加 `--ignore-user-config` / `--setting-sources`，
 * 尊重管理者個人的 CLI 設定（hooks、model 等）。
 */
export function createClaudeDriver(
  input: CreateClaudeDriverInput,
): RuntimeDriver {
  const env = withUser(input.env);

  function start(turnInput: TurnInput, hooks?: TurnHooks): Turn {
    const args = buildClaudeArgs({
      prompt: turnInput.prompt,
      policy: turnInput.policy,
      extra_args: turnInput.extra_args,
    });
    return runTurn({
      name: "claude",
      command: input.command,
      args,
      workspace: turnInput.workspace,
      env,
      parser: createClaudeParser(),
      ...(hooks?.onRawLine
        ? {
            onRawLine: (line: string) => {
              hooks.onRawLine?.(line);
            },
          }
        : {}),
    });
  }

  function resume(
    turnInput: TurnInput & { runtime_session_id: string },
    hooks?: TurnHooks,
  ): Turn {
    const args = buildClaudeArgs({
      prompt: turnInput.prompt,
      policy: turnInput.policy,
      extra_args: turnInput.extra_args,
      runtime_session_id: turnInput.runtime_session_id,
    });
    return runTurn({
      name: "claude",
      command: input.command,
      args,
      workspace: turnInput.workspace,
      env,
      parser: createClaudeParser(),
      ...(hooks?.onRawLine
        ? {
            onRawLine: (line: string) => {
              hooks.onRawLine?.(line);
            },
          }
        : {}),
    });
  }

  return { start, resume };
}
