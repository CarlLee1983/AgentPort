import type { TaskSnapshot } from "./types.js";

export type ApplicationErrorCode =
  | "membership_revoked"
  | "not_found"
  | "result_expired"
  | "cursor_expired"
  | "operation_conflict"
  | "invalid_state"
  | "queue_capacity"
  | "tombstone_capacity"
  | "storage_capacity"
  | "storage_unavailable"
  | "observation_unavailable"
  | "validation_error";

const RETRYABLE_CODES = new Set<ApplicationErrorCode>([
  "storage_unavailable",
  "observation_unavailable",
]);

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly retryable: boolean;
  readonly task?: TaskSnapshot;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: { cause?: unknown; task?: TaskSnapshot } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    if (options.task !== undefined) this.task = options.task;
  }
}
