import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type McpHttpHandler,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApplicationError } from "../core/errors.js";
import type {
  AgentExecutionService,
  CredentialSubject,
} from "../core/types.js";
import { MCP_PROTOCOL_VERSION } from "./protocol.js";
import {
  applicationErrorSchema,
  cancelTaskInputSchema,
  getExecutionLifecycleInputSchema,
  getExecutionLifecycleSuccessSchema,
  getEventsInputSchema,
  getEventsSuccessSchema,
  getTaskInputSchema,
  getTaskSuccessSchema,
  listAgentsInputSchema,
  listAgentsSuccessSchema,
  listTasksInputSchema,
  listTasksSuccessSchema,
  mutationSuccessSchema,
  submitTaskInputSchema,
} from "./schemas.js";

type ExternalErrorCode =
  | "access_denied"
  | "internal_error"
  | Exclude<ApplicationError["code"], "membership_revoked">;

const ERROR_MESSAGES: Readonly<Record<ExternalErrorCode, string>> = {
  access_denied: "Access denied",
  internal_error: "The requested operation could not be completed",
  invalid_state: "The Task cannot be changed in its current state",
  not_found: "Resource not found",
  observation_unavailable: "The current observation is unavailable",
  operation_conflict: "operationId conflicts with a previous operation",
  queue_capacity: "Task admission capacity is exhausted",
  storage_capacity: "Durable storage admission capacity is exhausted",
  storage_unavailable: "Durable storage is unavailable",
  tombstone_capacity: "Operation receipt capacity is exhausted",
  validation_error: "The request violates configured limits",
};

function result(
  payload: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function success(payload: Record<string, unknown>): CallToolResult {
  return result({ ok: true, ...payload });
}

function publishedInput(
  schema: z.ZodType,
): StandardSchemaWithJSON<unknown, unknown> {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => ({ value }),
    },
  };
}

function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApplicationError(
      "validation_error",
      "The request violates configured limits",
    );
  }
  return parsed.data;
}

function failure(error: unknown, mutation: boolean): CallToolResult {
  const applicationError =
    error instanceof ApplicationError ? error : undefined;
  const code: ExternalErrorCode =
    applicationError === undefined
      ? "internal_error"
      : applicationError.code === "membership_revoked"
        ? "access_denied"
        : applicationError.code;
  const candidate = {
    ok: false,
    error: {
      code,
      message: ERROR_MESSAGES[code],
      retryable: applicationError?.retryable ?? false,
      safeRetry:
        mutation && applicationError?.retryable === true
          ? "same_operation_id"
          : "none",
    },
    ...(applicationError?.task === undefined
      ? {}
      : { task: applicationError.task }),
  };
  const projected = applicationErrorSchema.safeParse(candidate);
  if (projected.success) return result(projected.data, true);
  return result(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: ERROR_MESSAGES.internal_error,
        retryable: false,
        safeRetry: "none",
      },
    },
    true,
  );
}

async function invoke(
  operation: () => Promise<Record<string, unknown>>,
  mutation = false,
): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error, mutation);
  }
}

function invokeInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  operation: (validated: z.output<T>) => Promise<Record<string, unknown>>,
  mutation = false,
): Promise<CallToolResult> {
  return invoke(() => operation(parseInput(schema, input)), mutation);
}

export function createDurableAdmissionMcpHandler(
  service: AgentExecutionService,
): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer(
        { name: "agentport-durable-admission", version: "0.0.0" },
        {
          capabilities: { tools: {} },
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
        },
      );
      const actor: CredentialSubject = {
        principalId: authInfo?.clientId ?? "",
      };

      server.registerTool(
        "agentport_list_agents",
        {
          description: "List Agents currently authorized for this Principal.",
          inputSchema: publishedInput(listAgentsInputSchema),
          outputSchema: listAgentsSuccessSchema,
        },
        (input) =>
          invokeInput(listAgentsInputSchema, input, async (input) => {
            const page = await service.listAgents(actor, {
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });
            return { agents: page.agents, nextCursor: page.nextCursor };
          }),
      );
      server.registerTool(
        "agentport_submit_task",
        {
          description:
            "Durably admit a new queued Task and Context without starting a Runtime.",
          inputSchema: publishedInput(submitTaskInputSchema),
          outputSchema: mutationSuccessSchema,
        },
        (input) =>
          invokeInput(
            submitTaskInputSchema,
            input,
            async (input) => {
              const mutation = await service.submitTask(actor, {
                operationId: input.operationId,
                agentId: input.agentId,
                instruction: input.instruction,
                ...(input.executionLimitSeconds === undefined
                  ? {}
                  : { executionLimitSeconds: input.executionLimitSeconds }),
                ...(input.inputWaitSeconds === undefined
                  ? {}
                  : { inputWaitSeconds: input.inputWaitSeconds }),
              });
              return { task: mutation.task, replayed: mutation.replayed };
            },
            true,
          ),
      );
      server.registerTool(
        "agentport_get_task",
        {
          description: "Read the current committed Task snapshot.",
          inputSchema: publishedInput(getTaskInputSchema),
          outputSchema: getTaskSuccessSchema,
        },
        (input) =>
          invokeInput(getTaskInputSchema, input, async (input) => ({
            task: await service.getTask(actor, input),
          })),
      );
      server.registerTool(
        "agentport_get_execution_lifecycle",
        {
          description:
            "Read the bounded lifecycle of an authorized Execution without dispatching it.",
          inputSchema: publishedInput(getExecutionLifecycleInputSchema),
          outputSchema: getExecutionLifecycleSuccessSchema,
        },
        (input) =>
          invokeInput(
            getExecutionLifecycleInputSchema,
            input,
            async (input) => ({
              lifecycle: await service.getExecutionLifecycle(actor, input),
            }),
          ),
      );
      server.registerTool(
        "agentport_list_tasks",
        {
          description:
            "List committed Task summaries currently authorized for this Principal.",
          inputSchema: publishedInput(listTasksInputSchema),
          outputSchema: listTasksSuccessSchema,
        },
        (input) =>
          invokeInput(listTasksInputSchema, input, async (input) => {
            const page = await service.listTasks(actor, {
              ...(input.agentId === undefined
                ? {}
                : { agentId: input.agentId }),
              ...(input.state === undefined ? {} : { state: input.state }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });
            return { tasks: page.tasks, nextCursor: page.nextCursor };
          }),
      );
      server.registerTool(
        "agentport_get_events",
        {
          description:
            "Read committed Task events without waiting for new events.",
          inputSchema: publishedInput(getEventsInputSchema),
          outputSchema: getEventsSuccessSchema,
        },
        (input) =>
          invokeInput(getEventsInputSchema, input, async (input) => {
            const page = await service.getEvents(actor, {
              ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
              ...(input.afterCursor === undefined
                ? {}
                : { afterCursor: input.afterCursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });
            return { events: page.events, nextCursor: page.nextCursor };
          }),
      );
      server.registerTool(
        "agentport_cancel_task",
        {
          description:
            "Durably cancel a queued or restart-paused Task without Runtime activity.",
          inputSchema: publishedInput(cancelTaskInputSchema),
          outputSchema: mutationSuccessSchema,
        },
        (input) =>
          invokeInput(
            cancelTaskInputSchema,
            input,
            async (input) => {
              const mutation = await service.cancelTask(actor, input);
              return { task: mutation.task, replayed: mutation.replayed };
            },
            true,
          ),
      );

      return server;
    },
    { legacy: "reject", responseMode: "json" },
  );
}
