import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  LINUX_G1_ENABLED,
  requiredEnvironment,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture listener did not bind TCP");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return port;
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for systemd fixture");
}

async function queryAdminSocket(socketPath: string): Promise<string> {
  const source = [
    'import { createConnection } from "node:net";',
    `const socket=createConnection(${JSON.stringify(socketPath)});`,
    'let output=""; socket.setEncoding("utf8");',
    'socket.on("data", (chunk) => output += chunk);',
    'socket.once("error", () => process.exit(1));',
    'socket.once("connect", () => socket.end("{\\"version\\":1,\\"method\\":\\"get_readiness\\"}\\n"));',
    'socket.once("close", () => process.stdout.write(output));',
    "setTimeout(() => process.exit(1), 2_000).unref();",
  ].join(" ");
  const result = await executeFile(process.execPath, [
    "--input-type=module",
    "--eval",
    source,
  ]);
  return result.stdout;
}

async function assertRuntimeCannotConnect(
  socketPath: string,
  runtimeUser: string,
): Promise<void> {
  const source = [
    'import { createConnection } from "node:net";',
    `const socket=createConnection(${JSON.stringify(socketPath)});`,
    'socket.once("connect", () => process.exit(0));',
    'socket.once("error", () => process.exit(1));',
    "setTimeout(() => process.exit(1), 2_000).unref();",
  ].join(" ");
  await expect(
    executeFile("/usr/sbin/runuser", [
      "--user",
      runtimeUser,
      "--",
      process.execPath,
      "--input-type=module",
      "--eval",
      source,
    ]),
  ).rejects.toMatchObject({ code: 1 });
}

describe.skipIf(!LINUX_G1_ENABLED)("production daemon systemd contract", () => {
  it("passes systemd unit verification with only fixture path substitutions", async () => {
    const directory = await mkdtemp("/tmp/agentport-ap022-unit-");
    try {
      const source = await readFile(
        "config/systemd/agentport-daemon.service",
        "utf8",
      );
      const launcherSource = await readFile(
        "config/g1/agentport-g1-launcher.service",
        "utf8",
      );
      expect(source).toContain("User=agentport-daemon");
      expect(source).toContain("Group=agentport-daemon");
      expect(source).toContain(
        "SupplementaryGroups=agentport-launcher agentport-ingress agentport-runtime agentport-admin",
      );
      expect(source).toContain("UMask=0077");
      expect(source).toContain("TimeoutStopSec=30s");
      expect(source).toContain(
        "ReadWritePaths=/var/lib/agentport/daemon /run/agentport /run/agentport-ingress",
      );
      expect(source).toContain("LoadCredential=cursorSecret:");
      expect(source).toContain("LoadCredential=continuationEncryptionKey:");
      expect(source).not.toMatch(/Environment=.*(?:Secret|Key|TOKEN)/u);
      expect(launcherSource).toContain(
        "ReadWritePaths=/run/agentport /run/agentport-ingress /var/lib/agentport-g1",
      );

      const candidate = source
        .replace(/^WorkingDirectory=.*$/mu, `WorkingDirectory=${process.cwd()}`)
        .replace(
          /^ExecStart=.*$/mu,
          `ExecStart=${process.execPath} ${resolve("dist/src/daemon/main.js")} --config /etc/agentport/agentport.json`,
        );
      await writeFile(
        join(directory, "agentport-daemon.service"),
        candidate,
        "utf8",
      );
      await writeFile(
        join(directory, "agentport-launcher.service"),
        "[Service]\nType=simple\nExecStart=/bin/true\n",
        "utf8",
      );
      await expect(
        executeFile("systemd-analyze", [
          "verify",
          join(directory, "agentport-launcher.service"),
          join(directory, "agentport-daemon.service"),
        ]),
      ).resolves.toMatchObject({ stdout: "" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("delivers fixed secrets with LoadCredential without leaking their values", async () => {
    const root = requiredEnvironment("AGENTPORT_G1_G4_FIXTURE_ROOT");
    const directory = await mkdtemp(join(root, "ap022-credentials-"));
    const cursorSecret = `ap022-linux-cursor-${randomUUID()}`;
    const continuationEncryptionKey = randomBytes(32).toString("base64url");
    const cursorPath = join(directory, "cursorSecret");
    const continuationPath = join(directory, "continuationEncryptionKey");
    try {
      await Promise.all([
        writeFile(cursorPath, cursorSecret, { mode: 0o600 }),
        writeFile(continuationPath, continuationEncryptionKey, { mode: 0o600 }),
      ]);
      await Promise.all([
        chmod(cursorPath, 0o600),
        chmod(continuationPath, 0o600),
      ]);
      const credentialModule = pathToFileURL(
        resolve("dist/src/daemon/credentials.js"),
      ).href;
      const script = `const {readSystemdDaemonCredentials}=await import(${JSON.stringify(credentialModule)});await readSystemdDaemonCredentials();process.stdout.write("AP022_CREDENTIALS_OK\\n")`;
      const unit = `agentport-ap022-credentials-${randomUUID()}`;
      const result = await executeFile(
        "systemd-run",
        [
          "--quiet",
          "--wait",
          "--pipe",
          "--collect",
          `--unit=${unit}`,
          `--property=User=${requiredEnvironment("AGENTPORT_G1_DAEMON_USER")}`,
          `--property=Group=${requiredEnvironment("AGENTPORT_G1_DAEMON_USER")}`,
          `--property=LoadCredential=cursorSecret:${cursorPath}`,
          `--property=LoadCredential=continuationEncryptionKey:${continuationPath}`,
          process.execPath,
          "--input-type=module",
          "--eval",
          script,
        ],
        { timeout: 30_000, maxBuffer: 256 * 1024 },
      );
      expect(result.stdout.trim()).toBe("AP022_CREDENTIALS_OK");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(cursorSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        continuationEncryptionKey,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("restarts the compiled non-root daemon with fixed credentials and stops it with SIGTERM", async () => {
    const fixtureRoot = requiredEnvironment("AGENTPORT_G1_G4_FIXTURE_ROOT");
    const directory = await mkdtemp(join(fixtureRoot, "ap022-daemon-"));
    const databaseDirectory = join(directory, "database");
    const credentialDirectory = join(directory, "source-credentials");
    const configurationPath = join(directory, "agentport.json");
    const databasePath = join(databaseDirectory, "agentport.sqlite");
    const cursorPath = join(credentialDirectory, "cursorSecret");
    const continuationPath = join(
      credentialDirectory,
      "continuationEncryptionKey",
    );
    const daemonUser = requiredEnvironment("AGENTPORT_G1_DAEMON_USER");
    const launcherConfiguration = JSON.parse(
      await readFile(
        requiredEnvironment("AGENTPORT_G1_LAUNCHER_CONFIG"),
        "utf8",
      ),
    ) as {
      socketGroup: string;
      ingressGroup: string;
      runtimeGroup: string;
    };
    const daemonIds = await executeFile("id", ["-u", daemonUser]);
    const daemonGroups = await executeFile("id", ["-g", daemonUser]);
    const daemonGroupName = await executeFile("id", ["-gn", daemonUser]);
    const adminGroup = await executeFile("getent", [
      "group",
      "agentport-admin",
    ]);
    const launcherGroup = await executeFile("getent", [
      "group",
      launcherConfiguration.socketGroup,
    ]);
    const daemonUid = Number(daemonIds.stdout.trim());
    const daemonGid = Number(daemonGroups.stdout.trim());
    const adminGroupId = Number(adminGroup.stdout.trim().split(":")[2]);
    const launcherGroupId = Number(launcherGroup.stdout.trim().split(":")[2]);
    if (!Number.isSafeInteger(adminGroupId) || adminGroupId < 1) {
      throw new Error("administrator group is invalid");
    }
    if (!Number.isSafeInteger(launcherGroupId) || launcherGroupId < 1) {
      throw new Error("launcher group is invalid");
    }
    const cursorSecret = `ap022-daemon-cursor-${randomUUID()}`;
    const continuationEncryptionKey = randomBytes(32).toString("base64url");
    const port = await unusedPort();
    const adminSocketPath = "/run/agentport/admin.sock";
    const units = [
      `agentport-ap022-daemon-${randomUUID()}`,
      `agentport-ap022-daemon-${randomUUID()}`,
    ];
    const duplicateUnit = `agentport-ap022-duplicate-${randomUUID()}`;
    try {
      await chmod(directory, 0o711);
      await mkdir(databaseDirectory, { mode: 0o700 });
      await chown(databaseDirectory, daemonUid, daemonGid);
      await mkdir(credentialDirectory, { mode: 0o700 });
      await Promise.all([
        writeFile(cursorPath, cursorSecret, { mode: 0o600 }),
        writeFile(continuationPath, continuationEncryptionKey, { mode: 0o600 }),
      ]);
      const configuration = {
        schemaVersion: 1,
        mcp: { port },
        storage: { databasePath },
        launcher: {
          socketPath: requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"),
          workerIngressDirectory: requiredEnvironment(
            "AGENTPORT_G1_INGRESS_DIRECTORY",
          ),
          socketGroupId: launcherGroupId,
          runtimeGroupId: Number(
            requiredEnvironment("AGENTPORT_G1_RUNTIME_GID"),
          ),
          ingressGroupId: Number(
            requiredEnvironment("AGENTPORT_G1_INGRESS_GID"),
          ),
        },
        adminSocket: { groupId: adminGroupId },
        agents: [],
        principals: [],
      };
      await writeFile(configurationPath, JSON.stringify(configuration), {
        mode: 0o640,
      });
      await chown(configurationPath, 0, daemonGid);
      await chmod(configurationPath, 0o640);

      const startUnit = (unit: string) =>
        executeFile(
          "systemd-run",
          [
            "--quiet",
            `--unit=${unit}`,
            `--property=User=${daemonUser}`,
            `--property=Group=${daemonGroupName.stdout.trim()}`,
            `--property=SupplementaryGroups=${launcherConfiguration.socketGroup} ${launcherConfiguration.ingressGroup} ${launcherConfiguration.runtimeGroup} agentport-admin`,
            `--property=WorkingDirectory=${process.cwd()}`,
            "--property=UMask=0077",
            "--property=TimeoutStopSec=30s",
            "--property=NoNewPrivileges=yes",
            "--property=PrivateDevices=yes",
            "--property=PrivateTmp=yes",
            "--property=ProtectHome=yes",
            "--property=ProtectSystem=strict",
            `--property=ReadWritePaths=${fixtureRoot} /run/agentport /run/agentport-ingress`,
            "--property=RestrictAddressFamilies=AF_UNIX AF_INET",
            "--property=RestrictNamespaces=yes",
            "--property=LockPersonality=yes",
            `--property=LoadCredential=cursorSecret:${cursorPath}`,
            `--property=LoadCredential=continuationEncryptionKey:${continuationPath}`,
            process.execPath,
            resolve("dist/src/daemon/main.js"),
            "--config",
            configurationPath,
          ],
          { timeout: 10_000, maxBuffer: 256 * 1024 },
        );
      for (const unit of units) {
        await startUnit(unit);
        await waitUntil(async () => {
          try {
            const response = await fetch(
              `http://127.0.0.1:${String(port)}/mcp`,
            );
            return response.status === 401;
          } catch {
            return false;
          }
        });
        await waitUntil(async () => {
          try {
            const metadata = await stat(adminSocketPath);
            return (
              metadata.isSocket() &&
              metadata.uid === daemonUid &&
              metadata.gid === adminGroupId &&
              (metadata.mode & 0o777) === 0o660
            );
          } catch {
            return false;
          }
        });
        await expect(queryAdminSocket(adminSocketPath)).resolves.toContain(
          '"level":"service-ready"',
        );
        await assertRuntimeCannotConnect(
          adminSocketPath,
          requiredEnvironment("AGENTPORT_G1_RUNTIME_USER"),
        );
        const mainPid = (
          await executeFile("systemctl", [
            "show",
            unit,
            "--property=MainPID",
            "--value",
          ])
        ).stdout.trim();
        const environment = await readFile(`/proc/${mainPid}/environ`, "utf8");
        expect(environment).toContain("CREDENTIALS_DIRECTORY=");
        expect(environment).not.toContain(cursorSecret);
        expect(environment).not.toContain(continuationEncryptionKey);

        if (unit === units[0]) {
          await startUnit(duplicateUnit);
          await waitUntil(async () => {
            const state = await executeFile("systemctl", [
              "show",
              duplicateUnit,
              "--property=ActiveState",
              "--value",
            ]).catch(() => undefined);
            return ["failed", "inactive"].includes(state?.stdout.trim() ?? "");
          });
          const duplicate = await executeFile("systemctl", [
            "show",
            duplicateUnit,
            "--property=Result",
            "--property=ExecMainStatus",
          ]);
          expect(duplicate.stdout).toContain("Result=exit-code");
          expect(duplicate.stdout).toContain("ExecMainStatus=1");
          await expect(
            fetch(`http://127.0.0.1:${String(port)}/mcp`),
          ).resolves.toMatchObject({ status: 401 });
        }

        await executeFile("systemctl", ["kill", "--signal=SIGTERM", unit]);
        await waitUntil(async () => {
          const result = await executeFile("systemctl", [
            "show",
            unit,
            "--property=ActiveState",
            "--value",
          ]).catch(() => undefined);
          if (result === undefined) return false;
          return result.stdout.trim() === "inactive";
        }, 35_000);
        const result = await executeFile("systemctl", [
          "show",
          unit,
          "--property=Result",
          "--property=ExecMainStatus",
        ]);
        expect(result.stdout).toContain("Result=success");
        expect(result.stdout).toContain("ExecMainStatus=0");
        const journal = await executeFile("journalctl", [
          "--unit",
          unit,
          "--output=cat",
          "--no-pager",
        ]);
        expect(`${journal.stdout}\n${journal.stderr}`).not.toContain(
          cursorSecret,
        );
        expect(`${journal.stdout}\n${journal.stderr}`).not.toContain(
          continuationEncryptionKey,
        );
      }
      expect((await stat(databasePath)).uid).toBe(daemonUid);
      const database = await readFile(databasePath);
      expect(database.includes(Buffer.from(cursorSecret))).toBe(false);
      expect(database.includes(Buffer.from(continuationEncryptionKey))).toBe(
        false,
      );
      expect(requiredEnvironment("AGENTPORT_G1_RUNTIME_USER")).toBe(
        launcherConfiguration.runtimeGroup,
      );
    } finally {
      for (const unit of [...units, duplicateUnit]) {
        await executeFile("systemctl", ["stop", unit]).catch(() => undefined);
        await executeFile("systemctl", ["reset-failed", unit]).catch(
          () => undefined,
        );
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
