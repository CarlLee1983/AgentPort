import { lstat } from "node:fs/promises";
import { dirname } from "node:path";

export interface IngressPathMetadata {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
}

export interface IngressTargetMetadata extends IngressPathMetadata {
  gid: number;
}

export interface IngressDirectoryAncestor extends IngressPathMetadata {
  path: string;
}

export interface IngressDirectoryObservation {
  processUid: number;
  target: IngressTargetMetadata | undefined;
  ancestors: readonly IngressDirectoryAncestor[];
}

export interface IngressDirectoryExpectation {
  ingressGroupId: number;
  allowRootProcess: boolean;
}

export type IngressDirectoryAssessmentFailureReason =
  | "process_is_root"
  | "missing"
  | "not_directory"
  | "wrong_owner"
  | "wrong_group"
  | "wrong_mode"
  | "unprotected_ancestor";

export type IngressDirectoryAssessment =
  { ok: true } | { ok: false; reason: IngressDirectoryAssessmentFailureReason };

/** Launcher-created ingress directory mode (ADR-0006, GATE-040). */
export const INGRESS_DIRECTORY_MODE = 0o771;

/** Reads metadata without following a final symlink; undefined when missing. */
export type IngressPathProbe = (
  path: string,
) => Promise<IngressTargetMetadata | undefined>;

export const lstatIngressPath: IngressPathProbe = async (path) => {
  try {
    const metadata = await lstat(path);
    return {
      isDirectory: metadata.isDirectory(),
      isSymbolicLink: metadata.isSymbolicLink(),
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/**
 * Observes the configured ingress path exactly as given, never resolving
 * symlinks, so a symlinked directory or ancestor is assessed as such. A
 * missing ancestor is observed as a non-directory and therefore unprotected.
 */
export async function observeIngressDirectory(
  directory: string,
  processUid: number,
  probe: IngressPathProbe,
): Promise<IngressDirectoryObservation> {
  const ancestors: IngressDirectoryAncestor[] = [];
  let current = dirname(directory);
  for (;;) {
    const metadata = await probe(current);
    ancestors.push(
      metadata === undefined
        ? {
            path: current,
            isDirectory: false,
            isSymbolicLink: false,
            uid: -1,
            mode: 0,
          }
        : {
            path: current,
            isDirectory: metadata.isDirectory,
            isSymbolicLink: metadata.isSymbolicLink,
            uid: metadata.uid,
            mode: metadata.mode,
          },
    );
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { processUid, target: await probe(directory), ancestors };
}

function isUnprotectedAncestor(ancestor: IngressPathMetadata): boolean {
  return (
    !ancestor.isDirectory ||
    ancestor.isSymbolicLink ||
    ancestor.uid !== 0 ||
    (ancestor.mode & 0o022) !== 0
  );
}

/**
 * Pure check for the launcher-created, daemon-verified ingress directory
 * (ADR-0006, GATE-040). The launcher calls this with `allowRootProcess: true`
 * because it is the sole privileged process; the daemon calls it with
 * `allowRootProcess: false` because it must refuse to run as uid 0.
 */
export function assessProtectedIngressDirectory(
  observation: IngressDirectoryObservation,
  expected: IngressDirectoryExpectation,
): IngressDirectoryAssessment {
  if (!expected.allowRootProcess && observation.processUid === 0) {
    return { ok: false, reason: "process_is_root" };
  }
  if (observation.target === undefined) {
    return { ok: false, reason: "missing" };
  }
  const { target } = observation;
  if (!target.isDirectory || target.isSymbolicLink) {
    return { ok: false, reason: "not_directory" };
  }
  if (target.uid !== 0) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (target.gid !== expected.ingressGroupId) {
    return { ok: false, reason: "wrong_group" };
  }
  if ((target.mode & 0o7777) !== INGRESS_DIRECTORY_MODE) {
    return { ok: false, reason: "wrong_mode" };
  }
  if (observation.ancestors.some(isUnprotectedAncestor)) {
    return { ok: false, reason: "unprotected_ancestor" };
  }
  return { ok: true };
}

/**
 * Launcher startup contract (AP-021 R2): an existing ingress directory is
 * verified and never repaired; only a missing one is created, and the result
 * must verify before the launcher listens.
 */
export async function ensureLauncherIngressDirectory(
  ingressGroupId: number,
  observe: () => Promise<IngressDirectoryObservation>,
  create: () => Promise<void>,
): Promise<void> {
  const expected = { ingressGroupId, allowRootProcess: true };
  const existing = assessProtectedIngressDirectory(await observe(), expected);
  if (existing.ok) return;
  if (existing.reason !== "missing") {
    throw new Error("Launcher ingress directory is not protected", {
      cause: existing,
    });
  }
  await create();
  const created = assessProtectedIngressDirectory(await observe(), expected);
  if (!created.ok) {
    throw new Error("Launcher ingress directory is not protected", {
      cause: created,
    });
  }
}
