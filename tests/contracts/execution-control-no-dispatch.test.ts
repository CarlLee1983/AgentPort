import { readFile } from "node:fs/promises";
import { dirname, normalize, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { startDurableAdmissionMcpEndpoint } from "../fixtures/durable-admission-mcp.js";

const forbiddenProcessCreation = vi.fn(() => {
  throw new Error("AP-003 process-creation tripwire");
});

vi.mock("node:child_process", () => ({
  exec: forbiddenProcessCreation,
  execFile: forbiddenProcessCreation,
  fork: forbiddenProcessCreation,
  spawn: forbiddenProcessCreation,
  spawnSync: forbiddenProcessCreation,
}));

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const COMPOSITION_ROOTS = [
  "src/bootstrap/create-durable-admission.ts",
  "src/mcp/adapter.ts",
  "src/mcp/loopback-server.ts",
].map((path) => joinRoot(path));
const FORBIDDEN_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "node:child_process",
];
const FORBIDDEN_PATHS = [
  "/runtime/",
  "/dispatcher/",
  "/launcher/",
  "/supervisor/",
  "/execution/",
];

function joinRoot(path: string): string {
  return resolve(REPOSITORY_ROOT, path);
}

function imports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map(
    ([, specifier]) => specifier ?? "",
  );
}

function localImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return normalize(
    resolve(dirname(importer), specifier.replace(/\.js$/, ".ts")),
  );
}

async function reachableImports(entry: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source)) {
      expect(FORBIDDEN_IMPORTS).not.toContain(specifier);
      const local = localImport(file, specifier);
      if (local !== undefined) pending.push(local);
    }
  }
  return visited;
}

describe("AP-003 execution-control no-dispatch composition", () => {
  it("cannot reach the Supervisor seam, Runtime, launcher, or process creation", async () => {
    const reachable = new Set<string>();
    for (const root of COMPOSITION_ROOTS) {
      for (const file of await reachableImports(root)) reachable.add(file);
    }
    expect(reachable).not.toContain(
      joinRoot("src/core/execution-supervisor.ts"),
    );
    for (const file of reachable) {
      const portable = `/${relative(REPOSITORY_ROOT, file).replaceAll("\\", "/")}`;
      for (const forbidden of FORBIDDEN_PATHS) {
        expect(portable).not.toContain(forbidden);
      }
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/,
      );
    }
  });

  it("runs lifecycle-read composition without creating a process", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
      await endpoint.close();
      expect(forbiddenProcessCreation).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
