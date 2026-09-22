import { spawn } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createTestHttpApp, type TestHttpApp } from "../helpers/http-app.js";
import { unavailableDrivers } from "../helpers/unavailable-driver.js";

afterEach(cleanupTempDirs);

async function runTrigger(env: NodeJS.ProcessEnv): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ["scripts/backlog-trigger.mjs"], {
    cwd: process.cwd(),
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const [exitCode] = (await once(child, "close")) as [number | null];
  return { exitCode: exitCode ?? 1, stdout, stderr };
}

describe("backlog-trigger", () => {
  let app: TestHttpApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("驗證 read-only Agent 後提交一個 Task", async () => {
    app = await createTestHttpApp(
      unavailableDrivers,
      [
        {
          name: "backlog-scheduler",
          tokenEnv: "AGENTPORT_TOKEN",
          token: "secret",
        },
      ],
      { agent: { name: "backlog-triage", policy: "read-only" } },
    );

    const result = await runTrigger({
      ...process.env,
      AGENTPORT_URL: app.handle.url,
      AGENTPORT_TOKEN: "secret",
      AGENTPORT_BACKLOG_AGENT: "backlog-triage",
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { task_id: string };
    expect(app.store.getTask(output.task_id)?.caller).toBe("backlog-scheduler");
  });

  it("拒絕非 read-only 的 Agent，且不提交 Task", async () => {
    app = await createTestHttpApp(unavailableDrivers, [
      {
        name: "backlog-scheduler",
        tokenEnv: "AGENTPORT_TOKEN",
        token: "secret",
      },
    ]);

    const result = await runTrigger({
      ...process.env,
      AGENTPORT_URL: app.handle.url,
      AGENTPORT_TOKEN: "secret",
      AGENTPORT_BACKLOG_AGENT: "stationhub",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must use read-only policy");
    expect(result.stdout).toBe("");
  });

  it("在缺少 bearer token 時不連線", async () => {
    const result = await runTrigger({
      ...process.env,
      AGENTPORT_URL: "http://127.0.0.1:3333/",
      AGENTPORT_BACKLOG_AGENT: "backlog-triage",
      AGENTPORT_TOKEN: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AGENTPORT_TOKEN must be set");
  });
});
