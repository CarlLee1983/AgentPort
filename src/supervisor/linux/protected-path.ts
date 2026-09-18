import { chmod, chown, lstat, mkdir } from "node:fs/promises";
import { dirname, parse } from "node:path";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function requireProtectedAncestor(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("Protected launcher path has an unsafe ancestor");
  }
}

/** Validates every already-existing directory strictly above `path`. */
async function validateAncestorChain(path: string): Promise<void> {
  const root = parse(path).root;
  let current = dirname(path);
  for (;;) {
    await requireProtectedAncestor(current);
    if (current === root) return;
    current = dirname(current);
  }
}

/**
 * Refuses a target the launcher must not repair: a symlink, a non-directory,
 * a non-root owner, or write access beyond what the requested mode grants to
 * the requested group. Only then may ownership and mode be normalized.
 */
async function requireSafeTarget(
  path: string,
  mode: number,
  groupId: number,
): Promise<void> {
  const metadata = await lstat(path);
  const foreignWrite =
    (metadata.mode & 0o022 & ~mode) !== 0 ||
    ((metadata.mode & 0o020) !== 0 && metadata.gid !== groupId);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    foreignWrite
  ) {
    throw new Error("Protected launcher path target is unsafe");
  }
}

async function requireProtectedTarget(
  path: string,
  mode: number,
  groupId: number,
): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== groupId ||
    (metadata.mode & 0o7777) !== mode
  ) {
    throw new Error("Protected launcher directory ownership is invalid");
  }
}

/**
 * Creates only beneath an already protected root-owned ancestor. This keeps a
 * privileged launcher from following or repairing a path controlled by the
 * Runtime identity while preparing ledgers, sockets, or credentials.
 *
 * The `(mode & 0o022)` ancestor rule applies only to directories above the
 * target: the target itself may legitimately be group- or other-writable
 * (for example the 0771 ingress directory), so it is verified against the
 * exact requested mode, owner, and group instead.
 */
export async function prepareProtectedLauncherDirectory(
  path: string,
  mode: number,
  groupId: number,
): Promise<void> {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(existing);
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (existing !== path) await requireProtectedAncestor(existing);
  await validateAncestorChain(existing);

  for (const candidate of missing.reverse()) {
    const isTarget = candidate === path;
    // Create every component without group/other write before assigning the
    // target's final group and mode. Otherwise a permissive launcher umask can
    // create a new 0771 target as root's primary group, which the safety check
    // must (correctly) reject before chown.
    await mkdir(candidate, { mode: 0o700 });
    if (!isTarget) await requireProtectedAncestor(candidate);
  }

  await requireSafeTarget(path, mode, groupId);
  await chown(path, 0, groupId);
  await chmod(path, mode);
  await requireProtectedTarget(path, mode, groupId);
  await validateAncestorChain(path);
}
