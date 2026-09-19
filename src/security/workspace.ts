import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from "node:path";

export const DEFAULT_AGENT_WORKSPACE_ROOT = "/var/agentport/workspaces";

export type ApprovedWorkspaceErrorCode =
  "workspace_root_invalid" | "workspace_invalid";

export class ApprovedWorkspaceError extends Error {
  constructor(readonly code: ApprovedWorkspaceErrorCode) {
    super(code);
    this.name = "ApprovedWorkspaceError";
  }
}

export interface ApprovedWorkspaceResolution {
  canonicalRoot: string;
  canonicalPath: string;
  rootUid: number;
  rootGid: number;
  workspaceUid: number;
  workspaceGid: number;
}

function contains(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function requireNormalizedAbsolute(
  path: string,
  code: ApprovedWorkspaceErrorCode,
): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new ApprovedWorkspaceError(code);
  }
}

async function rejectSymlinkComponents(path: string): Promise<void> {
  const root = path.startsWith("/") ? "/" : dirname(path);
  let current = root;
  const components = path.slice(root.length).split("/").filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new ApprovedWorkspaceError("workspace_invalid");
    }
  }
}

async function validateWorkspaceComponents(
  workspaceRoot: string,
  workspacePath: string,
  rootMetadata: Awaited<ReturnType<typeof lstat>>,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  let current = workspaceRoot;
  let metadata = rootMetadata;
  for (const component of relative(workspaceRoot, workspacePath)
    .split("/")
    .filter(Boolean)) {
    current = join(current, component);
    metadata = await lstat(current);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !isApprovedDirectoryMode(metadata.mode) ||
      metadata.uid !== rootMetadata.uid ||
      metadata.gid !== rootMetadata.gid
    ) {
      throw new ApprovedWorkspaceError("workspace_invalid");
    }
  }
  return metadata;
}

function rejectProtectedRoot(workspaceRoot: string): void {
  const protectedRoots = ["/etc", "/run", "/opt", "/var/lib"];
  if (
    workspaceRoot === "/" ||
    basename(workspaceRoot) !== "workspaces" ||
    protectedRoots.some((root) => contains(root, workspaceRoot))
  ) {
    throw new ApprovedWorkspaceError("workspace_root_invalid");
  }
}

function isApprovedDirectoryMode(mode: number | bigint): boolean {
  const numericMode = Number(mode);
  return (numericMode & 0o7027) === 0 && (numericMode & 0o100) !== 0;
}

/**
 * Resolves an administrator-approved Runtime Workspace without following
 * symlink components or admitting protected host directories.
 */
export async function resolveApprovedWorkspace(
  workspaceRoot: string,
  workspacePath: string,
): Promise<ApprovedWorkspaceResolution> {
  requireNormalizedAbsolute(workspaceRoot, "workspace_root_invalid");
  requireNormalizedAbsolute(workspacePath, "workspace_invalid");
  rejectProtectedRoot(workspaceRoot);
  try {
    await rejectSymlinkComponents(workspaceRoot);
    await rejectSymlinkComponents(workspacePath);
    const rootMetadata = await lstat(workspaceRoot);
    const workspaceMetadata = await validateWorkspaceComponents(
      workspaceRoot,
      workspacePath,
      rootMetadata,
    );
    if (
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      !workspaceMetadata.isDirectory() ||
      workspaceMetadata.isSymbolicLink() ||
      !isApprovedDirectoryMode(rootMetadata.mode) ||
      !isApprovedDirectoryMode(workspaceMetadata.mode) ||
      rootMetadata.uid !== workspaceMetadata.uid ||
      rootMetadata.gid !== workspaceMetadata.gid ||
      !contains(workspaceRoot, workspacePath) ||
      workspaceRoot === workspacePath
    ) {
      throw new ApprovedWorkspaceError("workspace_invalid");
    }
    const canonicalRoot = await realpath(workspaceRoot);
    const canonicalPath = await realpath(workspacePath);
    if (
      !contains(canonicalRoot, canonicalPath) ||
      canonicalRoot === canonicalPath
    ) {
      throw new ApprovedWorkspaceError("workspace_invalid");
    }
    return {
      canonicalRoot,
      canonicalPath,
      rootUid: rootMetadata.uid,
      rootGid: rootMetadata.gid,
      workspaceUid: workspaceMetadata.uid,
      workspaceGid: workspaceMetadata.gid,
    };
  } catch (error) {
    if (error instanceof ApprovedWorkspaceError) throw error;
    throw new ApprovedWorkspaceError("workspace_invalid");
  }
}
