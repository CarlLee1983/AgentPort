import { z } from "zod";
import {
  MAX_CONTEXT_SUMMARY_BYTES,
  MAX_IDENTIFIER_CHARACTERS,
  MAX_INSTRUCTION_BYTES,
} from "../core/types.js";

const identifier = z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS);
const pageLimit = z.number().int().min(1).max(100);
const taskState = z.enum([
  "queued",
  "paused",
  "starting",
  "running",
  "awaiting_input",
  "stopping",
  "completed",
  "failed",
  "canceled",
  "recovering",
  "interrupted",
]);
const instruction = z
  .string()
  .min(1)
  .max(MAX_INSTRUCTION_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INSTRUCTION_BYTES);

export const listAgentsInputSchema = z
  .object({ cursor: z.string().min(1).optional(), limit: pageLimit.optional() })
  .strict();

export const submitTaskInputSchema = z
  .object({
    operationId: identifier,
    agentId: identifier,
    instruction,
    contextId: identifier.optional(),
    executionLimitSeconds: z.number().int().positive().optional(),
    inputWaitSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const getTaskInputSchema = z.object({ taskId: identifier }).strict();

export const listTasksInputSchema = z
  .object({
    agentId: identifier.optional(),
    state: taskState.optional(),
    cursor: z.string().min(1).optional(),
    limit: pageLimit.optional(),
  })
  .strict();

export const getEventsInputSchema = z
  .object({
    taskId: identifier.optional(),
    afterCursor: z.string().min(1).optional(),
    limit: pageLimit.optional(),
  })
  .strict();

export const cancelTaskInputSchema = z
  .object({ operationId: identifier, taskId: identifier })
  .strict();

export const editTaskInputSchema = z
  .object({
    operationId: identifier,
    taskId: identifier,
    expectedRevision: z.number().int().positive(),
    instruction,
  })
  .strict();

export const replyInputSchema = z
  .object({
    operationId: identifier,
    taskId: identifier,
    questionId: identifier,
    answer: z.record(z.string().min(1).max(4096), z.string().min(1).max(1024)),
  })
  .strict();

export const resumeContextInputSchema = z
  .object({
    operationId: identifier,
    contextId: identifier,
    expectedRevision: z.number().int().positive(),
    continuationMode: z.enum(["preserve", "fresh_session"]),
    contextSummary: z
      .string()
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_SUMMARY_BYTES,
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasSummary = Object.hasOwn(value, "contextSummary");
    if (
      (value.continuationMode === "preserve" && hasSummary) ||
      (value.continuationMode === "fresh_session" && !hasSummary)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "fresh_session requires contextSummary and preserve forbids it",
      });
    }
  });

export const acknowledgeInterruptionInputSchema = z
  .object({
    operationId: identifier,
    taskId: identifier,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

const agentSchema = z
  .object({
    agentId: z.string(),
    description: z.string(),
    availability: z.literal("available"),
    capabilities: z.tuple([
      z.literal("durable_admission"),
      z.literal("queued_cancellation"),
    ]),
  })
  .strict();

const taskSummarySchema = z
  .object({
    taskId: z.string(),
    contextId: z.string(),
    contextRevision: z.number().int().positive(),
    predecessorTaskId: z.string().nullable(),
    blocker: z
      .object({
        predecessorTaskId: z.string(),
        state: z.enum(["failed", "canceled", "interrupted", "recovering"]),
      })
      .strict()
      .nullable(),
    continuation: z
      .object({
        mode: z.enum(["preserve", "fresh_session"]),
        nativeContinuity: z.enum(["preserved", "abandoned"]),
      })
      .strict()
      .nullable(),
    agentId: z.string(),
    state: taskState,
    reason: z.string().nullable(),
    revision: z.number().int(),
    queueOrder: z.number().int(),
    executionLimitSeconds: z.number().int().nullable(),
    inputWaitSeconds: z.number().int().nullable(),
    result: z
      .object({
        kind: z.enum(["completed", "failed", "canceled"]),
        summary: z.string().nullable(),
      })
      .strict()
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const executionLifecycleSnapshotSchema = z
  .object({
    executionId: z.string(),
    taskId: z.string(),
    state: z.enum([
      "prepared",
      "starting",
      "running",
      "stopping",
      "recovering",
      "interrupted",
    ]),
    progress: z
      .object({
        ordinal: z.number().int(),
        summary: z.string(),
        observedAt: z.string(),
      })
      .strict()
      .nullable(),
    lastObservationOrdinal: z.number().int(),
    candidateAvailable: z.boolean(),
    finalOrdinal: z.number().int().nullable(),
    stopReason: z
      .enum(["completion", "cancellation", "interruption"])
      .nullable(),
    recoveryReason: z.string().nullable(),
    accumulatedExecutionMs: z.number().int().nonnegative(),
    accountingPhase: z.enum(["active", "pure_wait", "stopped"]),
    accountingPhaseStartedAt: z.string().nullable(),
    quarantined: z.boolean(),
    revision: z.number().int(),
    observedAt: z.string(),
  })
  .strict();

export const taskSnapshotSchema = taskSummarySchema
  .extend({
    instruction: z.string(),
    observedAt: z.string(),
    observationStatus: z.enum(["current", "stale"]),
    executionLiveness: z.enum(["alive", "dead", "unknown"]),
    livenessCheckedAt: z.string().nullable(),
    toolActivityStatus: z.enum(["active", "idle", "unknown"]),
    toolActivityObservedAt: z.string().nullable(),
    toolActivityEvidence: z
      .object({ toolName: z.string(), startedAt: z.string() })
      .strict()
      .nullable(),
    execution: executionLifecycleSnapshotSchema.nullable(),
    question: z
      .object({
        questionId: z.string(),
        schema: z.array(
          z
            .object({
              question: z.string(),
              header: z.string(),
              options: z.array(
                z
                  .object({
                    label: z.string(),
                    description: z.string(),
                    preview: z.string().optional(),
                  })
                  .strict(),
              ),
              multiSelect: z.boolean(),
            })
            .strict(),
        ),
        state: z.enum(["pending", "accepted", "closed"]),
        delivery: z.enum(["pending", "acknowledged", "unknown"]),
        answer: z.record(z.string(), z.string()).nullable(),
        acceptedAt: z.string().nullable(),
        expiresAt: z.string(),
        deliveryAcknowledgedAt: z.string().nullable(),
        deliveryUnknownAt: z.string().nullable(),
        inputExpiryClosedAt: z.string().nullable(),
        closedAt: z.string().nullable(),
        closureReason: z
          .enum(["expired", "canceled", "recovery", "terminal"])
          .nullable(),
        createdAt: z.string(),
      })
      .strict()
      .nullable(),
    readiness: z
      .object({
        status: z.literal("blocked"),
        reason: z.literal("g1_unproven"),
      })
      .strict(),
  })
  .strict();

const taskEventSchema = z
  .object({
    cursor: z.number().int(),
    taskId: z.string(),
    taskSeq: z.number().int(),
    agentId: z.string(),
    type: z.enum([
      "accepted",
      "edited",
      "daemon_restart_paused",
      "cancel_requested",
      "completed",
      "failed",
      "canceled",
      "interrupted",
    ]),
    taskRevision: z.number().int(),
    occurredAt: z.string(),
  })
  .strict();

export const applicationErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum([
          "access_denied",
          "not_found",
          "result_expired",
          "cursor_expired",
          "operation_conflict",
          "invalid_state",
          "queue_capacity",
          "tombstone_capacity",
          "storage_capacity",
          "storage_unavailable",
          "observation_unavailable",
          "validation_error",
          "internal_error",
        ]),
        message: z.string(),
        retryable: z.boolean(),
        safeRetry: z.enum(["none", "same_operation_id"]),
      })
      .strict(),
    task: taskSnapshotSchema.optional(),
  })
  .strict();

export const listAgentsSuccessSchema = z
  .object({
    ok: z.literal(true),
    agents: z.array(agentSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const mutationSuccessSchema = z
  .object({
    ok: z.literal(true),
    task: taskSnapshotSchema,
    replayed: z.boolean(),
  })
  .strict();

export const getTaskSuccessSchema = z
  .object({ ok: z.literal(true), task: taskSnapshotSchema })
  .strict();

export const listTasksSuccessSchema = z
  .object({
    ok: z.literal(true),
    tasks: z.array(taskSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const getEventsSuccessSchema = z
  .object({
    ok: z.literal(true),
    events: z.array(taskEventSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
