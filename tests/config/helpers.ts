import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Env } from "../../src/config/paths.js";

const tempDirs: string[] = [];

/** 建一個乾淨的暫存目錄，記錄下來供 `cleanupTempDirs` 在 `afterEach` 清掉。 */
export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentport-config-"));
  tempDirs.push(dir);
  return dir;
}

/** 把本次測試建立的所有暫存目錄刪掉；在測試檔的 `afterEach` 呼叫。 */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** 在暫存目錄內寫一份 `agentport.toml`，回傳完整路徑。 */
export async function writeConfigFile(
  dir: string,
  toml: string,
): Promise<string> {
  const configPath = join(dir, "agentport.toml");
  await writeFile(configPath, toml, "utf8");
  return configPath;
}

/** 建一個真實存在的 Workspace 目錄，回傳完整路徑。 */
export async function makeWorkspace(
  dir: string,
  name: string,
): Promise<string> {
  const workspacePath = join(dir, name);
  await mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

/** 建一個可執行、內容無所謂的假 Runtime CLI，供 `runtime 可執行檔存在` 規則測試使用。 */
export async function makeFakeExecutable(
  dir: string,
  name: string,
): Promise<string> {
  const execPath = join(dir, name);
  await writeFile(execPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(execPath, 0o755);
  return execPath;
}

export function baseEnv(overrides: Env = {}): Env {
  return {
    HOME: "/nonexistent-home",
    PATH: "",
    ...overrides,
  };
}

export interface AgentTomlFields {
  name?: string | undefined;
  workspace?: string | undefined;
  runtime?: string | undefined;
  policy?: string | undefined;
}

/**
 * 產生一段 `[[agents]]` TOML 片段，預設是一個合法的 agent；
 * 傳 `{ policy: undefined }` 之類的欄位可以省略該欄位，用來測試必填規則。
 */
export function agentToml(fields: AgentTomlFields = {}): string {
  const merged: AgentTomlFields = {
    name: "stationhub",
    workspace: "workspace",
    runtime: "claude",
    policy: "workspace-write",
    ...fields,
  };
  const lines = ["[[agents]]"];
  for (const key of Object.keys(merged) as (keyof AgentTomlFields)[]) {
    const value = merged[key];
    if (value !== undefined) {
      lines.push(`${key} = "${value}"`);
    }
  }
  return `\n${lines.join("\n")}\n`;
}
