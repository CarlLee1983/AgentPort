import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { startDurableAdmissionMcpEndpoint } from "../fixtures/durable-admission-mcp.js";

const forbiddenProcessCreation = vi.fn(() => {
  throw new Error("AP-002 process-creation tripwire");
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
  "tests/fixtures/durable-admission-mcp.ts",
].map((path) => join(REPOSITORY_ROOT, path));
const FORBIDDEN_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "node:child_process",
];
const FORBIDDEN_PATH_PARTS = [
  "/execution/",
  "/runtime/",
  "/supervisor/",
  "/dispatcher/",
  "/launcher/",
];

function imports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map(
    ([, specifier]) => specifier ?? "",
  );
}

function localImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const path = resolve(dirname(importer), specifier.replace(/\.js$/, ".ts"));
  return normalize(path);
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

describe("AP-002 no-dispatch composition", () => {
  it("cannot reach Runtime, Supervisor, launcher, or process creation", async () => {
    const reachable = new Set<string>();
    for (const root of COMPOSITION_ROOTS) {
      for (const file of await reachableImports(root)) reachable.add(file);
    }
    for (const file of reachable) {
      const portable = `/${relative(REPOSITORY_ROOT, file).replaceAll("\\", "/")}`;
      for (const forbidden of FORBIDDEN_PATH_PARTS) {
        expect(portable).not.toContain(forbidden);
      }
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/,
      );
    }
    const sourceFiles = await readdir(join(REPOSITORY_ROOT, "src"), {
      recursive: true,
    });
    const optionalExecutionArtifacts = sourceFiles
      .map((file) => `/${file.replaceAll("\\", "/")}`)
      .filter((file) =>
        FORBIDDEN_PATH_PARTS.some((part) => file.includes(part)),
      )
      .map((file) => join(REPOSITORY_ROOT, "src", file.slice(1)));
    for (const optionalArtifact of optionalExecutionArtifacts) {
      expect(reachable).not.toContain(normalize(optionalArtifact));
    }
  });

  it("contains no AP-002 execution schema", async () => {
    const migration = await readFile(
      join(REPOSITORY_ROOT, "migrations/001_durable_admission.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(
      /CREATE TABLE IF NOT EXISTS (?:executions|questions|workspace_claims|supervisor|launcher)/i,
    );
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS tasks/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS task_reservations/i);
  });

  it("runs the full loopback fixture without process creation", async () => {
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
