// 把建置好的正式套件部署到指定目錄：只含建置產物與 production 依賴。
//
// 直接在這個 checkout 跑 pnpm deploy --prod，pnpm 會把 checkout 的
// node_modules 安裝狀態改記成 production-only，下一次 pnpm run 的執行前檢查
// 就依此移除 devDependencies。因此改從 pnpm pack 出的暫存副本部署：pack 與
// deploy 採用同一份 files 規則，部署內容不變，而 checkout 的 node_modules
// 完全不會被碰到，即使部署中途被中斷也一樣。
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { copyFile, readdir, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// 正在執行的子行程，各帶一個在它本身結束（exit，不等 stdio 關閉）時兌現的
// promise：衍生的行程若仍握著管線，close 可能永遠不會來。
const running = new Set();
let interrupted = false;

// 寫入暫存目錄的步驟（pack、tar）輸出不顯示，以 detached 啟動、各自成為
// 行程群組的首領，中斷時才能把它再衍生的行程一併終止；execFile 不接受
// detached，因此自行收集輸出，失敗時帶上與 execFile 相同的 cmd、stdout、
// stderr 欄位。
// 繼承輸出的 pnpm deploy 則照舊留在本行程的群組：CI 或 timeout 對整個群組
// 送 SIGKILL 時它會一起結束，也保有控制終端機；失敗時與原本的 spawn 一樣
// 直接回報錯誤，中斷時只對它本身轉送訊號。
// 中斷後子行程的結果一律不回報：由訊號處理器清理並結束行程。
function run(command, args, cwd, { inherit = false } = {}) {
  const cmd = [command, ...args].join(" ");
  return new Promise((resolvePromise, reject) => {
    if (interrupted) return;
    const child = spawn(command, args, {
      cwd,
      detached: !inherit,
      stdio: inherit ? "inherit" : "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const entry = {
      child,
      ownGroup: !inherit,
      exited: new Promise((resolveExited) => {
        child.once("exit", resolveExited);
        child.once("error", resolveExited);
      }),
    };
    running.add(entry);
    const settle = (outcome) => {
      running.delete(entry);
      if (!interrupted) outcome();
    };
    child.once("error", (error) =>
      settle(() =>
        reject(inherit ? error : Object.assign(error, { cmd, stdout, stderr })),
      ),
    );
    child.once("close", (code) =>
      settle(() => {
        if (code === 0) resolvePromise();
        else if (inherit)
          reject(new Error(`${command} exited with code ${code ?? 1}`));
        else
          reject(
            Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
              cmd,
              stdout,
              stderr,
            }),
          );
      }),
    );
  });
}

function signalChildren(entries, signal) {
  for (const { child, ownGroup } of entries) {
    // 沒有 pid 表示沒能啟動，只會收到 error 事件。
    if (child.pid === undefined) continue;
    // 留在本行程群組的子行程只對它本身送訊號；已結束時 kill 不做任何事。
    if (!ownGroup) {
      child.kill(signal);
      continue;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // ESRCH：群組已經全部結束。其他錯誤記下來，清理照常進行。
      if (error.code !== "ESRCH")
        console.error(
          `無法對行程群組 ${child.pid} 送出 ${signal}：${error.message}`,
        );
    }
  }
}

const [target] = process.argv.slice(2);
if (!target) {
  console.error("用法：node scripts/deploy-package.mjs <目標目錄>");
  process.exit(1);
}

// 被 SIGINT／SIGTERM／SIGHUP 中斷時：把訊號轉給每個子行程並等它們結束，
// 否則仍在跑的 pnpm pack 會在清理後重新建立暫存目錄；接著清掉暫存目錄，以
// 128 + 訊號編號結束。pack 與 tar 自成 session、不會收到終端機關閉的
// SIGHUP，因此 SIGHUP 也要由這裡轉送。
// 子行程 5 秒內沒結束，或清理中又收到訊號，就改送 SIGKILL；無論如何最後都
// 補一次 SIGKILL，收掉 pack、tar 群組裡首領結束後仍忽略訊號留下的行程。
// 先掛上處理器再同步建立目錄：處理器只在同步程式碼之間執行，因此不會有
// 目錄已建立、卻還沒有處理器負責清理的空窗。
const KILL_GRACE_MS = 5_000;
let stagingDirectory;
let escalate;
async function interrupt(signal) {
  if (interrupted) {
    escalate();
    return;
  }
  interrupted = true;
  const entries = [...running];
  signalChildren(entries, signal);
  const allExited = Promise.all(entries.map(({ exited }) => exited));
  let timer;
  await Promise.race([
    allExited,
    new Promise((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, KILL_GRACE_MS);
    }),
    new Promise((resolveEscalation) => {
      escalate = resolveEscalation;
    }),
  ]);
  clearTimeout(timer);
  signalChildren(entries, "SIGKILL");
  await allExited;
  if (stagingDirectory)
    await rm(stagingDirectory, { recursive: true, force: true });
  process.exit(128 + constants.signals[signal]);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, interrupt);
stagingDirectory = mkdtempSync(join(tmpdir(), "agentport-stage-"));
try {
  await run(
    "pnpm",
    ["pack", "--pack-destination", stagingDirectory],
    projectRoot,
  );
  const [tarball] = await readdir(stagingDirectory);
  await run("tar", ["-xzf", tarball], stagingDirectory);
  const packedProject = join(stagingDirectory, "package");
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"])
    await copyFile(join(projectRoot, file), join(packedProject, file));
  await run(
    "pnpm",
    ["deploy", "--legacy", "--prod", resolve(target)],
    packedProject,
    { inherit: true },
  );
} catch (error) {
  // pack 與 tar 的輸出平常不顯示；失敗時把兩個串流都印出，pnpm 的錯誤細節
  // 可能寫在任一邊。execFile 的 message 已含 stderr，因此只取指令本身。
  const details =
    error instanceof Error && "cmd" in error
      ? [`Command failed: ${error.cmd}`, error.stdout, error.stderr]
      : [error instanceof Error ? error.message : String(error)];
  console.error(details.filter(Boolean).join("\n"));
  process.exitCode = 1;
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
