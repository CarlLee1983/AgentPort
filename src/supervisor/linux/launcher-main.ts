import { LinuxLauncherServer } from "./launcher-server.js";
import { readProtectedLinuxLauncherOptions } from "./launcher-configuration.js";

async function main(): Promise<void> {
  const configurationPath = process.env["AGENTPORT_LAUNCHER_CONFIG"];
  if (configurationPath === undefined || configurationPath.length === 0) {
    throw new Error("AGENTPORT_LAUNCHER_CONFIG is required");
  }
  const options = await readProtectedLinuxLauncherOptions(configurationPath);
  const launcher = new LinuxLauncherServer(options);
  await launcher.listen();

  const close = (): void => {
    void launcher.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch(() => {
  process.exitCode = 1;
});
