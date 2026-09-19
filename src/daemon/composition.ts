import {
  prepareControlledRuntimeAdmission,
  type ControlledRuntimeAdmissionComposition,
} from "../bootstrap/create-controlled-runtime-admission.js";
import type { DaemonConfiguration } from "./configuration.js";
import type { DaemonCredentials } from "./credentials.js";

/**
 * Maps the secret-free production file plus systemd credentials into the
 * already-approved controlled Runtime composition. Caller credentials are
 * loaded from the protected registry, but Task admission remains fail-closed
 * until a verified Runtime readiness contract is supplied by a follow-on
 * deployment boundary.
 */
export function prepareProductionDaemonComposition(
  configuration: DaemonConfiguration,
  credentials: DaemonCredentials,
): Promise<ControlledRuntimeAdmissionComposition> {
  return prepareControlledRuntimeAdmission({
    registry: {
      credentials: {},
      callers: configuration.callers ?? [],
      ...(configuration.registryRevision === undefined
        ? {}
        : { registryRevision: configuration.registryRevision }),
      ...(configuration.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: configuration.workspaceRoot }),
      agents: configuration.agents,
      principals: configuration.principals,
    },
    cursorSecret: credentials.cursorSecret,
    storage: {
      ...configuration.storage,
      continuationEncryptionKey: credentials.continuationEncryptionKey,
    },
    canAdmitTasks: () => false,
    launcher: configuration.launcher,
  });
}
