import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, type TestContext } from "vitest";

import { makeFakeExecutable } from "../config/helpers.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Deploy {
  child: ChildProcess;
  exited: Promise<number | null>;
  root: string;
  temporaryDirectory: string;
}

async function stagingEntries(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.startsWith("agentport-stage-"));
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待的條件未在時限內成立");
    await delay(10);
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * 以 TMPDIR 指向空的暫存目錄執行部署腳本。腳本自成行程群組；測試結束時若它
 * 還在跑，先送 SIGTERM 讓它清理自己的子行程，逾時再強制結束整個群組。
 */
async function startDeploy(
  onTestFinished: TestContext["onTestFinished"],
  root?: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Deploy> {
  const deployRoot =
    root ?? (await mkdtemp(join(tmpdir(), "agentport-signal-")));
  const temporaryDirectory = join(deployRoot, "tmp");
  await mkdir(temporaryDirectory);
  const child = spawn(
    process.execPath,
    ["scripts/deploy-package.mjs", join(deployRoot, "package")],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      env: { ...process.env, TMPDIR: temporaryDirectory, ...env },
      stdio: "ignore",
    },
  );
  const exited = once(child, "exit").then(([code]) => code as number | null);
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, delay(10_000)]);
      killGroup(child.pid);
    }
    await rm(deployRoot, { recursive: true, force: true });
  }, 15_000);
  return { child, exited, root: deployRoot, temporaryDirectory };
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

/**
 * 以假 pnpm 執行部署腳本，等假 pnpm 寫出就緒檔後回傳其內容。就緒檔先寫到
 * .tmp 再改名，讀到時內容必定完整。
 */
async function startDeployWithFakePnpm(
  onTestFinished: TestContext["onTestFinished"],
  script: string[],
): Promise<Deploy & { ready: string; readyFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentport-signal-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await makeFakeExecutable(bin, "pnpm", ["#!/bin/sh", ...script].join("\n"));
  const readyFile = join(root, "pnpm.ready");
  const deploy = await startDeploy(onTestFinished, root, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    READY_FILE: readyFile,
  });
  await waitFor(() => fileExists(readyFile));
  return { ...deploy, ready: await readFile(readyFile, "utf8"), readyFile };
}

/**
 * 放一個忽略 INT／TERM／HUP 的假 pnpm：它把自己的 pid 寫進就緒檔後一直睡，
 * 用來確定腳本在子行程不理會轉送的訊號時仍會結束。
 */
async function startDeployWithStubbornPnpm(
  onTestFinished: TestContext["onTestFinished"],
): Promise<Deploy & { pnpmPid: number }> {
  const deploy = await startDeployWithFakePnpm(onTestFinished, [
    "trap '' INT TERM HUP",
    'echo $$ > "$READY_FILE.tmp"',
    'mv "$READY_FILE.tmp" "$READY_FILE"',
    "exec sleep 60",
    "",
  ]);
  const pnpmPid = Number(deploy.ready);
  // 假 pnpm 自成行程群組，腳本失敗時不會隨腳本的群組一起結束。
  onTestFinished(() => {
    killGroup(pnpmPid);
  });
  return { ...deploy, pnpmPid };
}

/**
 * 假 pnpm 的 pack 產生合法 tarball，deploy 則記下自己的 pid 與行程群組後
 * 等待；收到 SIGTERM 時記下並結束。用來確認 deploy 步驟留在腳本的行程群組，
 * 並收到腳本轉送的訊號。
 */
async function startDeployWithFakeDeploy(
  onTestFinished: TestContext["onTestFinished"],
): Promise<
  Deploy & { pnpmPid: number; pnpmGroup: number; signalFile: string }
> {
  const deploy = await startDeployWithFakePnpm(onTestFinished, [
    'if [ "$1" = pack ]; then',
    '  work=$(mktemp -d); mkdir "$work/package"; echo "{}" > "$work/package/package.json"',
    '  tar -czf "$3/fake.tgz" -C "$work" package; rm -rf "$work"; exit 0',
    "fi",
    "sleep 60 &",
    `trap 'echo TERM > "$READY_FILE.signal"; kill $!; exit 143' TERM`,
    'echo "$$ $(ps -o pgid= -p $$)" > "$READY_FILE.tmp"',
    'mv "$READY_FILE.tmp" "$READY_FILE"',
    "wait",
    "",
  ]);
  const [pnpmPid, pnpmGroup] = deploy.ready.trim().split(/\s+/).map(Number);
  return {
    ...deploy,
    pnpmPid: pnpmPid ?? Number.NaN,
    pnpmGroup: pnpmGroup ?? Number.NaN,
    signalFile: `${deploy.readyFile}.signal`,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.concurrent("deploy-package 被訊號中斷", () => {
  it.for([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)(
    "%s 後清掉暫存目錄並以 %i 結束",
    { timeout: 40_000 },
    async ([signal, exitCode], { onTestFinished }) => {
      const { child, exited, temporaryDirectory } =
        await startDeploy(onTestFinished);

      await waitFor(
        async () => (await stagingEntries(temporaryDirectory)).length > 0,
      );
      child.kill(signal);

      expect(await exited).toBe(exitCode);
      expect(await stagingEntries(temporaryDirectory)).toEqual([]);
      // 子行程若在結束後仍活著（例如 pnpm pack），會晚一步重新建立暫存目錄。
      await delay(15_000);
      expect(await stagingEntries(temporaryDirectory)).toEqual([]);
    },
  );

  it("子行程不理會訊號時，5 秒後強制結束它並照常清理", async ({
    onTestFinished,
  }) => {
    const { child, exited, temporaryDirectory, pnpmPid } =
      await startDeployWithStubbornPnpm(onTestFinished);

    const start = Date.now();
    child.kill("SIGTERM");

    expect(await exited).toBe(143);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4_500);
    expect(isAlive(pnpmPid)).toBe(false);
    expect(await stagingEntries(temporaryDirectory)).toEqual([]);
  }, 20_000);

  it("pnpm deploy 留在腳本的行程群組，並收到轉送的訊號", async ({
    onTestFinished,
  }) => {
    const {
      child,
      exited,
      temporaryDirectory,
      pnpmPid,
      pnpmGroup,
      signalFile,
    } = await startDeployWithFakeDeploy(onTestFinished);

    expect(pnpmGroup).toBe(child.pid);
    child.kill("SIGTERM");

    expect(await exited).toBe(143);
    expect(await readFile(signalFile, "utf8")).toBe("TERM\n");
    expect(isAlive(pnpmPid)).toBe(false);
    expect(await stagingEntries(temporaryDirectory)).toEqual([]);
  }, 20_000);

  it("清理中再收到訊號時，立即強制結束子行程並照常清理", async ({
    onTestFinished,
  }) => {
    const { child, exited, temporaryDirectory, pnpmPid } =
      await startDeployWithStubbornPnpm(onTestFinished);

    const start = Date.now();
    child.kill("SIGTERM");
    await delay(200);
    child.kill("SIGINT");

    expect(await exited).toBe(143);
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(isAlive(pnpmPid)).toBe(false);
    expect(await stagingEntries(temporaryDirectory)).toEqual([]);
  }, 20_000);
});
