import type { RuntimeIngressFactory } from "../dispatcher/controlled-runtime-dispatcher.js";

/**
 * Re-verifies the launcher-owned ingress directory before every dispatch opens
 * a socket in it, because the directory may change after startup (AP-021 R3).
 */
export function verifyBeforeEachIngressOpen(
  factory: RuntimeIngressFactory,
  verify: () => Promise<void>,
): RuntimeIngressFactory {
  return {
    async open(input) {
      await verify();
      return factory.open(input);
    },
  };
}
