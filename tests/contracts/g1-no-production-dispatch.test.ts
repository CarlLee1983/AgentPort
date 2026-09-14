import { readFile } from "node:fs/promises";
import { dirname, normalize, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { startDurableAdmissionMcpEndpoint } from "../fixtures/durable-admission-mcp.js";

const forbiddenProcessCreation = vi.fn(() => {
  throw new Error("AP-004 process-creation tripwire");
});
const forbiddenClaudeQuery = vi.fn(() => {
  throw new Error("AP-004 Claude dispatch tripwire");
});

vi.mock("node:child_process", () => ({
  exec: forbiddenProcessCreation,
  execFile: forbiddenProcessCreation,
  fork: forbiddenProcessCreation,
  spawn: forbiddenProcessCreation,
  spawnSync: forbiddenProcessCreation,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: forbiddenClaudeQuery,
}));

const root = resolve(import.meta.dirname, "../..");
const entries = [
  "src/bootstrap/create-durable-admission.ts",
  "src/mcp/adapter.ts",
  "src/mcp/loopback-server.ts",
].map((path) => resolve(root, path));
const forbidden = [
  "/supervisor/linux/",
  "/runtime/worker/",
  "/runtime/claude/",
];
const forbiddenImports = [
  "@anthropic-ai/claude-agent-sdk",
  "node:child_process",
];

function imports(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:from\s+|import\s*\(|require\s*\()\s*["'`]([^"'`]+)["'`]/g,
    ),
  ].map(([, value]) => value ?? "");
}

async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source)) {
      expect(forbiddenImports).not.toContain(specifier);
      if (!specifier.startsWith(".")) continue;
      pending.push(
        normalize(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"))),
      );
    }
  }
  return seen;
}

describe("AP-004 G1 production isolation", () => {
  it("keeps the Linux launcher and Runtime worker outside production composition", async () => {
    for (const entry of entries) {
      for (const file of await reachable(entry)) {
        const portable = `/${relative(root, file).replaceAll("\\", "/")}`;
        for (const path of forbidden) expect(portable).not.toContain(path);
        const source = await readFile(file, "utf8");
        expect(source).not.toMatch(
          /\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/,
        );
      }
    }
  });

  it("runs production lifecycle composition without process or Claude dispatch", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
      await endpoint.close();
      expect(forbiddenProcessCreation).not.toHaveBeenCalled();
      expect(forbiddenClaudeQuery).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
