import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runService,
  type ServiceDependencies,
} from "../../src/service/index.js";
import { WRAPPER_MARKER, wrapperPath } from "../../src/service/wrapper.js";
import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "../config/helpers.js";

afterEach(cleanupTempDirs);

function serviceDependencies(
  home: string,
  overrides: Partial<ServiceDependencies> = {},
): ServiceDependencies {
  return {
    platform: "darwin",
    home,
    user: "agentport-test",
    uid: 501,
    nodePath: "/Users/x/Library/Application Support/node",
    programRoot: "/tmp/agentport-package",
    env: baseEnv({ HOME: home, PATH: home }),
    runCommand: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    probePort: () => Promise.resolve(true),
    copyDirectory: (source, destination) =>
      cp(source, destination, { recursive: true, force: true }),
    writeFile: (path, contents) => writeFile(path, contents, "utf8"),
    moveDirectory: (source, destination) => rename(source, destination),
    removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    generateToken: () => "fixed-token",
    writeStdout: () => {},
    writeStderr: () => {},
    ...overrides,
  };
}

async function validConfig(home: string): Promise<string> {
  await makeWorkspace(home, "workspace");
  await makeFakeExecutable(home, "claude");
  return writeConfigFile(home, agentToml());
}

async function validConfigWithCallers(
  home: string,
  callers: string,
): Promise<string> {
  const configPath = await validConfig(home);
  await writeFile(
    configPath,
    `${await readFile(configPath, "utf8")}\n${callers}`,
    "utf8",
  );
  return configPath;
}

async function makeProgramRoot(dir: string, contents: string): Promise<string> {
  const root = join(dir, "program");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "version.txt"), contents, "utf8");
  await writeFile(join(root, "nested", "kept.txt"), "kept", "utf8");
  return root;
}

async function snapshotTree(path: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(current: string, relativePath: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      const entryRelativePath = join(relativePath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath, entryRelativePath);
      } else {
        snapshot[entryRelativePath] = await readFile(entryPath, "utf8");
      }
    }
  }
  await visit(path, "");
  return snapshot;
}

describe("service install --dry-run (macOS)", () => {
  it("印出 LaunchAgent plist 與 launchctl 指令，且不建立 HOME 下任何檔案", async () => {
    const home = await makeTempDir();
    const configPath = await validConfig(home);
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--dry-run", "--config", relative(process.cwd(), configPath)],
      serviceDependencies(home, {
        writeStdout: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(0);
    const rendered = output.join("\n");
    const installCli = join(home, ".local/share/agentport/app/dist/cli.js");
    const envFile = join(home, "agentport.env");
    expect(rendered).toContain("com.agentport.serve");
    expect(rendered).toContain(
      [
        "  <array>",
        `      <string>${serviceDependencies(home).nodePath}</string>`,
        `      <string>--env-file=${envFile}</string>`,
        `      <string>${installCli}</string>`,
        "      <string>serve</string>",
        "      <string>--config</string>",
        `      <string>${configPath}</string>`,
        "  </array>",
      ].join("\n"),
    );
    expect(rendered).toContain(
      `launchctl bootstrap gui/501 ${join(home, "Library/LaunchAgents/com.agentport.serve.plist")}`,
    );
    expect(rendered).toContain(WRAPPER_MARKER);
    expect(await readdir(home)).toEqual([
      "agentport.toml",
      "claude",
      "workspace",
    ]);
  });

  it("node 路徑有空白時將所有 XML 值正確 escaping", async () => {
    const home = await makeTempDir();
    const configPath = await validConfig(home);
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--config", configPath, "--dry-run"],
      serviceDependencies(home, {
        nodePath: "/Users/x/Library & Support/node",
        writeStdout: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain(
      "<string>/Users/x/Library &amp; Support/node</string>",
    );

    if (process.platform === "darwin") {
      const [plist] = output;
      if (plist === undefined) {
        throw new Error("dry-run 沒有印出 plist");
      }
      const result = spawnSync("plutil", ["-lint", "-"], {
        encoding: "utf8",
        input: plist,
      });
      expect(result.status).toBe(0);
    }
  });

  it("有 caller 但 env 尚未建立時仍印出完整 wrapper，且不建立 token", async () => {
    const home = await makeTempDir();
    const configPath = await validConfigWithCallers(
      home,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--dry-run", "--config", configPath],
      serviceDependencies(home, {
        generateToken: () => "planned-token",
        writeStdout: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain(WRAPPER_MARKER);
    expect(output.join("\n")).not.toContain("planned-token");
    expect(existsSync(join(home, "agentport.env"))).toBe(false);
  });

  it("同時印出結構與語意設定錯誤，且不印 plist", async () => {
    const home = await makeTempDir();
    await mkdir(join(home, "workspace"));
    const configPath = await writeConfigFile(
      home,
      `[[agents]]\nname = "bad name"\nworkspace = "workspace"\nruntime = "claude"\npolicy = "invalid"\n\n[[callers]]\nname = "default"\ntoken_env = ""\n`,
    );
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--dry-run", "--config", configPath],
      serviceDependencies(home, {
        writeStderr: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("agent name 只能包含");
    expect(output.join("\n")).toContain("Invalid option");
    expect(output.join("\n")).not.toContain("<plist");
  });

  it("不支援的平台以非零碼結束", async () => {
    const home = await makeTempDir();
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--dry-run"],
      serviceDependencies(home, {
        platform: "win32",
        writeStderr: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("不支援的平台");
  });

  it.each([[""], ["unknown"]])(
    "%s 印出 service 用法並以 2 結束",
    async (command) => {
      const home = await makeTempDir();
      const output: string[] = [];

      const exitCode = await runService(
        command === "" ? [] : [command],
        serviceDependencies(home, {
          writeStderr: (line) => output.push(line),
        }),
      );

      expect(exitCode).toBe(2);
      expect(output.join("\n")).toContain("usage: agentport service install");
    },
  );
});

describe("service install (macOS)", () => {
  it("設定檔不存在時只建立骨架、提示填好 agent 後重跑，且不碰服務定義", async () => {
    const home = await makeTempDir();
    const configPath = join(home, "config", "agentport.toml");
    const commands: string[] = [];
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        runCommand: (_command, args) => {
          commands.push(args.join(" "));
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
        writeStdout: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(1);
    expect(await readFile(configPath, "utf8")).toContain("# [[agents]]");
    expect(await readFile(configPath, "utf8")).toContain(
      'token_env = "AGENTPORT_TOKEN_DEFAULT"',
    );
    expect(output.join("\n")).toContain(configPath);
    expect(output.join("\n")).toContain("填好 agent 後重跑");
    expect(commands).toEqual([]);
    expect(existsSync(join(home, "Library/LaunchAgents"))).toBe(false);
  });

  it.each([
    {
      name: "AGENTPORT_CONFIG",
      configPath: (home: string) => join(home, "custom", "agentport.toml"),
      env: (home: string) => ({
        HOME: home,
        PATH: home,
        AGENTPORT_CONFIG: join(home, "custom", "agentport.toml"),
      }),
    },
    {
      name: "XDG_CONFIG_HOME",
      configPath: (home: string) =>
        join(home, "xdg", "agentport", "agentport.toml"),
      env: (home: string) => ({
        HOME: home,
        PATH: home,
        XDG_CONFIG_HOME: join(home, "xdg"),
      }),
    },
  ])("未給 --config 時依 $name 建立設定骨架", async ({ configPath, env }) => {
    const home = await makeTempDir();
    const path = configPath(home);
    const commands: string[] = [];

    const exitCode = await runService(
      ["install"],
      serviceDependencies(home, {
        env: baseEnv(env(home)),
        runCommand: (_command, args) => {
          commands.push(args.join(" "));
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      }),
    );

    expect(exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toContain("# [[agents]]");
    expect(commands).toEqual([]);
  });

  it("驗證失敗時不改寫既有設定檔，也不送 launchctl", async () => {
    const home = await makeTempDir();
    const configPath = join(home, "agentport.toml");
    const contents = "not valid = [";
    const commands: string[] = [];
    await writeFile(configPath, contents, "utf8");

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        runCommand: (_command, args) => {
          commands.push(args.join(" "));
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      }),
    );

    expect(exitCode).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe(contents);
    expect(commands).toEqual([]);
  });

  it("只建立缺少的 caller token、以 0600 寫 env，且只在 stdout 顯示新的值", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfigWithCallers(
      home,
      '[[callers]]\nname = "kept"\ntoken_env = "AGENTPORT_TOKEN_KEEP"\n\n[[callers]]\nname = "new"\ntoken_env = "AGENTPORT_TOKEN_NEW"\n',
    );
    const envPath = join(home, "agentport.env");
    const output: string[] = [];
    await writeFile(envPath, "AGENTPORT_TOKEN_KEEP=keep-me\n", "utf8");
    await chmod(envPath, 0o644);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        generateToken: () => "new-token",
        writeStdout: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(0);
    expect(await readFile(envPath, "utf8")).toBe(
      "AGENTPORT_TOKEN_KEEP=keep-me\nAGENTPORT_TOKEN_NEW=new-token\n",
    );
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(output.join("\n")).toContain("AGENTPORT_TOKEN_NEW、new-token");
    expect(output.join("\n")).not.toContain("keep-me");
    expect(output.join("\n")).toContain("權限收緊為 0600");
    const plist = await readFile(
      join(home, "Library/LaunchAgents/com.agentport.serve.plist"),
      "utf8",
    );
    expect(plist).not.toContain("new-token");
  });

  it("env 不存在時為每個 caller 建立 token，且不讓 token 進 plist 或 err log", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfigWithCallers(
      home,
      '[[callers]]\nname = "one"\ntoken_env = "AGENTPORT_TOKEN_ONE"\n\n[[callers]]\nname = "two"\ntoken_env = "AGENTPORT_TOKEN_TWO"\n',
    );
    const output: string[] = [];
    let generated = 0;

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        generateToken: () => `generated-${String(++generated)}`,
        writeStdout: (line) => output.push(line),
      }),
    );

    const envPath = join(home, "agentport.env");
    const plist = await readFile(
      join(home, "Library/LaunchAgents/com.agentport.serve.plist"),
      "utf8",
    );
    expect(exitCode).toBe(0);
    expect(await readFile(envPath, "utf8")).toBe(
      "AGENTPORT_TOKEN_ONE=generated-1\nAGENTPORT_TOKEN_TWO=generated-2\n",
    );
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(output.join("\n")).toContain("AGENTPORT_TOKEN_ONE、generated-1");
    expect(output.join("\n")).toContain("AGENTPORT_TOKEN_TWO、generated-2");
    expect(plist).not.toContain("generated-1");
    expect(plist).not.toContain("generated-2");
    expect(
      existsSync(join(home, "Library/Logs/agentport/agentport.err.log")),
    ).toBe(false);
  });

  it("已存在的所有 token 重跑時不改 env，也不再輸出 token", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfigWithCallers(
      home,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(home, "agentport.env");
    const contents = "AGENTPORT_TOKEN_DEFAULT=keep-me\n";
    const output: string[] = [];
    await writeFile(envPath, contents, "utf8");
    await chmod(envPath, 0o600);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        generateToken: () => "must-not-be-used",
        writeStdout: (line) => output.push(line),
      }),
    );

    expect(exitCode).toBe(0);
    expect(await readFile(envPath, "utf8")).toBe(contents);
    expect(output.join("\n")).not.toContain("新 token");
  });

  it("第一次安裝會複製程式、寫入 plist、bootstrap 並回報監聽位址", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const commands: { command: string; args: string[] }[] = [];
    const output: string[] = [];

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand: (command, args) => {
          commands.push({ command, args });
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
        writeStdout: (line) => output.push(line),
      }),
    );

    const app = join(home, ".local/share/agentport/app");
    const plist = join(home, "Library/LaunchAgents/com.agentport.serve.plist");
    expect(exitCode).toBe(0);
    expect(await snapshotTree(app)).toEqual(await snapshotTree(source));
    expect(await readFile(plist, "utf8")).toContain("com.agentport.serve");
    expect(existsSync(join(home, "Library/Logs/agentport"))).toBe(true);
    expect(commands).toEqual([
      {
        command: "launchctl",
        args: ["bootstrap", "gui/501", plist],
      },
    ]);
    expect(output.join("\n")).toContain("127.0.0.1:3333");
  });

  it("已安裝時先 bootout、以 app.new 換目錄、再 bootstrap", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const commands: { command: string; args: string[] }[] = [];
    let sawNewDirectory = false;
    let trackNewDirectory = false;
    const dependencies = serviceDependencies(home, {
      programRoot: source,
      runCommand: (command, args) => {
        commands.push({ command, args });
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
      copyDirectory: async (from, destination) => {
        await cp(from, destination, { recursive: true, force: true });
        if (trackNewDirectory) {
          sawNewDirectory = existsSync(destination);
        }
      },
    });
    const app = join(home, ".local/share/agentport/app");

    await runService(["install", "--config", configPath], dependencies);
    await writeFile(join(source, "version.txt"), "v2", "utf8");
    commands.splice(0);
    trackNewDirectory = true;

    const exitCode = await runService(
      ["install", "--config", configPath],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(sawNewDirectory).toBe(true);
    expect(commands.map(({ args }) => args[0])).toEqual([
      "bootout",
      "bootstrap",
    ]);
    expect(await readFile(join(app, "version.txt"), "utf8")).toBe("v2");
    expect(existsSync(`${app}.new`)).toBe(false);
    expect(existsSync(`${app}.old`)).toBe(false);
  });

  it("複製 app.new 失敗時不停止既有服務，也不更動原 app", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const commands: { command: string; args: string[] }[] = [];
    const workingDependencies = serviceDependencies(home, {
      programRoot: source,
      runCommand: (command, args) => {
        commands.push({ command, args });
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    });
    await runService(["install", "--config", configPath], workingDependencies);
    await writeFile(join(source, "version.txt"), "v2", "utf8");
    commands.splice(0);
    const errors: string[] = [];

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        copyDirectory: () => Promise.reject(new Error("disk full")),
        runCommand: (command, args) => {
          commands.push({ command, args });
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
        writeStderr: (line) => errors.push(line),
      }),
    );

    expect(exitCode).toBe(1);
    expect(commands).toEqual([]);
    expect(
      await readFile(
        join(home, ".local/share/agentport/app/version.txt"),
        "utf8",
      ),
    ).toBe("v1");
    expect(errors.join("\n")).toContain("disk full");
  });

  it("寫入新 plist 失敗時復原既有 app、plist 並重新載入既有服務", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const commands: string[] = [];
    const runCommand = (_command: string, args: string[]) => {
      commands.push(args[0] ?? "");
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source, runCommand }),
    );
    const app = join(home, ".local/share/agentport/app");
    const plistPath = join(
      home,
      "Library/LaunchAgents/com.agentport.serve.plist",
    );
    const originalPlist = await readFile(plistPath, "utf8");
    await writeFile(join(source, "version.txt"), "v2", "utf8");
    commands.splice(0);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand,
        writeFile: () => Promise.reject(new Error("plist disk full")),
      }),
    );

    expect(exitCode).toBe(1);
    expect(await readFile(join(app, "version.txt"), "utf8")).toBe("v1");
    expect(await readFile(plistPath, "utf8")).toBe(originalPlist);
    expect(commands).toEqual(["bootout", "bootstrap"]);
  });

  it("app.new 換名失敗時保留舊 app 並重新載入既有服務", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const commands: string[] = [];
    const runCommand = (_command: string, args: string[]) => {
      commands.push(args[0] ?? "");
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source, runCommand }),
    );
    await writeFile(join(source, "version.txt"), "v2", "utf8");
    commands.splice(0);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand,
        moveDirectory: (from, destination) => {
          if (from.endsWith(".new")) {
            return Promise.reject(new Error("rename failed"));
          }
          return rename(from, destination);
        },
      }),
    );

    expect(exitCode).toBe(1);
    expect(
      await readFile(
        join(home, ".local/share/agentport/app/version.txt"),
        "utf8",
      ),
    ).toBe("v1");
    expect(commands).toEqual(["bootout", "bootstrap"]);
  });

  it("新服務 bootstrap 與復原 bootstrap 都失敗時明確回報復原失敗", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    let failingInstall = false;
    let bootstrapCount = 0;
    const runCommand = (_command: string, args: string[]) => {
      if (failingInstall && args[0] === "bootstrap") {
        bootstrapCount += 1;
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: `bootstrap failure ${String(bootstrapCount)}`,
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source, runCommand }),
    );
    await writeFile(join(source, "version.txt"), "v2", "utf8");
    failingInstall = true;
    const errors: string[] = [];

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand,
        writeStderr: (line) => errors.push(line),
      }),
    );

    expect(exitCode).toBe(1);
    expect(bootstrapCount).toBe(2);
    expect(errors.join("\n")).toContain("復原既有服務重新載入失敗");
  });

  it("舊版清理失敗時保留已驗證的新服務與 app", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const commands: string[] = [];
    const runCommand = (_command: string, args: string[]) => {
      commands.push(args[0] ?? "");
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source, runCommand }),
    );
    await writeFile(join(source, "version.txt"), "v2", "utf8");
    commands.splice(0);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand,
        removeDirectory: () => Promise.reject(new Error("cleanup failed")),
      }),
    );

    expect(exitCode).toBe(1);
    expect(
      await readFile(
        join(home, ".local/share/agentport/app/version.txt"),
        "utf8",
      ),
    ).toBe("v2");
    expect(existsSync(`${join(home, ".local/share/agentport/app")}.old`)).toBe(
      true,
    );
    expect(commands).toEqual(["bootout", "bootstrap"]);
  });

  it("殘留 plist 的 bootout code 3 不妨礙冪等更新", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source }),
    );
    await writeFile(join(source, "version.txt"), "v2", "utf8");

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand: (_command, args) =>
          Promise.resolve({
            exitCode: args[0] === "bootout" ? 3 : 0,
            stdout: "",
            stderr: "",
          }),
      }),
    );

    expect(exitCode).toBe(0);
    expect(
      await readFile(
        join(home, ".local/share/agentport/app/version.txt"),
        "utf8",
      ),
    ).toBe("v2");
  });

  it("空 XDG_DATA_HOME 和未設定時同樣使用 ~/.local/share", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        env: baseEnv({ HOME: home, PATH: home, XDG_DATA_HOME: "" }),
      }),
    );

    expect(exitCode).toBe(0);
    expect(
      existsSync(join(home, ".local/share/agentport/app/version.txt")),
    ).toBe(true);
  });

  it("逾時時印出 err log 尾端、保留已載入服務且不自動 bootout", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const logs = join(home, "Library/Logs/agentport");
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, "agentport.err.log"),
      Array.from(
        { length: 25 },
        (_, index) => `line-${String(index + 1)}`,
      ).join("\n"),
      "utf8",
    );
    const commands: { command: string; args: string[] }[] = [];
    const errors: string[] = [];
    let clock = 0;

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand: (command, args) => {
          commands.push({ command, args });
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
        probePort: () => Promise.resolve(false),
        now: () => clock,
        sleep: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        writeStderr: (line) => errors.push(line),
      }),
    );

    expect(exitCode).toBe(1);
    expect(commands.map(({ args }) => args[0])).toEqual(["bootstrap"]);
    expect(errors.join("\n")).toContain("line-25");
    expect(errors.join("\n")).not.toContain("line-1\n");
  });

  it("連續兩次成功安裝後 HOME 內檔案與內容相同", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const dependencies = serviceDependencies(home, { programRoot: source });

    expect(
      await runService(["install", "--config", configPath], dependencies),
    ).toBe(0);
    const afterFirstInstall = await snapshotTree(home);

    expect(
      await runService(["install", "--config", configPath], dependencies),
    ).toBe(0);
    expect(await snapshotTree(home)).toEqual(afterFirstInstall);
  });

  it("安裝的 wrapper 使用固定 node 執行 app CLI，並轉傳 check-config 參數", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const nodePath = join(home, "node with spaces");
    await mkdir(join(source, "dist"));
    await writeFile(
      join(source, "dist", "cli.js"),
      `#!/bin/sh\n[ "$1" = check-config ] && [ "$2" = --config ] && [ "$3" = '${configPath}' ]\n`,
      "utf8",
    );
    await writeFile(
      nodePath,
      '#!/bin/sh\nscript="$1"\nshift\nexec /bin/sh "$script" "$@"\n',
      "utf8",
    );
    await chmod(nodePath, 0o755);

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source, nodePath }),
    );
    const path = wrapperPath(home);
    const result = spawnSync(path, ["check-config", "--config", configPath], {
      encoding: "utf8",
    });

    expect(exitCode).toBe(0);
    expect(result.status).toBe(0);
    expect((await stat(path)).mode & 0o111).toBe(0o111);
    expect(await readFile(path, "utf8")).toContain(WRAPPER_MARKER);
    expect(await readFile(path, "utf8")).toContain(`'${nodePath}'`);
  });

  it("使用者自己的同名 wrapper 會原封不動地拒絕，且不送 launchctl", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const path = wrapperPath(home);
    const contents = "#!/bin/sh\necho mine\n";
    const commands: string[] = [];
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(path, contents, "utf8");

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, {
        programRoot: source,
        runCommand: (_command, args) => {
          commands.push(args.join(" "));
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      }),
    );

    expect(exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toBe(contents);
    expect(commands).toEqual([]);
  });

  it("帶標記的舊 wrapper 會被更新到本次 node 路徑", async () => {
    const home = await makeTempDir();
    const source = await makeProgramRoot(home, "v1");
    const configPath = await validConfig(home);
    const path = wrapperPath(home);
    const nodePath = "/new node";
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(
      path,
      `#!/bin/sh\n${WRAPPER_MARKER}\nexec /old/node\n`,
      "utf8",
    );

    const exitCode = await runService(
      ["install", "--config", configPath],
      serviceDependencies(home, { programRoot: source, nodePath }),
    );

    expect(exitCode).toBe(0);
    expect(await readFile(path, "utf8")).toContain("'/new node'");
    expect(await readFile(path, "utf8")).not.toContain("/old/node");
  });
});
