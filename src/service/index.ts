import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { loadConfig } from "../config/load.js";
import { resolveConfigPath, type Env } from "../config/paths.js";

const SERVICE_USAGE =
  "usage: agentport service install --dry-run [--config <path>]";
const LAUNCH_AGENT_LABEL = "com.agentport.serve";

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
  runCommand: (command: string, args: string[]) => CommandResult;
  probePort: (listen: string) => boolean;
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
    programRoot: dirname(resolve(process.argv[1] ?? process.cwd())),
    env: process.env,
    runCommand: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    probePort: () => false,
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
 * 執行 service 子命令。票 01 先落地唯一無副作用的 install dry-run；依賴介面
 * 已涵蓋後續票要用的服務管理器、TCP 探測與 token 來源，避免再開第二個測試 seam。
 */
export function runService(
  args: string[],
  dependencies: ServiceDependencies,
): number {
  const [command, ...rest] = args;
  if (command !== "install") {
    dependencies.writeStderr(SERVICE_USAGE);
    return 2;
  }

  const parsed = parseInstallArgs(rest);
  if (!parsed.ok) {
    dependencies.writeStderr(SERVICE_USAGE);
    return 2;
  }

  if (dependencies.platform !== "darwin") {
    dependencies.writeStderr(`不支援的平台：${dependencies.platform}`);
    return 1;
  }

  // launchd 不會繼承呼叫 install 的 cwd；服務定義中的兩條路徑必須固定為絕對路徑。
  const configPath = resolve(
    resolveConfigPath(parsed.configPath, dependencies.env),
  );
  const result = loadConfig(configPath, dependencies.env);
  if (!result.ok) {
    for (const error of result.errors) {
      dependencies.writeStderr(`${error.path}: ${error.message}`);
    }
    return 1;
  }

  const plistPath = join(
    dependencies.home,
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
  const configDirectory = dirname(configPath);
  const envPath = join(configDirectory, "agentport.env");
  const installDirectory = join(
    dependencies.env.XDG_DATA_HOME ??
      join(dependencies.home, ".local", "share"),
    "agentport",
    "app",
  );
  const plist = renderMacosLaunchAgent({
    home: dependencies.home,
    user: dependencies.user,
    nodePath: dependencies.nodePath,
    cliPath: join(installDirectory, "dist", "cli.js"),
    configPath,
    envPath,
  });

  dependencies.writeStdout(plist);
  dependencies.writeStdout(
    `launchctl bootstrap gui/${String(dependencies.uid)} ${plistPath}`,
  );
  return 0;
}

type ParsedInstallArgs =
  { ok: true; configPath: string | undefined } | { ok: false };

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
  return dryRun ? { ok: true, configPath } : { ok: false };
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
