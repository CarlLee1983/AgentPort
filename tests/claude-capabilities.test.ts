import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("AP-001 Claude SDK static capability evidence", () => {
  it("pins the inspected SDK package without executing query", async () => {
    const sdkUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    const packageUrl = new URL("package.json", sdkUrl);
    const metadata = JSON.parse(
      await readFile(new URL(packageUrl), "utf8"),
    ) as {
      claudeCodeVersion: string;
      optionalDependencies: Record<string, string>;
      version: string;
    };

    expect(metadata.version).toBe("0.3.269");
    expect(metadata.claudeCodeVersion).toBe("2.1.269");
    for (const packageName of Object.keys(metadata.optionalDependencies)) {
      expect(packageName).toMatch(/^@anthropic-ai\/claude-agent-sdk-/u);
      expect(() => import.meta.resolve(packageName)).toThrow();
    }
  });
});
