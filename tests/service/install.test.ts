import { spawnSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
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
    runCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    probePort: () => true,
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

describe("service install --dry-run (macOS)", () => {
  it("印出 LaunchAgent plist 與 launchctl 指令，且不建立 HOME 下任何檔案", async () => {
    const home = await makeTempDir();
    const configPath = await validConfig(home);
    const output: string[] = [];

    const exitCode = runService(
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

    const exitCode = runService(
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

    const exitCode = runService(
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

    const exitCode = runService(
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

      const exitCode = runService(
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
