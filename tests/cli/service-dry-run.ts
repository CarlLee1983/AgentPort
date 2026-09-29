import { expect } from "vitest";

interface DryRunMarkers {
  present: string[];
  absent: string[];
}

const MARKERS: Partial<Record<NodeJS.Platform, DryRunMarkers>> = {
  darwin: {
    present: ["com.agentport.serve", "<plist"],
    absent: ["[Unit]"],
  },
  linux: {
    present: [
      "Description=AgentPort MCP service",
      "systemctl --user daemon-reload && systemctl --user enable --now agentport",
    ],
    absent: ["<plist"],
  },
};

/** 斷言 `service install --dry-run` 的 stdout 是本機平台的服務定義，且不含另一平台的標記。 */
export function expectHostServiceDryRun(stdout: string): void {
  const markers = MARKERS[process.platform];
  if (!markers) {
    throw new Error(`不支援的測試平台：${process.platform}`);
  }
  for (const marker of markers.present) {
    expect(stdout).toContain(marker);
  }
  for (const marker of markers.absent) {
    expect(stdout).not.toContain(marker);
  }
}
