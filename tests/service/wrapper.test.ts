import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installWrapper,
  isAgentPortWrapper,
  renderWrapper,
  WRAPPER_MARKER,
  wrapperPath,
} from "../../src/service/wrapper.js";
import { cleanupTempDirs, makeTempDir } from "../config/helpers.js";

afterEach(cleanupTempDirs);

describe("service wrapper", () => {
  it("creates the parent and an executable wrapper which quotes fixed paths and forwards args", async () => {
    const home = await makeTempDir();
    const tools = join(home, "tools with spaces");
    await mkdir(tools);
    const nodePath = join(tools, "fake node");
    const cliPath = join(tools, "fake cli.js");
    const outputPath = join(home, "arguments.txt");
    await writeFile(
      nodePath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${outputPath}'\n`,
      "utf8",
    );
    await chmod(nodePath, 0o755);
    await writeFile(cliPath, "not executed directly\n", "utf8");

    const installed = await installWrapper({ home, nodePath, cliPath });
    const result = spawnSync(
      installed.path,
      ["check-config", "--config", "a path"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe(
      `${cliPath}\ncheck-config\n--config\na path\n`,
    );
    expect((await stat(installed.path)).mode & 0o777).toBe(0o755);
    expect(await readFile(installed.path, "utf8")).toContain(WRAPPER_MARKER);
  });

  it("refuses a foreign target without changing it", async () => {
    const home = await makeTempDir();
    const path = wrapperPath(home);
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(path, "#!/bin/sh\necho personal-tool\n", "utf8");
    await chmod(path, 0o644);

    await expect(
      installWrapper({ home, nodePath: "/new/node", cliPath: "/new/cli.js" }),
    ).rejects.toThrow("拒絕覆寫非 AgentPort");

    expect(await readFile(path, "utf8")).toBe(
      "#!/bin/sh\necho personal-tool\n",
    );
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("replaces an older marked wrapper", async () => {
    const home = await makeTempDir();
    const path = wrapperPath(home);
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(
      path,
      `#!/bin/sh\n${WRAPPER_MARKER}\nexec /old/node\n`,
      "utf8",
    );

    await installWrapper({
      home,
      nodePath: "/new node",
      cliPath: "/new cli.js",
    });

    const contents = await readFile(path, "utf8");
    expect(contents).toContain("'/new node' '/new cli.js' \"$@\"");
    expect(contents).not.toContain("/old/node");
  });

  it("renders for dry-run consumers without writing files", async () => {
    const home = await makeTempDir();
    const rendered = renderWrapper({
      home,
      nodePath: "/node path/node",
      cliPath: "/app path/dist/cli.js",
    });

    expect(rendered).toContain(WRAPPER_MARKER);
    expect(isAgentPortWrapper(rendered)).toBe(true);
    expect(rendered).toContain(
      "'/node path/node' '/app path/dist/cli.js' \"$@\"",
    );
    await expect(stat(join(home, ".local", "bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
