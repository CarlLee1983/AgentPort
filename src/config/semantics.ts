import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { isLoopbackHost, parseListen } from "../http/listen.js";
import type { IndexedAgent } from "./expand.js";
import type { ConfigError } from "./errors.js";
import type { Env } from "./paths.js";
import type { Caller, Config } from "./schema.js";

export interface IndexedCaller {
  index: number;
  value: Caller;
}

/** 在一組帶原始 index 的項目中找出依 `keyOf` 算出的 key 重複的項目。 */
function findDuplicates<T>(
  items: { index: number; value: T }[],
  keyOf: (value: T) => string,
): { index: number; firstIndex: number }[] {
  const seen = new Map<string, number>();
  const duplicates: { index: number; firstIndex: number }[] = [];
  for (const { index, value } of items) {
    const key = keyOf(value);
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      duplicates.push({ index, firstIndex });
    } else {
      seen.set(key, index);
    }
  }
  return duplicates;
}

/**
 * 跑完所有跨欄位 / 檔案系統相關的驗證規則，收集所有錯誤（不因單一規則失敗就停止）。
 * 只對通過結構驗證（zod safeParse 成功）的 agents / callers 項目跑，
 * path 用它們在原始設定檔中的 index，不是在這個已過濾陣列中的位置。
 */
export function validateSemantics(
  agents: IndexedAgent[],
  callers: IndexedCaller[],
  runtimes: Config["runtimes"],
  server: Config["server"],
  env: Env,
): ConfigError[] {
  const errors: ConfigError[] = [];

  validateAgentNames(agents, errors);
  validateWorkspaces(agents, errors);
  validateCallers(callers, env, errors);
  validateRuntimeExecutables(agents, runtimes, env, errors);
  validateListenAllowedHosts(server, errors);

  return errors;
}

/**
 * 非 loopback `listen`（不是 127.0.0.1 / localhost / ::1）沒有實際隔離；
 * 一定要設 `allowed_hosts` 才放行，讓 `src/http/server.ts` 有明確的 Host /
 * Origin 允許清單，而不是預設對任何 Host header 開門。`listen` 格式錯誤留給
 * `src/http/server.ts` 啟動時再報，這裡只在格式正確、host 非 loopback時才擋。
 */
function validateListenAllowedHosts(
  server: Config["server"],
  errors: ConfigError[],
): void {
  let host: string;
  try {
    ({ host } = parseListen(server.listen));
  } catch {
    return;
  }
  if (isLoopbackHost(host)) {
    return;
  }
  if (server.allowed_hosts.length === 0) {
    errors.push({
      path: "server.allowed_hosts",
      message: "非 loopback 監聽必須設定 server.allowed_hosts",
    });
  }
}

function validateAgentNames(
  agents: IndexedAgent[],
  errors: ConfigError[],
): void {
  for (const { index, firstIndex } of findDuplicates(
    agents,
    (agent) => agent.name,
  )) {
    errors.push({
      path: `agents[${String(index)}].name`,
      message: `agent name 重複：與 agents[${String(firstIndex)}] 相同`,
    });
  }
}

function validateWorkspaces(
  agents: IndexedAgent[],
  errors: ConfigError[],
): void {
  const realpathItems: { index: number; value: string }[] = [];
  const workspaceByIndex = new Map<number, string>();
  for (const { index, value: agent } of agents) {
    if (!existsSync(agent.workspace)) {
      errors.push({
        path: `agents[${String(index)}].workspace`,
        message: `workspace 不存在：${agent.workspace}`,
      });
      continue;
    }
    if (!statSync(agent.workspace).isDirectory()) {
      errors.push({
        path: `agents[${String(index)}].workspace`,
        message: `workspace 不是目錄：${agent.workspace}`,
      });
      continue;
    }
    realpathItems.push({ index, value: realpathSync(agent.workspace) });
    workspaceByIndex.set(index, agent.workspace);
  }

  for (const { index, firstIndex } of findDuplicates(
    realpathItems,
    (real) => real,
  )) {
    errors.push({
      path: `agents[${String(index)}].workspace`,
      message: `workspace 已綁定給 agents[${String(firstIndex)}]：${workspaceByIndex.get(index) ?? ""}`,
    });
  }
}

function validateCallers(
  callers: IndexedCaller[],
  env: Env,
  errors: ConfigError[],
): void {
  for (const { index, firstIndex } of findDuplicates(
    callers,
    (caller) => caller.name,
  )) {
    errors.push({
      path: `callers[${String(index)}].name`,
      message: `caller name 重複：與 callers[${String(firstIndex)}] 相同`,
    });
  }

  const tokenItems: { index: number; value: string }[] = [];
  for (const { index, value: caller } of callers) {
    const token = env[caller.token_env];
    if (!token) {
      errors.push({
        path: `callers[${String(index)}].token_env`,
        message: `環境變數 ${caller.token_env} 未設定或為空`,
      });
      continue;
    }
    tokenItems.push({ index, value: token });
  }

  for (const { index, firstIndex } of findDuplicates(
    tokenItems,
    (token) => token,
  )) {
    errors.push({
      path: `callers[${String(index)}].token_env`,
      message: `token 與 callers[${String(firstIndex)}] 重複`,
    });
  }
}

function validateRuntimeExecutables(
  agents: IndexedAgent[],
  runtimes: Config["runtimes"],
  env: Env,
  errors: ConfigError[],
): void {
  const usedRuntimes = new Set(agents.map(({ value }) => value.runtime));
  for (const runtime of usedRuntimes) {
    const configuredCommand = runtimes[runtime].command;
    const isBareName = !configuredCommand.includes("/");
    const found = isBareName
      ? findOnPath(configuredCommand, env.PATH)
      : isExecutableFile(configuredCommand);
    if (!found) {
      errors.push({
        path: `runtimes.${runtime}.command`,
        message: isBareName
          ? `在 PATH 中找不到可執行檔：${configuredCommand}`
          : `runtime 執行檔不存在或不可執行：${configuredCommand}`,
      });
    }
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathEnv: string | undefined): boolean {
  if (!pathEnv) {
    return false;
  }
  return pathEnv
    .split(":")
    .some((dir) => dir !== "" && isExecutableFile(join(dir, name)));
}
