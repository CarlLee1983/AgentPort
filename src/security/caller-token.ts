import { createHash, randomBytes } from "node:crypto";

/** Versioned, non-reversible representation used in protected configuration. */
export const CALLER_TOKEN_HASH_PATTERN = /^sha256:v1:[0-9a-f]{64}$/u;

export function hashCallerToken(token: string): string {
  return `sha256:v1:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Generates a bearer token with 256 bits of entropy for one-shot display. */
export function generateCallerToken(): string {
  return `ap_${randomBytes(32).toString("base64url")}`;
}

export function isCallerTokenHash(value: string): boolean {
  return CALLER_TOKEN_HASH_PATTERN.test(value);
}
