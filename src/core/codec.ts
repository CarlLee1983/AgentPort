import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ApplicationError } from "./errors.js";

type JsonPrimitive = boolean | null | number | string;
export type CanonicalValue =
  | JsonPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const values = value as readonly CanonicalValue[];
    return `[${values.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(
      (entry): entry is [string, CanonicalValue] => entry[1] !== undefined,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

export function operationFingerprint(value: CanonicalValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

interface CursorEnvelope {
  payload: string;
  signature: string;
}

export class CursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length < 16)
      throw new Error("Cursor secret must contain at least 16 characters");
  }

  encode(value: CanonicalValue): string {
    const payload = Buffer.from(canonicalize(value)).toString("base64url");
    const signature = this.sign(payload);
    return this.#encodeEnvelope({ payload, signature });
  }

  /** Projects an opaque cursor's final byte length without sealing it. */
  encodedLength(value: CanonicalValue): number {
    const payload = Buffer.from(canonicalize(value)).toString("base64url");
    return this.#encodeEnvelope({
      payload,
      signature: "0".repeat(64),
    }).length;
  }

  decode(cursor: string): unknown {
    try {
      const envelope = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as CursorEnvelope;
      if (
        typeof envelope.payload !== "string" ||
        typeof envelope.signature !== "string"
      ) {
        throw new Error("Invalid cursor envelope");
      }
      const expected = Buffer.from(this.sign(envelope.payload), "hex");
      const actual = Buffer.from(envelope.signature, "hex");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new Error("Invalid cursor signature");
      }
      return JSON.parse(
        Buffer.from(envelope.payload, "base64url").toString("utf8"),
      ) as unknown;
    } catch (error) {
      throw new ApplicationError("not_found", "Resource not found", {
        cause: error,
      });
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }

  #encodeEnvelope(envelope: CursorEnvelope): string {
    return Buffer.from(JSON.stringify(envelope)).toString("base64url");
  }
}
