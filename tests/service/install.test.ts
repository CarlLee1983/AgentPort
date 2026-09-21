import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runService,
  type ServiceDependencies,
} from "../../src/service/index.js";
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
});
