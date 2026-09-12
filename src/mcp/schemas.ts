import { z } from "zod";
import {
  MAX_IDENTIFIER_CHARACTERS,
  MAX_INSTRUCTION_BYTES,
} from "../core/types.js";

const identifier = z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS);
const pageLimit = z.number().int().min(1).max(100);
const taskState = z.enum(["queued", "paused", "canceled"]);
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
    agentId: z.string(),
    state: taskState,
    reason: z.string().nullable(),
    revision: z.number().int(),
    queueOrder: z.number().int(),
    executionLimitSeconds: z.number().int().nullable(),
    inputWaitSeconds: z.number().int().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const taskSnapshotSchema = taskSummarySchema
  .extend({
    instruction: z.string(),
    observedAt: z.string(),
    observationStatus: z.enum(["current", "stale"]),
  })
  .strict();

const taskEventSchema = z
  .object({
    cursor: z.number().int(),
    taskId: z.string(),
    taskSeq: z.number().int(),
    agentId: z.string(),
    type: z.enum(["accepted", "daemon_restart_paused", "canceled"]),
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
