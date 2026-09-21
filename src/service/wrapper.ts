import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A complete line which identifies wrappers managed by AgentPort. */
export const WRAPPER_MARKER = "# AgentPort wrapper";

export interface WrapperOptions {
  home: string;
  nodePath: string;
  cliPath: string;
}

export interface WrapperFileSystem {
  readFile(path: string): Promise<string | undefined>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** The user-local executable path used by the service installer. */
export function wrapperPath(home: string): string {
  return join(home, ".local", "bin", "agentport");
}

/**
 * Render a POSIX shell entrypoint which does not depend on the caller's PATH.
 * Shell single quotes also preserve spaces and any literal shell metacharacters
 * in the fixed executable paths.
 */
export function renderWrapper(options: WrapperOptions): string {
  return `#!/bin/sh\n${WRAPPER_MARKER}\nexec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} "$@"\n`;
}

/** True only when the marker occurs as its own complete line. */
export function isAgentPortWrapper(contents: string): boolean {
  return contents.split(/\r?\n/).includes(WRAPPER_MARKER);
}

/**
 * Write or update the managed wrapper. A non-AgentPort target is never
 * modified, including its permissions.
 */
export async function installWrapper(
  options: WrapperOptions,
  fileSystem: WrapperFileSystem = processWrapperFileSystem,
): Promise<{ path: string; contents: string }> {
  const path = await assertWrapperCanBeInstalled(options.home, fileSystem);

  const contents = renderWrapper(options);
  await fileSystem.mkdir(join(options.home, ".local", "bin"));
  await fileSystem.writeFile(path, contents);
  await fileSystem.chmod(path, 0o755);
  return { path, contents };
}

/** Verify that an install will not replace a user-owned command, without writing. */
export async function assertWrapperCanBeInstalled(
  home: string,
  fileSystem: Pick<WrapperFileSystem, "readFile"> = processWrapperFileSystem,
): Promise<string> {
  const path = wrapperPath(home);
  const existing = await fileSystem.readFile(path);
  if (existing !== undefined && !isAgentPortWrapper(existing)) {
    throw new Error(`拒絕覆寫非 AgentPort 包裝指令：${path}`);
  }
  return path;
}

const processWrapperFileSystem: WrapperFileSystem = {
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
  chmod,
};

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
