import { createHash } from "node:crypto";

import type { ExecutionReference } from "../../core/types.js";

const MAX_PROTECTED_SESSION_TOKEN_BYTES = 512;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function executionBinding(reference: ExecutionReference): string {
  return JSON.stringify([
    reference.executionId,
    reference.generation,
    reference.daemonEpoch,
    reference.launchProfileId,
    reference.workspaceIdentity,
  ]);
}

function executionDigest(reference: ExecutionReference): string {
  return digest(executionBinding(reference));
}

export function sessionReferenceFor(
  reference: ExecutionReference,
  rawSessionId: string,
): string {
  return `g1s-${executionDigest(reference)}-${digest(`session:${rawSessionId}`)}`;
}

export function isSessionReferenceFor(
  value: unknown,
  reference: ExecutionReference,
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^g1s-${executionDigest(reference)}-[a-f0-9]{64}$`, "u").test(
      value,
    )
  );
}

export function isProtectedClaudeSessionToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PROTECTED_SESSION_TOKEN_BYTES &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}
