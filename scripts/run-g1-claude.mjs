import { spawnSync } from "node:child_process";

import { createG1ClaudeHarnessEnvironment } from "../dist/src/runtime/claude/auth-policy.js";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error(
    "test:claude must run as root on the designated Linux target; the launcher drops only Runtime workers to the dedicated account",
  );
}

function execute(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: createG1ClaudeHarnessEnvironment(process.env),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const preflight = execute(["scripts/require-g1-claude.mjs"]);
if (preflight !== 0) process.exit(preflight);
process.exit(
  execute([
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/claude/runtime-capabilities.test.ts",
    "tests/claude/runtime-cancellation.test.ts",
    "tests/claude/g4-mcp-interaction.test.ts",
    "tests/linux/runtime-isolation.test.ts",
  ]),
);
