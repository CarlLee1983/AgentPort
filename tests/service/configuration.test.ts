import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareConfiguration } from "../../src/service/configuration.js";
import {
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
} from "../config/helpers.js";

afterEach(cleanupTempDirs);

async function writeValidConfig(dir: string, callers: string): Promise<string> {
  await makeWorkspace(dir, "workspace");
  await makeFakeExecutable(dir, "claude");
  const configPath = join(dir, "nested", "agentport.toml");
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(
    configPath,
    `[[agents]]\nname = "stationhub"\nworkspace = "../workspace"\nruntime = "claude"\npolicy = "workspace-write"\n\n${callers}`,
    "utf8",
  );
  return configPath;
}

describe("prepareConfiguration", () => {
  it("creates a commented skeleton when the config is missing and stops", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "new", "agentport.toml");

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "must-not-be-used",
    });

    expect(result).toEqual({ kind: "needs-configuration", configPath });
    const skeleton = await readFile(configPath, "utf8");
    expect(skeleton).toContain("# [server]");
    expect(skeleton).toContain("# [storage]");
    expect(skeleton).toContain("# [[agents]]");
    expect(skeleton).toContain('token_env = "AGENTPORT_TOKEN_DEFAULT"');
    await expect(
      readFile(join(dir, "new", "agentport.env"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "AGENTPORT_CONFIG",
      (dir: string) => join(dir, "explicit", "agentport.toml"),
    ],
    [
      "XDG_CONFIG_HOME default",
      (dir: string) => join(dir, "xdg", "agentport", "agentport.toml"),
    ],
  ])("creates a skeleton at the supplied %s path", async (_source, pathFor) => {
    const dir = await makeTempDir();
    const configPath = pathFor(dir);

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "must-not-be-used",
    });

    expect(result).toEqual({ kind: "needs-configuration", configPath });
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      "AgentPort service configuration",
    );
    await expect(
      readFile(join(dirname(configPath), "agentport.env"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("dry-run does not create a missing skeleton", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "new", "agentport.toml");

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "must-not-be-used",
      dryRun: true,
    });

    expect(result).toEqual({ kind: "needs-configuration", configPath });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves an invalid existing config byte-for-byte unchanged", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "agentport.toml");
    const contents = "not valid = [";
    await writeFile(configPath, contents, "utf8");

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "must-not-be-written",
    });

    expect(result.kind).toBe("invalid-configuration");
    expect(await readFile(configPath, "utf8")).toBe(contents);
    await expect(
      readFile(join(dir, "agentport.env"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a 0600 env file with one generated token per caller", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "first"\ntoken_env = "AGENTPORT_TOKEN_FIRST"\n\n[[callers]]\nname = "second"\ntoken_env = "AGENTPORT_TOKEN_SECOND"\n',
    );
    const tokens = ["first-token", "second-token"];

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => tokens.shift() ?? "unexpected-token",
    });

    expect(result).toMatchObject({
      kind: "configured",
      createdTokens: [
        {
          callerName: "first",
          tokenEnv: "AGENTPORT_TOKEN_FIRST",
          value: "first-token",
        },
        {
          callerName: "second",
          tokenEnv: "AGENTPORT_TOKEN_SECOND",
          value: "second-token",
        },
      ],
    });
    const envPath = join(dir, "nested", "agentport.env");
    expect(await readFile(envPath, "utf8")).toBe(
      "AGENTPORT_TOKEN_FIRST=first-token\nAGENTPORT_TOKEN_SECOND=second-token\n",
    );
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("creates only missing caller tokens, preserves an existing env value, and tightens permissions", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "kept"\ntoken_env = "AGENTPORT_TOKEN_KEEP"\n\n[[callers]]\nname = "new"\ntoken_env = "AGENTPORT_TOKEN_NEW"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");
    await writeFile(envPath, "AGENTPORT_TOKEN_KEEP=keep-me\n", "utf8");
    await chmod(envPath, 0o644);

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "fresh-token",
    });

    expect(result).toMatchObject({
      kind: "configured",
      configPath,
      envPath,
      envPermissionTightened: true,
      createdTokens: [
        {
          callerName: "new",
          tokenEnv: "AGENTPORT_TOKEN_NEW",
          value: "fresh-token",
        },
      ],
    });
    expect(await readFile(envPath, "utf8")).toBe(
      "AGENTPORT_TOKEN_KEEP=keep-me\nAGENTPORT_TOKEN_NEW=fresh-token\n",
    );
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("atomically replaces a broad env file with a 0600 credential file", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");
    await writeFile(envPath, "# existing\n", "utf8");
    await chmod(envPath, 0o644);
    const originalInode = (await stat(envPath)).ino;

    await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "fresh-token",
    });

    expect((await stat(envPath)).ino).not.toBe(originalInode);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink env target before generating or writing a token", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");
    const targetPath = join(dir, "outside.env");
    await writeFile(targetPath, "keep-this\n", "utf8");
    await symlink(targetPath, envPath);
    const generateToken = vi.fn(() => "must-not-be-generated");

    await expect(
      prepareConfiguration({
        configPath,
        env: baseEnv({ HOME: dir, PATH: dir }),
        generateToken,
      }),
    ).rejects.toThrow("env 檔必須是一般檔案");
    expect(generateToken).not.toHaveBeenCalled();
    expect(await readFile(targetPath, "utf8")).toBe("keep-this\n");
  });

  it("preserves an existing env file when secure replacement cannot be written", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");
    const original = "# keep exactly\n";
    await writeFile(envPath, original, "utf8");
    await chmod(dirname(envPath), 0o500);

    try {
      await expect(
        prepareConfiguration({
          configPath,
          env: baseEnv({ HOME: dir, PATH: dir }),
          generateToken: () => "not-persisted",
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(dirname(envPath), 0o700);
    }
    expect(await readFile(envPath, "utf8")).toBe(original);
  });

  it("does not rewrite an env file or return tokens when every caller token exists", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");
    const contents = "# kept exactly\nAGENTPORT_TOKEN_DEFAULT=keep-me";
    await writeFile(envPath, contents, "utf8");
    await chmod(envPath, 0o600);

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "must-not-be-used",
    });

    expect(result).toMatchObject({
      kind: "configured",
      createdTokens: [],
      envPermissionTightened: false,
    });
    expect(await readFile(envPath, "utf8")).toBe(contents);
  });

  it("atomically tightens a broad existing env even when every caller token exists", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");
    const contents = "AGENTPORT_TOKEN_DEFAULT=keep-me\n";
    await writeFile(envPath, contents, "utf8");
    await chmod(envPath, 0o644);
    const originalInode = (await stat(envPath)).ino;

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "must-not-be-used",
    });

    expect(result).toMatchObject({
      kind: "configured",
      createdTokens: [],
      envPermissionTightened: true,
    });
    expect(await readFile(envPath, "utf8")).toBe(contents);
    expect((await stat(envPath)).ino).not.toBe(originalInode);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it.each([0o700, 0o400])(
    "normalizes existing env mode %o to 0600 without generating a token",
    async (initialMode) => {
      const dir = await makeTempDir();
      const configPath = await writeValidConfig(
        dir,
        '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
      );
      const envPath = join(dir, "nested", "agentport.env");
      await writeFile(envPath, "AGENTPORT_TOKEN_DEFAULT=keep-me\n", "utf8");
      await chmod(envPath, initialMode);
      const generateToken = vi.fn(() => "must-not-be-used");

      const result = await prepareConfiguration({
        configPath,
        env: baseEnv({ HOME: dir, PATH: dir }),
        generateToken,
      });

      expect(result).toMatchObject({
        kind: "configured",
        createdTokens: [],
        envPermissionTightened: true,
      });
      expect(generateToken).not.toHaveBeenCalled();
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    },
  );

  it("dry-run validates planned tokens without creating an env file", async () => {
    const dir = await makeTempDir();
    const configPath = await writeValidConfig(
      dir,
      '[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n',
    );
    const envPath = join(dir, "nested", "agentport.env");

    const result = await prepareConfiguration({
      configPath,
      env: baseEnv({ HOME: dir, PATH: dir }),
      generateToken: () => "planned-token",
      dryRun: true,
    });

    expect(result).toMatchObject({ kind: "configured", createdTokens: [] });
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
