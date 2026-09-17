import { preflightLinuxOperations } from "./linux-preflight.js";

const [launcherConfigurationPath, daemonUser, databasePath] =
  process.argv.slice(2);

if (
  process.argv.length !== 5 ||
  launcherConfigurationPath === undefined ||
  daemonUser === undefined ||
  databasePath === undefined
) {
  console.log(
    JSON.stringify({
      status: "configuration_invalid",
      dispatchEligible: false,
      checks: [{ code: "configuration_fields", outcome: "fail" }],
    }),
  );
  process.exitCode = 2;
} else {
  const result = await preflightLinuxOperations({
    launcherConfigurationPath,
    daemonUser,
    databasePath,
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "preparation_valid" ? 0 : 2;
}
