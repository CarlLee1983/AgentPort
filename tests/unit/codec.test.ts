import { describe, expect, it } from "vitest";

import { CursorCodec, operationFingerprint } from "../../src/core/codec.js";

describe("durable-admission codecs", () => {
  it("canonicalizes operation inputs before fingerprinting", () => {
    expect(operationFingerprint({ operation: "submit", value: 1 })).toBe(
      operationFingerprint({ value: 1, operation: "submit" }),
    );
    expect(operationFingerprint({ operation: "submit", value: 1 })).not.toBe(
      operationFingerprint({ operation: "cancel", value: 1 }),
    );
  });

  it("binds opaque cursors to a protected signature", () => {
    const codec = new CursorCodec("ap002-cursor-secret");
    const payload = { scope: "scope-a", position: 3 };
    const cursor = codec.encode(payload);
    expect(codec.decode(cursor)).toEqual({ position: 3, scope: "scope-a" });
    expect(codec.encodedLength(payload)).toBe(cursor.length);
    expect(() => codec.decode(`${cursor}tampered`)).toThrow(
      "Resource not found",
    );
  });
});
