import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import type { DriverRegistry } from "../../src/driver/types.js";
import { createBearerAuth, type BearerCaller } from "../../src/http/auth.js";
import {
  startHttpServer,
  type HttpServerHandle,
} from "../../src/http/server.js";
import type { TaskStore } from "../../src/store/sqlite.js";
import {
  agentToml,
  type AgentTomlFields,
  baseEnv,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "../config/helpers.js";

export interface TestCaller extends BearerCaller {
  tokenEnv: string;
}

export interface TestHttpApp {
  handle: HttpServerHandle;
  store: TaskStore;
  callers: TestCaller[];
  close(): Promise<void>;
}

/**
 * 建一個暫存目錄設定檔（`[[callers]]` 由 `callers` 參數指定），起一個真的
 * `startHttpServer`（`127.0.0.1:0` 隨機埠），回傳可用來組 URL / bearer token 的 handle。
 */
export interface CreateTestHttpAppOptions {
  listen?: string;
  allowedHosts?: string[];
  agent?: AgentTomlFields;
}

export async function createTestHttpApp(
  drivers: DriverRegistry,
  callers: TestCaller[],
  options: CreateTestHttpAppOptions = {},
): Promise<TestHttpApp> {
  const dir = await makeTempDir();
  await makeWorkspace(dir, "workspace");
  await makeFakeExecutable(dir, "claude");
  const dbPath = `${dir}/agentport.sqlite`;
  const logDir = `${dir}/logs`;

  const callerToml = callers
    .map(
      (caller) =>
        `\n[[callers]]\nname = "${caller.name}"\ntoken_env = "${caller.tokenEnv}"\n`,
    )
    .join("");

  const listen = options.listen ?? "127.0.0.1:0";
  const allowedHostsToml =
    options.allowedHosts && options.allowedHosts.length > 0
      ? `allowed_hosts = [${options.allowedHosts.map((host) => `"${host}"`).join(", ")}]\n`
      : "";

  const toml = `${agentToml(options.agent)}${callerToml}\n[server]\nlisten = "${listen}"\n${allowedHostsToml}\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`;
  const configPath = await writeConfigFile(dir, toml);

  const envOverrides: Record<string, string> = { HOME: dir, PATH: dir };
  for (const caller of callers) {
    envOverrides[caller.tokenEnv] = caller.token;
  }
  const env = baseEnv(envOverrides);

  const loadResult = loadConfig(configPath, env);
  if (!loadResult.ok) {
    throw new Error(
      `測試設定檔載入失敗：${loadResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }

  return createTestHttpAppFromConfig(loadResult.config, drivers, callers);
}

async function createTestHttpAppFromConfig(
  config: Config,
  drivers: DriverRegistry,
  callers: TestCaller[],
): Promise<TestHttpApp> {
  const app = createApp({ config, drivers, caller: "local" });
  const auth = createBearerAuth(callers);
  const handle = await startHttpServer({
    listen: config.server.listen,
    serverFactory: app.serverFactory,
    auth,
    allowedHosts: config.server.allowed_hosts,
  });

  return {
    handle,
    store: app.store,
    callers,
    async close() {
      await handle.close();
      app.close();
    },
  };
}
