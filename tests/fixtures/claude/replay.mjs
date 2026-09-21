#!/usr/bin/env node
// 測試用假 `claude`：把一份 fixture JSONL 逐行印到 stdout，模擬 claude 子程序輸出，
// 讓 driver.test.ts 能透過 createClaudeDriver 真的跑一個子程序來回放，不用 mock 掉它。
//
// 用環境變數而非 argv 控制行為：createClaudeDriver 依 buildClaudeArgs 產生的第一個
// 引數固定是 `-p`，若把這份腳本的路徑當 `command` 交給 node 執行，argv 會被 node
// 自己的 `-p`/`--print` 搶走語意，所以改用環境變數傳 fixture 路徑、退出碼、stderr 文字。
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
