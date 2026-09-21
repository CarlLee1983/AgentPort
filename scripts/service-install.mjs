import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function runRequired(command, args) {
  const exitCode = await run(command, args);
  if (exitCode !== 0)
    throw new Error(`${command} exited with code ${exitCode}`);
}

const packageDirectory = await mkdtemp(join(tmpdir(), "agentport-service-"));
const serviceArgs = process.argv.slice(2);
if (serviceArgs[0] === "--") serviceArgs.shift();

try {
  await runRequired("pnpm", ["run", "build"]);
  await runRequired("pnpm", ["deploy", "--legacy", "--prod", packageDirectory]);
  process.exitCode = await run(process.execPath, [
    join(packageDirectory, "dist", "cli.js"),
    "service",
    "install",
    ...serviceArgs,
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(packageDirectory, { recursive: true, force: true });
}
