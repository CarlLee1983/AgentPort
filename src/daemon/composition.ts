import {
  prepareControlledRuntimeAdmission,
  type ControlledRuntimeAdmissionComposition,
} from "../bootstrap/create-controlled-runtime-admission.js";
import type { DaemonConfiguration } from "./configuration.js";
import type { DaemonCredentials } from "./credentials.js";

/**
 * Maps the secret-free production file plus systemd credentials into the
 * already-approved controlled Runtime composition. Production Caller
 * credentials intentionally remain empty until AP-024 supplies a verifier.
 */
export function prepareProductionDaemonComposition(
  configuration: DaemonConfiguration,
  credentials: DaemonCredentials,
): Promise<ControlledRuntimeAdmissionComposition> {
  return prepareControlledRuntimeAdmission({
    registry: {
      credentials: {},
      agents: configuration.agents,
      principals: configuration.principals,
    },
    cursorSecret: credentials.cursorSecret,
    storage: {
      ...configuration.storage,
      continuationEncryptionKey: credentials.continuationEncryptionKey,
    },
    launcher: configuration.launcher,
  });
}
