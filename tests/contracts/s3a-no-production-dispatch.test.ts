import { readFile } from "node:fs/promises";
import { dirname, normalize, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDurableAdmission } from "../../src/bootstrap/create-durable-admission.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { startDurableAdmissionMcpEndpoint } from "../fixtures/durable-admission-mcp.js";

const forbiddenProcessCreation = vi.fn(() => {
  throw new Error("S3-A production process-creation tripwire");
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
].map((path) => resolve(REPOSITORY_ROOT, path));
const STORAGE_WORKER_HOST = resolve(
  REPOSITORY_ROOT,
  "src/storage/sqlite-durable-admission-store.ts",
);
const FORBIDDEN_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "node:child_process",
];
const FORBIDDEN_PATHS = [
  "/runtime/",
  "/supervisor/",
  "/dispatcher/",
  "/launcher/",
  "/core/execution-supervisor.ts",
];

function imports(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'`]([^"'`]+)["'`]/g,
    ),
  ].map(([, specifier]) => specifier ?? "");
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

describe("S3-A no-production-dispatch contract", () => {
  it("keeps every production composition root physically outside Runtime ingress", async () => {
    const reachable = new Set<string>();
    for (const root of COMPOSITION_ROOTS) {
      for (const file of await reachableImports(root)) reachable.add(file);
    }
    for (const file of reachable) {
      const portable = `/${relative(REPOSITORY_ROOT, file).replaceAll("\\", "/")}`;
      for (const forbidden of FORBIDDEN_PATHS) {
        expect(portable).not.toContain(forbidden);
      }
      const source = await readFile(file, "utf8");
      const specifiers = imports(source);
      if (specifiers.includes("node:worker_threads")) {
        expect(file).toBe(STORAGE_WORKER_HOST);
      }
      expect(source).not.toMatch(
        /\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/,
      );
      expect(source).not.toMatch(
        /\b(?:docker|podman|cgroup|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\b/,
      );
      expect(source).not.toMatch(
        /\b(?:enableDispatch|dispatchEnabled|noopRuntime|fakeRuntimeAdapter)\b/,
      );
      expect(source).not.toMatch(
        /["'`][^"'`]*(?:\/runtime\/|\/supervisor\/|\/dispatcher\/|\/launcher\/)/i,
      );
      const workerCalls = source.match(/\bnew\s+Worker\s*\(/g) ?? [];
      if (file === STORAGE_WORKER_HOST) {
        expect(workerCalls).toHaveLength(1);
        expect(
          [...source.matchAll(/new\s+URL\s*\(\s*["'`]([^"'`]+)["'`]/g)].map(
            ([, target]) => target,
          ),
        ).toEqual([
          "./sqlite-durable-admission-worker.js",
          "../../dist/src/storage/sqlite-durable-admission-worker.js",
          "../../../dist/src/storage/sqlite-durable-admission-worker.js",
        ]);
      } else {
        expect(workerCalls).toHaveLength(0);
      }
    }
    expect(reachable).not.toContain(
      resolve(REPOSITORY_ROOT, "src/runtime/worker/entrypoint.ts"),
    );
  });

  it("serves production and MCP compositions without process side effects", async () => {
    const fixture = await createDurableAdmissionFixture();
    let production:
      Awaited<ReturnType<typeof createDurableAdmission>> | undefined;
    try {
      const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
      await endpoint.close();
      await fixture.store.close();
      production = await createDurableAdmission({
        registry: fixture.registryConfiguration,
        cursorSecret: "s3a-production-composition-secret",
        storage: { databasePath: fixture.databasePath },
      });
      expect(forbiddenProcessCreation).not.toHaveBeenCalled();
    } finally {
      await production?.close();
      await fixture.close();
    }

    expect(forbiddenProcessCreation).not.toHaveBeenCalled();
  });
});
