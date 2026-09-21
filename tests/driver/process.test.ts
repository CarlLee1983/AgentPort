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

  it("kill() 連同 process group 一起殺，讓孫程序也死掉", async () => {
    const proc = spawnLines({
      command: "sh",
      args: ["-c", "sleep 30 & echo $!; wait"],
      cwd: process.cwd(),
      env: process.env,
    });
    const iterator = proc.lines[Symbol.asyncIterator]();
    const grandchildPid = Number((await iterator.next()).value);
    proc.kill();
    await proc.exit;

    // 群組的 SIGTERM 是同時送給 sh 跟 sleep 的，但子程序真的死掉可能比
    // `exit` promise resolve 晚一點點，短暫重試一下再判定。
    const deadline = Date.now() + 1000;
    for (;;) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("grandchild 沒有在群組被殺時一起結束");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it("忽略 SIGTERM 的子程序在 killGraceMs 後被 SIGKILL", async () => {
    const proc = spawnLines({
      command: node,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      env: process.env,
      killGraceMs: 200,
    });
    const iterator = proc.lines[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("up");
    proc.kill();
    expect((await proc.exit).signal).toBe("SIGKILL");
  });

  it("子程序自然結束後才呼叫 kill() 不會對（可能已被回收的）pid 送信號", async () => {
    const proc = spawnLines({
      command: node,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: process.env,
    });
    await proc.exit;
    // 子程序已經結束：kill() 應該直接 return，不拋例外、不對 pid 送信號。
    expect(() => {
      proc.kill();
    }).not.toThrow();
  });
});
