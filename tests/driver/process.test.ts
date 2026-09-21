import { describe, expect, it } from "vitest";

import { spawnLines } from "../../src/driver/process.js";

const node = process.execPath;

describe("spawnLines", () => {
  it("yields stdout line by line and resolves the exit code", async () => {
    const proc = spawnLines({
      command: node,
      args: [
        "-e",
        "console.log('a'); console.error('warn'); console.log('b'); process.exit(3)",
      ],
      cwd: process.cwd(),
      env: process.env,
    });
    const seen: string[] = [];
    for await (const line of proc.lines) seen.push(line);
    expect(seen).toEqual(["a", "b"]);
    expect(await proc.exit).toEqual({ code: 3, signal: null });
    expect(proc.stderr()).toContain("warn");
  });

  it("rejects exit when the command does not exist", async () => {
    const proc = spawnLines({
      command: "/nonexistent/binary",
      args: [],
      cwd: process.cwd(),
      env: process.env,
    });
    await expect(proc.exit).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kill() terminates a long-running child", async () => {
    const proc = spawnLines({
      command: node,
      args: ["-e", "console.log('up'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
    });
    const iterator = proc.lines[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("up");
    proc.kill();
    expect((await proc.exit).signal).toBe("SIGTERM");
  });
});
