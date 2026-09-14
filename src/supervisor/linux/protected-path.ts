import { chmod, chown, lstat, mkdir } from "node:fs/promises";
import { dirname, parse } from "node:path";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function requireProtectedDirectory(path: string): Promise<void> {
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

async function validateExistingChain(path: string): Promise<void> {
  const root = parse(path).root;
  let current = path;
  for (;;) {
    await requireProtectedDirectory(current);
    if (current === root) return;
    current = dirname(current);
  }
}

/**
 * Creates only beneath an already protected root-owned ancestor. This keeps a
 * privileged launcher from following or repairing a path controlled by the
 * Runtime identity while preparing ledgers, sockets, or credentials.
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
  await validateExistingChain(existing);

  for (const candidate of missing.reverse()) {
    await mkdir(candidate, { mode: candidate === path ? mode : 0o700 });
    await requireProtectedDirectory(candidate);
  }

  await requireProtectedDirectory(path);
  await chown(path, 0, groupId);
  await chmod(path, mode);
  const after = await lstat(path);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.uid !== 0 ||
    after.gid !== groupId ||
    (after.mode & 0o777) !== mode
  ) {
    throw new Error("Protected launcher directory ownership is invalid");
  }
  await validateExistingChain(path);
}
