#!/usr/bin/env node
// 測試用假 `codex`：把一份 fixture JSONL 逐行印到 stdout，模擬 codex 子程序輸出，
// 讓 driver.test.ts 能透過 createCodexDriver 真的跑一個子程序來回放，不用 mock 掉它。
//
// 用環境變數而非 argv 控制行為：createCodexDriver 依 buildCodexArgs 產生真實的
// `exec --json --sandbox ... <prompt>` 引數，這份腳本不解析它們，改用環境變數傳
// fixture 路徑、退出碼、stderr 文字（與 tests/fixtures/claude/replay.mjs 同款式）。
import { readFileSync } from "node:fs";

const fixturePath = process.env.AGENTPORT_TEST_FIXTURE;
const exitCode = process.env.AGENTPORT_TEST_EXIT_CODE;
const stderrText = process.env.AGENTPORT_TEST_STDERR;

if (fixturePath) {
  const content = readFileSync(fixturePath, "utf8");
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) {
      console.log(line);
    }
  }
}

if (stderrText) {
  console.error(stderrText);
}

process.exitCode = exitCode ? Number(exitCode) : 0;
