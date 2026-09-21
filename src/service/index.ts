import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile as writeFileOnDisk,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve } from "node:path";

import { loadConfig } from "../config/load.js";
import { resolveConfigPath, type Env } from "../config/paths.js";
import { parseListen } from "../http/listen.js";
import { prepareConfiguration } from "./configuration.js";
import {
  assertWrapperCanBeInstalled,
  installWrapper,
  isAgentPortWrapper,
  renderWrapper,
  wrapperPath,
} from "./wrapper.js";

const SERVICE_USAGE =
  "usage: agentport service install [--dry-run] [--config <path>]\n" +
  "       agentport service status|restart|uninstall [--config <path>]";
const LAUNCH_AGENT_LABEL = "com.agentport.serve";
const READY_TIMEOUT_MS = 10_000;
const READY_RETRY_MS = 100;
const ERROR_LOG_TAIL_LINES = 20;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `service` 的系統邊界；後續安裝、重啟、移除都從這個單一入口注入。 */
export interface ServiceDependencies {
  platform: NodeJS.Platform;
  home: string;
  user: string;
  uid: number;
  nodePath: string;
  programRoot: string;
  env: Env;
  runCommand: (command: string, args: string[]) => Promise<CommandResult>;
  probePort: (listen: string) => Promise<boolean>;
  /** 票 02 的失敗 seam：拷貝完成前絕不停止既有服務。 */
  copyDirectory: (source: string, destination: string) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
  moveDirectory: (source: string, destination: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  generateToken: () => string;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

/** 正式 CLI 所用的依賴；測試以 `runService` 直接傳入完全可控的版本。 */
export function createProcessServiceDependencies(): ServiceDependencies {
  return {
    platform: process.platform,
    home: process.env.HOME ?? "",
    user: process.env.USER ?? "",
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    nodePath: process.execPath,
    programRoot: dirname(dirname(resolve(process.argv[1] ?? process.cwd()))),
    env: process.env,
    runCommand: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return Promise.resolve({
        exitCode: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
    probePort: probeTcpPort,
    copyDirectory: (source, destination) =>
      cp(source, destination, { recursive: true, force: true }),
    writeFile: (path, contents) => writeFileOnDisk(path, contents, "utf8"),
    moveDirectory: (source, destination) => rename(source, destination),
    removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    now: () => Date.now(),
    sleep: (milliseconds) =>
      new Promise((resolveSleep) => {
        setTimeout(resolveSleep, milliseconds);
      }),
    generateToken: () => randomBytes(32).toString("hex"),
    writeStdout: (line) => {
      console.log(line);
    },
    writeStderr: (line) => {
      console.error(line);
    },
  };
}

/**
 * 執行 service 子命令。安裝透過同一個 seam 注入 OS 命令、程式複製與 TCP 探測，
 * 讓檔案系統仍是暫存真檔、而失敗與時間可在測試中確定控制。
 */
export async function runService(
  args: string[],
  dependencies: ServiceDependencies,
): Promise<number> {
  const [command, ...rest] = args;
  if (
    command !== "install" &&
    command !== "status" &&
    command !== "restart" &&
    command !== "uninstall"
  ) {
    dependencies.writeStderr(SERVICE_USAGE);
    return 2;
  }

  if (dependencies.platform !== "darwin") {
    dependencies.writeStderr(`不支援的平台：${dependencies.platform}`);
    return 1;
  }

  if (command !== "install") {
    const parsed = parseConfigArgs(rest);
    if (!parsed.ok) {
      dependencies.writeStderr(SERVICE_USAGE);
      return 2;
    }
    return runMacosServiceCommand(command, parsed.configPath, dependencies);
  }

  const parsed = parseInstallArgs(rest);
  if (!parsed.ok) {
    dependencies.writeStderr(SERVICE_USAGE);
    return 2;
  }

  // launchd 不會繼承呼叫 install 的 cwd；服務定義中的兩條路徑必須固定為絕對路徑。
  const configPath = resolve(
    resolveConfigPath(parsed.configPath, dependencies.env),
  );
  const plistPath = join(
    dependencies.home,
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
  const installDirectory = serviceInstallDirectory(dependencies);
  const cliPath = join(installDirectory, "dist", "cli.js");
  const envPath = join(dirname(configPath), "agentport.env");
  const plist = renderMacosLaunchAgent({
    home: dependencies.home,
    user: dependencies.user,
    nodePath: dependencies.nodePath,
    cliPath,
    configPath,
    envPath,
  });

  if (parsed.dryRun) {
    const prepared = await prepareConfiguration({
      configPath,
      env: dependencies.env,
      generateToken: dependencies.generateToken,
      dryRun: true,
    });
    if (prepared.kind === "needs-configuration") {
      dependencies.writeStderr(`設定檔不存在：${prepared.configPath}`);
      return 1;
    }
    if (prepared.kind === "invalid-configuration") {
      reportConfigErrors(prepared.errors, dependencies);
      return 1;
    }
    dependencies.writeStdout(plist);
    dependencies.writeStdout(
      renderWrapper({
        home: dependencies.home,
        nodePath: dependencies.nodePath,
        cliPath,
      }),
    );
    dependencies.writeStdout(
      `launchctl bootstrap gui/${String(dependencies.uid)} ${plistPath}`,
    );
    return 0;
  }

  try {
    await assertWrapperCanBeInstalled(dependencies.home);
  } catch (error) {
    dependencies.writeStderr(describeError(error));
    return 1;
  }

  const prepared = await prepareConfiguration({
    configPath,
    env: dependencies.env,
    generateToken: dependencies.generateToken,
  });
  if (prepared.kind === "needs-configuration") {
    dependencies.writeStdout(
      `已產生設定檔：${prepared.configPath}；填好 agent 後重跑。`,
    );
    return 1;
  }
  if (prepared.kind === "invalid-configuration") {
    reportConfigErrors(prepared.errors, dependencies);
    return 1;
  }

  if (prepared.envPermissionTightened) {
    dependencies.writeStdout(`已將 env 檔權限收緊為 0600：${prepared.envPath}`);
  }
  for (const token of prepared.createdTokens) {
    dependencies.writeStdout(
      `新 token（只顯示這一次）：caller ${token.callerName}、${token.tokenEnv}、${token.value}`,
    );
  }

  const exitCode = await installMacos({
    dependencies,
    installDirectory,
    plistPath,
    plist,
    listen: prepared.config.server.listen,
  });
  if (exitCode !== 0) {
    return exitCode;
  }

  try {
    await installWrapper({
      home: dependencies.home,
      nodePath: dependencies.nodePath,
      cliPath,
    });
    return 0;
  } catch (error) {
    dependencies.writeStderr(`無法寫入包裝指令：${describeError(error)}`);
    return 1;
  }
}

type ParsedConfigArgs =
  { ok: true; configPath: string | undefined } | { ok: false };

function parseConfigArgs(args: string[]): ParsedConfigArgs {
  if (args.length === 0) {
    return { ok: true, configPath: undefined };
  }
  if (args.length === 2 && args[0] === "--config" && args[1] !== undefined) {
    return { ok: true, configPath: args[1] };
  }
  return { ok: false };
}

async function runMacosServiceCommand(
  command: "status" | "restart" | "uninstall",
  suppliedConfigPath: string | undefined,
  dependencies: ServiceDependencies,
): Promise<number> {
  const plistPath = join(
    dependencies.home,
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
  if (!existsSync(plistPath)) {
    const message = "AgentPort 服務未安裝";
    if (command === "restart") {
      dependencies.writeStderr(message);
      return 1;
    }
    dependencies.writeStdout(message);
    return 0;
  }

  const installed = await readInstalledService(plistPath);
  if (installed === undefined) {
    dependencies.writeStderr(`無法讀取已安裝的服務定義：${plistPath}`);
    return 1;
  }

  if (command === "uninstall") {
    return uninstallMacosService({
      dependencies,
      plistPath,
      installed,
      expectedInstallDirectory: serviceInstallDirectory(dependencies),
    });
  }

  const configPath = resolve(suppliedConfigPath ?? installed.configPath);
  const loaded = loadConfig(configPath, dependencies.env);

  if (command === "restart") {
    if (!loaded.ok) {
      reportConfigErrors(loaded.errors, dependencies);
      return 1;
    }
    return restartMacosService({
      dependencies,
      listen: loaded.config.server.listen,
    });
  }
  if (!loaded.ok) {
    reportConfigErrors(loaded.errors, dependencies);
  }
  return statusMacosService({
    dependencies,
    installed,
    listen: loaded.ok ? loaded.config.server.listen : undefined,
  });
}

function serviceInstallDirectory(
  dependencies: Pick<ServiceDependencies, "home" | "env">,
): string {
  const dataHome =
    dependencies.env.XDG_DATA_HOME ||
    join(dependencies.home, ".local", "share");
  return resolve(dependencies.home, dataHome, "agentport", "app");
}

async function assertSafeInstalledDirectory(
  installDirectory: string,
  home: string,
): Promise<void> {
  const resolvedHome = resolve(home);
  const relativeDirectory = relative(resolvedHome, installDirectory);
  if (
    relativeDirectory === "" ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith("../")
  ) {
    throw new Error(`拒絕移除 HOME 外的安裝目錄：${installDirectory}`);
  }
  let current = resolvedHome;
  for (const component of relativeDirectory.split("/")) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`拒絕經由 symbolic link 移除安裝目錄：${current}`);
      }
    } catch (error) {
      if (isMissingFile(error)) {
        continue;
      }
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

interface InstalledService {
  nodePath: string;
  installDirectory: string;
  configPath: string;
}

async function readInstalledService(
  plistPath: string,
): Promise<InstalledService | undefined> {
  try {
    const plist = await readFile(plistPath, "utf8");
    const argumentsMatch =
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
    if (argumentsMatch?.[1] === undefined) {
      return undefined;
    }
    const argumentsList = Array.from(
      argumentsMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g),
      (match) => unescapeXml(match[1] ?? ""),
    );
    const [nodePath, , cliPath] = argumentsList;
    const configFlagIndex = argumentsList.indexOf("--config");
    const configPath = argumentsList[configFlagIndex + 1];
    if (
      nodePath === undefined ||
      cliPath === undefined ||
      configFlagIndex === -1 ||
      configPath === undefined
    ) {
      return undefined;
    }
    return {
      nodePath,
      installDirectory: dirname(dirname(cliPath)),
      configPath,
    };
  } catch {
    return undefined;
  }
}

interface StatusMacosInput {
  dependencies: ServiceDependencies;
  installed: InstalledService;
  listen: string | undefined;
}

async function statusMacosService(input: StatusMacosInput): Promise<number> {
  const { dependencies, installed, listen } = input;
  const result = await dependencies.runCommand("launchctl", [
    "print",
    `gui/${String(dependencies.uid)}/${LAUNCH_AGENT_LABEL}`,
  ]);
  const running = /\bstate = running\b/.test(result.stdout);
  const pid = /\bpid = (\d+)\b/.exec(result.stdout)?.[1];
  const reachable =
    listen === undefined ? false : await dependencies.probePort(listen);
  const nodeExists = existsSync(installed.nodePath);

  dependencies.writeStdout(`服務狀態：${running ? "running" : "stopped"}`);
  if (pid !== undefined) {
    dependencies.writeStdout(`pid：${pid}`);
  }
  dependencies.writeStdout(
    listen === undefined
      ? "監聽位址：無法從無效設定檔判定"
      : `監聽位址：${listen}${reachable ? "（可連）" : "（無法連線）"}`,
  );
  dependencies.writeStdout(`安裝目錄：${installed.installDirectory}`);
  dependencies.writeStdout(`node 路徑：${installed.nodePath}`);
  if (!nodeExists) {
    dependencies.writeStderr("node 路徑已失效，請重跑 install");
  }
  const tail = await readErrorLogTail(
    join(
      dependencies.home,
      "Library",
      "Logs",
      "agentport",
      "agentport.err.log",
    ),
  );
  if (tail) {
    dependencies.writeStdout(`最近錯誤 log：\n${tail}`);
  }
  return result.exitCode === 0 &&
    running &&
    pid !== undefined &&
    reachable &&
    nodeExists
    ? 0
    : 1;
}

interface RestartMacosInput {
  dependencies: ServiceDependencies;
  listen: string;
}

async function restartMacosService(input: RestartMacosInput): Promise<number> {
  const { dependencies, listen } = input;
  const restarted = await dependencies.runCommand("launchctl", [
    "kickstart",
    "-k",
    `gui/${String(dependencies.uid)}/${LAUNCH_AGENT_LABEL}`,
  ]);
  if (restarted.exitCode !== 0) {
    dependencies.writeStderr(
      `launchctl kickstart 失敗：${restarted.stderr || restarted.stdout}`,
    );
    return 1;
  }
  if (await waitForListening(listen, dependencies)) {
    dependencies.writeStdout(`服務正在監聽 ${listen}`);
    return 0;
  }
  dependencies.writeStderr(`服務未在 10 秒內開始監聽 ${listen}`);
  const tail = await readErrorLogTail(
    join(
      dependencies.home,
      "Library",
      "Logs",
      "agentport",
      "agentport.err.log",
    ),
  );
  if (tail) {
    dependencies.writeStderr(tail);
  }
  return 1;
}

interface UninstallMacosInput {
  dependencies: ServiceDependencies;
  plistPath: string;
  installed: InstalledService;
  expectedInstallDirectory: string;
}

async function uninstallMacosService(
  input: UninstallMacosInput,
): Promise<number> {
  const { dependencies, plistPath, installed, expectedInstallDirectory } =
    input;
  if (installed.installDirectory !== expectedInstallDirectory) {
    dependencies.writeStderr(
      `拒絕移除非預期的安裝目錄：${installed.installDirectory}`,
    );
    return 1;
  }
  try {
    await assertSafeInstalledDirectory(
      installed.installDirectory,
      dependencies.home,
    );
  } catch (error) {
    dependencies.writeStderr(describeError(error));
    return 1;
  }
  const stopped = await dependencies.runCommand("launchctl", [
    "bootout",
    `gui/${String(dependencies.uid)}`,
    plistPath,
  ]);
  if (stopped.exitCode !== 0 && stopped.exitCode !== 3) {
    dependencies.writeStderr(
      `launchctl bootout 失敗：${stopped.stderr || stopped.stdout}`,
    );
    return 1;
  }
  try {
    await assertSafeInstalledDirectory(
      installed.installDirectory,
      dependencies.home,
    );
    await rm(plistPath, { force: true });
    await dependencies.removeDirectory(installed.installDirectory);
    const path = wrapperPath(dependencies.home);
    const wrapper = await readOptionalFile(path);
    if (wrapper === undefined) {
      // No wrapper is also a successful uninstall.
    } else if (isAgentPortWrapper(wrapper)) {
      await rm(path, { force: true });
    } else {
      dependencies.writeStdout(`包裝指令不含 AgentPort 標記，不刪除：${path}`);
    }
  } catch (error) {
    dependencies.writeStderr(`無法移除服務：${describeError(error)}`);
    return 1;
  }
  dependencies.writeStdout(
    "AgentPort 服務已移除；設定、env、資料庫與 log 已保留。",
  );
  return 0;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function reportConfigErrors(
  errors: { path: string; message: string }[],
  dependencies: Pick<ServiceDependencies, "writeStderr">,
): void {
  for (const error of errors) {
    dependencies.writeStderr(`${error.path}: ${error.message}`);
  }
}

type ParsedInstallArgs =
  { ok: true; configPath: string | undefined; dryRun: boolean } | { ok: false };

function parseInstallArgs(args: string[]): ParsedInstallArgs {
  let configPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run" && !dryRun) {
      dryRun = true;
      continue;
    }
    if (arg === "--config") {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false };
      }
      configPath = value;
      index += 1;
      continue;
    }
    return { ok: false };
  }
  return { ok: true, configPath, dryRun };
}

interface MacosInstallInput {
  dependencies: ServiceDependencies;
  installDirectory: string;
  plistPath: string;
  plist: string;
  listen: string;
}

async function installMacos(input: MacosInstallInput): Promise<number> {
  const { dependencies, installDirectory, plistPath, plist, listen } = input;
  const newDirectory = `${installDirectory}.new`;
  const logsDirectory = join(dependencies.home, "Library", "Logs", "agentport");
  const hadPreviousPlist = existsSync(plistPath);
  let previousPlist: string | undefined;
  if (hadPreviousPlist) {
    try {
      previousPlist = await readFile(plistPath, "utf8");
    } catch (error) {
      dependencies.writeStderr(`無法讀取既有 plist：${describeError(error)}`);
      return 1;
    }
  }

  try {
    await rm(newDirectory, { recursive: true, force: true });
    await mkdir(dirname(installDirectory), { recursive: true });
    await dependencies.copyDirectory(dependencies.programRoot, newDirectory);
  } catch (error) {
    dependencies.writeStderr(
      `無法複製程式到 ${newDirectory}：${describeError(error)}`,
    );
    return 1;
  }

  let wasLoaded = false;
  if (hadPreviousPlist) {
    const bootout = await dependencies.runCommand("launchctl", [
      "bootout",
      `gui/${String(dependencies.uid)}`,
      plistPath,
    ]);
    if (bootout.exitCode === 0) {
      wasLoaded = true;
    } else if (bootout.exitCode !== 3) {
      dependencies.writeStderr(
        `launchctl bootout 失敗：${bootout.stderr || bootout.stdout}`,
      );
      return 1;
    }
  }

  let replacement: DirectoryReplacement | undefined;
  try {
    replacement = await replaceInstalledDirectory(
      installDirectory,
      newDirectory,
      dependencies,
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await mkdir(logsDirectory, { recursive: true });
    await dependencies.writeFile(plistPath, plist);
  } catch (error) {
    await rollbackInstallation({
      dependencies,
      installDirectory,
      plistPath,
      previousPlist,
      wasLoaded,
      replacement,
    });
    dependencies.writeStderr(`無法完成安裝：${describeError(error)}`);
    return 1;
  }

  const bootstrap = await dependencies.runCommand("launchctl", [
    "bootstrap",
    `gui/${String(dependencies.uid)}`,
    plistPath,
  ]);
  if (bootstrap.exitCode !== 0) {
    await rollbackInstallation({
      dependencies,
      installDirectory,
      plistPath,
      previousPlist,
      wasLoaded,
      replacement,
    });
    dependencies.writeStderr(
      `launchctl bootstrap 失敗：${bootstrap.stderr || bootstrap.stdout}`,
    );
    return 1;
  }

  try {
    await discardPreviousDirectory(replacement, dependencies);
  } catch (error) {
    dependencies.writeStderr(
      `無法清理舊版程式，保留新版本與殘留舊檔：${describeError(error)}`,
    );
    return 1;
  }

  if (await waitForListening(listen, dependencies)) {
    dependencies.writeStdout(`服務正在監聽 ${listen}`);
    return 0;
  }

  dependencies.writeStderr(`服務未在 10 秒內開始監聽 ${listen}`);
  const tail = await readErrorLogTail(join(logsDirectory, "agentport.err.log"));
  if (tail) {
    dependencies.writeStderr(tail);
  }
  return 1;
}

interface DirectoryReplacement {
  oldDirectory: string | undefined;
}

async function replaceInstalledDirectory(
  installDirectory: string,
  newDirectory: string,
  dependencies: ServiceDependencies,
): Promise<DirectoryReplacement> {
  if (!existsSync(installDirectory)) {
    await dependencies.moveDirectory(newDirectory, installDirectory);
    return { oldDirectory: undefined };
  }

  const oldDirectory = `${installDirectory}.old`;
  await rm(oldDirectory, { recursive: true, force: true });
  await dependencies.moveDirectory(installDirectory, oldDirectory);
  try {
    await dependencies.moveDirectory(newDirectory, installDirectory);
  } catch (error) {
    await rename(oldDirectory, installDirectory);
    throw error;
  }
  return { oldDirectory };
}

async function discardPreviousDirectory(
  replacement: DirectoryReplacement,
  dependencies: ServiceDependencies,
): Promise<void> {
  if (replacement.oldDirectory !== undefined) {
    await dependencies.removeDirectory(replacement.oldDirectory);
  }
}

interface RollbackInput {
  dependencies: ServiceDependencies;
  installDirectory: string;
  plistPath: string;
  previousPlist: string | undefined;
  wasLoaded: boolean;
  replacement: DirectoryReplacement | undefined;
}

async function rollbackInstallation(input: RollbackInput): Promise<void> {
  const {
    dependencies,
    installDirectory,
    plistPath,
    previousPlist,
    wasLoaded,
    replacement,
  } = input;
  try {
    if (replacement !== undefined) {
      await rm(installDirectory, { recursive: true, force: true });
      if (replacement.oldDirectory !== undefined) {
        await rename(replacement.oldDirectory, installDirectory);
      }
    }
    if (previousPlist === undefined) {
      await rm(plistPath, { force: true });
    } else {
      await writeFileOnDisk(plistPath, previousPlist, "utf8");
    }
    if (wasLoaded) {
      const restored = await dependencies.runCommand("launchctl", [
        "bootstrap",
        `gui/${String(dependencies.uid)}`,
        plistPath,
      ]);
      if (restored.exitCode !== 0) {
        dependencies.writeStderr(
          `復原既有服務重新載入失敗：${restored.stderr || restored.stdout}`,
        );
      }
    }
  } catch (error) {
    dependencies.writeStderr(`復原既有服務失敗：${describeError(error)}`);
  }
}

async function waitForListening(
  listen: string,
  dependencies: ServiceDependencies,
): Promise<boolean> {
  const deadline = dependencies.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await dependencies.probePort(listen)) {
      return true;
    }
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) {
      return false;
    }
    await dependencies.sleep(Math.min(READY_RETRY_MS, remaining));
  }
}

async function readErrorLogTail(path: string): Promise<string> {
  try {
    const lines = (await readFile(path, "utf8")).trimEnd().split(/\r?\n/);
    return lines.slice(-ERROR_LOG_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

function probeTcpPort(listen: string): Promise<boolean> {
  const { host, port } = parseListen(listen);
  const connectHost = host === "[::1]" ? "::1" : host;
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: connectHost, port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(connected);
    };
    const timeout = setTimeout(() => {
      finish(false);
    }, READY_RETRY_MS);
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MacosLaunchAgentOptions {
  home: string;
  user: string;
  nodePath: string;
  cliPath: string;
  configPath: string;
  envPath: string;
}

/** macOS 服務定義唯一來源；所有動態字串皆經 XML escaping。 */
export function renderMacosLaunchAgent(
  options: MacosLaunchAgentOptions,
): string {
  const programArguments = [
    options.nodePath,
    `--env-file=${options.envPath}`,
    options.cliPath,
    "serve",
    "--config",
    options.configPath,
  ]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const path = `${join(options.home, ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const logsDirectory = join(options.home, "Library", "Logs", "agentport");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(options.home)}</string>
    <key>USER</key>
    <string>${escapeXml(options.user)}</string>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logsDirectory, "agentport.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logsDirectory, "agentport.err.log"))}</string>
</dict>
</plist>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
