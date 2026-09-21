import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ZodType } from "zod";
import { parse as parseToml } from "smol-toml";

import { expandConfigPaths } from "./expand.js";
import { zodIssuesToConfigErrors, type ConfigError } from "./errors.js";
import type { Env } from "./paths.js";
import {
  AgentSchema,
  CallerSchema,
  ConfigShapeSchema,
  type Config,
} from "./schema.js";
import { validateSemantics } from "./semantics.js";

export type { ConfigError } from "./errors.js";
export type LoadResult =
  { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

/**
 * 讀取並驗證設定檔。純函式：不讀 `process.env`、不用全域狀態，只用傳入的 `env`。
 * 錯誤一次全部收集：讀檔 / TOML 語法錯誤各自單獨回報一個錯誤；
 * 通過後頂層形狀與每個 agents[i] / callers[i] 個別做 zod 結構驗證，
 * 語意驗證（唯一性、workspace、runtime 執行檔……）只跑在通過結構驗證的項目上，
 * 結構錯誤與語意錯誤一起收集回傳，不因為某一項目結構有誤就跳過其他項目的語意驗證。
 */
export function loadConfig(path: string, env: Env): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: "$", message: describeReadError(path, error) }],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          message: `TOML 語法錯誤：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const shapeResult = ConfigShapeSchema.safeParse(parsed);
  if (!shapeResult.success) {
    return {
      ok: false,
      errors: zodIssuesToConfigErrors(shapeResult.error.issues),
    };
  }
  const {
    server,
    storage,
    runtimes,
    agents: rawAgents,
    callers: rawCallers,
  } = shapeResult.data;

  const errors: ConfigError[] = [];
  const validAgents = parseIndexed(rawAgents, AgentSchema, "agents", errors);
  const validCallers = parseIndexed(
    rawCallers,
    CallerSchema,
    "callers",
    errors,
  );

  const baseDir = dirname(resolve(path));
  const expanded = expandConfigPaths(
    { storage, runtimes },
    validAgents,
    env,
    baseDir,
  );
  errors.push(...expanded.errors);

  errors.push(
    ...validateSemantics(expanded.agents, validCallers, expanded.runtimes, env),
  );

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      server,
      storage: expanded.storage,
      runtimes: expanded.runtimes,
      agents: expanded.agents.map(({ value }) => value),
      callers: validCallers.map(({ value }) => value),
    },
  };
}

/**
 * 對陣列裡的每個項目個別 safeParse：結構有誤的項目只回報自己的錯誤，
 * 不影響其他結構正確的項目（回傳時附原始 index，供錯誤訊息與後續處理使用）。
 */
function parseIndexed<T>(
  raw: unknown[],
  schema: ZodType<T>,
  prefix: "agents" | "callers",
  errors: ConfigError[],
): { index: number; value: T }[] {
  const valid: { index: number; value: T }[] = [];
  raw.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push({ index, value: result.data });
      return;
    }
    for (const issue of zodIssuesToConfigErrors(result.error.issues)) {
      errors.push({
        path:
          issue.path === "$"
            ? `${prefix}[${String(index)}]`
            : `${prefix}[${String(index)}].${issue.path}`,
        message: issue.message,
      });
    }
  });
  return valid;
}

function describeReadError(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
      return `設定檔不存在：${path}`;
    case "EACCES":
      return `沒有讀取權限：${path}`;
    case "EISDIR":
      return `設定檔路徑是目錄，不是檔案：${path}`;
    default:
      return `設定檔無法讀取：${path}（${error instanceof Error ? error.message : String(error)}）`;
  }
}
