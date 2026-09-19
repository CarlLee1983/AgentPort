import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("production daemon boundary", () => {
  it("has no test runner, fixture, governance or ambient dispatch switch", async () => {
    const sources = await Promise.all(
      ["main.ts", "lifecycle.ts", "composition.ts", "configuration.ts"].map(
        (file) => readFile(resolve(root, "src/daemon", file), "utf8"),
      ),
    );
    const productionSource = sources.join("\n");
    expect(productionSource).not.toMatch(
      /(?:vitest|dist-fixtures|tests\/fixtures|PraxisBound|ForgePilot|AGENTPORT_G1|fixture flag)/iu,
    );
    expect(productionSource).not.toMatch(
      /process\.env\.(?!CREDENTIALS_DIRECTORY)/u,
    );
    expect(productionSource).not.toMatch(
      /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/u,
    );
  });

  it("fixes production Registry credentials to an empty map", async () => {
    const source = await readFile(
      resolve(root, "src/daemon/composition.ts"),
      "utf8",
    );
    expect(source).toContain("credentials: {}");
    expect(source).not.toMatch(/configuration\.(?:credentials|tokens)/u);
  });
});
