// 把建置好的正式套件部署到指定目錄：只含建置產物與 production 依賴。
//
// 直接在這個 checkout 跑 pnpm deploy --prod，pnpm 會把 checkout 的
// node_modules 安裝狀態改記成 production-only，下一次 pnpm run 的執行前檢查
// 就依此移除 devDependencies。因此改從 pnpm pack 出的暫存副本部署：pack 與
// deploy 採用同一份 files 規則，部署內容不變，而 checkout 的 node_modules
// 完全不會被碰到，即使部署中途被中斷也一樣。
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function runInherited(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}

const [target] = process.argv.slice(2);
if (!target) {
  console.error("用法：node scripts/deploy-package.mjs <目標目錄>");
  process.exit(1);
}

const stagingDirectory = await mkdtemp(join(tmpdir(), "agentport-stage-"));
try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", stagingDirectory], {
    cwd: projectRoot,
  });
  const [tarball] = await readdir(stagingDirectory);
  await execFileAsync("tar", ["-xzf", tarball], { cwd: stagingDirectory });
  const packedProject = join(stagingDirectory, "package");
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"])
    await copyFile(join(projectRoot, file), join(packedProject, file));
  await runInherited(
    "pnpm",
    ["deploy", "--legacy", "--prod", resolve(target)],
    packedProject,
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
