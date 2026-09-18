import { describe, expect, it } from "vitest";

import { hasProtectedLauncherSocketMetadata } from "../../src/supervisor/linux/launcher-client.js";

const socket = { isSocket: () => true, uid: 0, mode: 0o140660 };

describe("launcher client protected socket metadata", () => {
  it("accepts only the Gate-056 sticky shared parent at its fixed path", () => {
    const sharedParent = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o41771,
    };
    expect(
      hasProtectedLauncherSocketMetadata(
        "/run/agentport/launcher.sock",
        socket,
        sharedParent,
      ),
    ).toBe(true);
    expect(
      hasProtectedLauncherSocketMetadata(
        "/run/other/launcher.sock",
        socket,
        sharedParent,
      ),
    ).toBe(false);
  });

  it("still rejects unsafe socket and parent metadata", () => {
    const protectedParent = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o40750,
    };
    expect(
      hasProtectedLauncherSocketMetadata(
        "/run/other/launcher.sock",
        { ...socket, mode: 0o140666 },
        protectedParent,
      ),
    ).toBe(false);
    expect(
      hasProtectedLauncherSocketMetadata("/run/other/launcher.sock", socket, {
        ...protectedParent,
        mode: 0o40770,
      }),
    ).toBe(false);
  });
});
