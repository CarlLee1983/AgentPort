import { randomUUID } from "node:crypto";

import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ExecutionReference,
  RuntimeQuestionIdentity,
} from "../../core/types.js";
import {
  isProtectedClaudeSessionToken,
  isSessionReferenceFor,
  sessionReferenceFor,
} from "./session-reference.js";

export { isProtectedClaudeSessionToken } from "./session-reference.js";

const MAX_RESULT_BYTES = 32 * 1024;
const MAX_SESSION_REFERENCE_BYTES = 512;

export interface ClaudeStructuredResult {
  answer: string;
  sessionReference: string;
  /**
   * Raw vendor session identity. This is deliberately available only to the
   * protected worker-to-core path; it must never enter MCP, event, receipt,
   * observation JSON, or a process argument/environment.
   */
  protectedSessionToken?: string;
  executionReference: ExecutionReference;
}

export interface ClaudeQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface ClaudeQuestion {
  question: string;
  header: string;
  options: readonly ClaudeQuestionOption[];
  multiSelect: boolean;
}

export interface ClaudeQuestionRequest extends RuntimeQuestionIdentity {
  toolActivity: "none";
  questions: readonly ClaudeQuestion[];
}

export interface ClaudeQuestionAnswer {
  questionId: string;
  toolUseId: string;
  requestId: string;
  answers: Readonly<Record<string, string>>;
}

export interface ClaudeQuestionExchange {
  request: ClaudeQuestionRequest;
  answer: ClaudeQuestionAnswer;
}

export interface ClaudeQuestionTrace extends ClaudeStructuredResult {
  exchanges: readonly ClaudeQuestionExchange[];
  eventOrder: readonly string[];
}

export interface ClaudeDriverOptions {
  reference: ExecutionReference;
  cwd: string;
  pathToClaudeCodeExecutable?: string;
  abortController?: AbortController;
  environment?: Record<string, string | undefined>;
  /** Supplied only from a protected per-unit credential. */
  resumeSessionToken?: string;
  /** Explicit bounded summary for a fresh Session; never interpreted as a resume token. */
  freshContextSummary?: string;
}

function sameExecutionReference(
  left: ExecutionReference,
  right: ExecutionReference,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.generation === right.generation &&
    left.daemonEpoch === right.daemonEpoch &&
    left.launchProfileId === right.launchProfileId &&
    left.workspaceIdentity === right.workspaceIdentity
  );
}

function sessionReferenceFrom(
  rawSessionId: unknown,
  executionReference: ExecutionReference,
): string {
  if (
    typeof rawSessionId !== "string" ||
    rawSessionId.length === 0 ||
    !bounded(rawSessionId, MAX_SESSION_REFERENCE_BYTES)
  ) {
    throw new Error("Claude returned an invalid Session reference");
  }
  return sessionReferenceFor(executionReference, rawSessionId);
}

export function protectedSessionTokenForExecution(
  result: ClaudeStructuredResult,
  executionReference: ExecutionReference,
): string {
  if (!sameExecutionReference(result.executionReference, executionReference)) {
    throw new Error("Claude Session token does not belong to this execution");
  }
  if (!isProtectedClaudeSessionToken(result.protectedSessionToken)) {
    throw new Error("Claude returned an invalid protected Session token");
  }
  if (
    result.sessionReference !==
    sessionReferenceFor(executionReference, result.protectedSessionToken)
  ) {
    throw new Error("Claude Session token does not match its reference");
  }
  return result.protectedSessionToken;
}

export function sessionReferenceForExecution(
  result: ClaudeStructuredResult,
  executionReference: ExecutionReference,
): string {
  if (!sameExecutionReference(result.executionReference, executionReference)) {
    throw new Error(
      "Claude Session reference does not belong to this execution",
    );
  }
  if (!isSessionReferenceFor(result.sessionReference, executionReference)) {
    throw new Error("Claude returned an invalid Session reference");
  }
  return result.sessionReference;
}

const CLAUDE_ENVIRONMENT_ALLOWLIST = [
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LOGNAME",
  "PATH",
  "USER",
] as const;

export function createClaudeWorkerEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {
    CLAUDE_AGENT_SDK_CLIENT_APP: "agentport-g1/0.0.0",
  };
  for (const name of CLAUDE_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function bounded(value: string, maximumBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commonOptions(options: ClaudeDriverOptions): Options {
  return {
    cwd: options.cwd,
    settingSources: [],
    // A continuation is resumed only from a one-time systemd credential; the
    // session database stays inside the separately protected Runtime home.
    persistSession: true,
    maxTurns: 4,
    maxBudgetUsd: 0.25,
    ...(options.abortController === undefined
      ? {}
      : { abortController: options.abortController }),
    env: createClaudeWorkerEnvironment(options.environment ?? process.env),
    ...(options.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
    ...(options.resumeSessionToken === undefined
      ? {}
      : { resume: options.resumeSessionToken }),
  };
}

function resultFrom(
  message: SDKResultMessage,
  executionReference: ExecutionReference,
  expectedAnswer: string,
): ClaudeStructuredResult {
  if (
    message.subtype !== "success" ||
    message.is_error ||
    typeof message.structured_output !== "object" ||
    message.structured_output === null ||
    Array.isArray(message.structured_output)
  ) {
    throw new Error("Claude did not return a successful structured result");
  }
  const answer = (message.structured_output as Record<string, unknown>)[
    "answer"
  ];
  if (
    typeof answer !== "string" ||
    answer !== expectedAnswer ||
    !bounded(answer, MAX_RESULT_BYTES)
  ) {
    throw new Error("Claude returned an invalid bounded result");
  }
  const protectedSessionToken = isProtectedClaudeSessionToken(
    message.session_id,
  )
    ? message.session_id
    : undefined;
  return {
    answer: expectedAnswer,
    sessionReference: sessionReferenceFrom(
      message.session_id,
      executionReference,
    ),
    ...(protectedSessionToken === undefined ? {} : { protectedSessionToken }),
    executionReference,
  };
}

async function lastSuccessfulResult(
  operation: ReturnType<typeof query>,
  executionReference: ExecutionReference,
  expectedAnswer: string,
): Promise<ClaudeStructuredResult> {
  let result: ClaudeStructuredResult | undefined;
  for await (const message of operation) {
    if (message.type === "result") {
      result = resultFrom(message, executionReference, expectedAnswer);
      return result;
    }
  }
  if (result === undefined) throw new Error("Claude returned no result");
  return result;
}

function streamingPrompt(
  prompt: string,
  signal: AbortSignal | undefined,
): { input: AsyncIterable<SDKUserMessage>; close: () => void } {
  let closeInput: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closeInput = resolve;
  });
  const close = (): void => {
    signal?.removeEventListener("abort", close);
    closeInput();
  };
  signal?.addEventListener("abort", close, { once: true });
  return {
    input: {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
        };
        await closed;
      },
    },
    close,
  };
}

async function runStreamingQuery(
  options: ClaudeDriverOptions,
  prompt: string,
  sdkOptions: Options,
  expectedAnswer: string,
): Promise<ClaudeStructuredResult> {
  const effectivePrompt =
    options.freshContextSummary === undefined
      ? prompt
      : `Caller-provided context summary for this explicitly fresh Session:\n${options.freshContextSummary}\n\n${prompt}`;
  const stream = streamingPrompt(
    effectivePrompt,
    options.abortController?.signal,
  );
  try {
    return await lastSuccessfulResult(
      query({ prompt: stream.input, options: sdkOptions }),
      options.reference,
      expectedAnswer,
    );
  } finally {
    stream.close();
  }
}

const outputFormat = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string", minLength: 1 } },
  },
};

export function runStructuredClaudeQuery(
  options: ClaudeDriverOptions,
  prompt: string,
  expectedAnswer: string,
): Promise<ClaudeStructuredResult> {
  return runStreamingQuery(
    options,
    prompt,
    {
      ...commonOptions(options),
      tools: [],
      permissionMode: "dontAsk",
      outputFormat,
    },
    expectedAnswer,
  );
}

function normalizedQuestions(value: unknown): ClaudeQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    return undefined;
  }
  const questions: ClaudeQuestion[] = [];
  for (const candidate of value as unknown[]) {
    if (!isRecord(candidate)) return undefined;
    const question = candidate["question"];
    const header = candidate["header"];
    const options = candidate["options"];
    const multiSelect = candidate["multiSelect"];
    if (
      typeof question !== "string" ||
      question.length === 0 ||
      !bounded(question, 4096) ||
      questions.some((existing) => existing.question === question) ||
      typeof header !== "string" ||
      header.length === 0 ||
      header.length > 12 ||
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > 4 ||
      typeof multiSelect !== "boolean"
    ) {
      return undefined;
    }
    const normalizedOptions: ClaudeQuestionOption[] = [];
    for (const option of options as unknown[]) {
      if (!isRecord(option)) return undefined;
      const label = option["label"];
      const description = option["description"];
      const preview = option["preview"];
      if (
        typeof label !== "string" ||
        label.length === 0 ||
        !bounded(label, 128) ||
        normalizedOptions.some((existing) => existing.label === label) ||
        typeof description !== "string" ||
        description.length === 0 ||
        !bounded(description, 1024) ||
        !(
          preview === undefined ||
          (typeof preview === "string" && bounded(preview, 4096))
        )
      ) {
        return undefined;
      }
      normalizedOptions.push({
        label,
        description,
        ...(preview === undefined ? {} : { preview }),
      });
    }
    questions.push({
      question,
      header,
      options: normalizedOptions,
      multiSelect,
    });
  }
  return bounded(JSON.stringify(questions), 32 * 1024) ? questions : undefined;
}

function validBoundAnswer(
  request: ClaudeQuestionRequest,
  value: ClaudeQuestionAnswer,
): boolean {
  if (
    value.questionId !== request.questionId ||
    value.toolUseId !== request.toolUseId ||
    value.requestId !== request.requestId ||
    !isRecord(value.answers)
  ) {
    return false;
  }
  const expected = request.questions.map((question) => question.question);
  const actual = Object.keys(value.answers);
  return (
    actual.length === expected.length &&
    expected.every((question) => {
      const answer = value.answers[question];
      return (
        actual.includes(question) &&
        typeof answer === "string" &&
        answer.length > 0 &&
        bounded(answer, 4096)
      );
    })
  );
}

export async function runClaudeQuestionCapability(
  options: ClaudeDriverOptions,
  prompt: string,
  expectedAnswer: string,
  answerQuestion: (
    request: ClaudeQuestionRequest,
    context: { signal: AbortSignal },
  ) => Promise<ClaudeQuestionAnswer>,
  acknowledgeQuestionDelivery: (
    request: ClaudeQuestionRequest,
  ) => Promise<void> = () => Promise.resolve(),
): Promise<ClaudeQuestionTrace> {
  const state: {
    exchanges: ClaudeQuestionExchange[];
    pendingExchange: ClaudeQuestionExchange | undefined;
    permissionRequestActive: boolean;
    unexpectedToolCallbackObserved: boolean;
  } = {
    exchanges: [],
    pendingExchange: undefined,
    permissionRequestActive: false,
    unexpectedToolCallbackObserved: false,
  };
  const canUseTool: CanUseTool = async (toolName, input, callback) => {
    if (toolName !== "AskUserQuestion" || state.exchanges.length > 0) {
      state.unexpectedToolCallbackObserved = true;
      return { behavior: "deny", message: "Unsupported tool request" };
    }
    if (state.permissionRequestActive) {
      state.unexpectedToolCallbackObserved = true;
      return { behavior: "deny", message: "Concurrent tool activity" };
    }
    const unknownInput: unknown = input;
    if (!isRecord(unknownInput)) {
      return { behavior: "deny", message: "Invalid question request" };
    }
    const questions = normalizedQuestions(unknownInput["questions"]);
    if (
      questions === undefined ||
      !boundedIdentifier(callback.requestId) ||
      !boundedIdentifier(callback.toolUseID)
    ) {
      return { behavior: "deny", message: "Invalid question request" };
    }
    state.permissionRequestActive = true;
    try {
      const request: ClaudeQuestionRequest = {
        questionId: randomUUID(),
        toolUseId: callback.toolUseID,
        requestId: callback.requestId,
        toolActivity: "none",
        questions,
      };
      const answer = await answerQuestion(request, {
        signal: callback.signal,
      });
      if (!validBoundAnswer(request, answer)) {
        return { behavior: "deny", message: "Invalid question answer" };
      }
      state.pendingExchange = { request, answer };
      return {
        behavior: "allow",
        updatedInput: {
          ...unknownInput,
          answers: answer.answers,
        },
        toolUseID: callback.toolUseID,
      };
    } finally {
      state.permissionRequestActive = false;
    }
  };
  const acknowledgeConsumedQuestion: HookCallback = async (
    input,
    toolUseId,
  ) => {
    const exchange = state.pendingExchange;
    if (
      input.hook_event_name !== "PostToolUse" ||
      input.tool_name !== "AskUserQuestion" ||
      exchange === undefined ||
      input.tool_use_id !== exchange.request.toolUseId ||
      toolUseId !== exchange.request.toolUseId
    ) {
      state.unexpectedToolCallbackObserved = true;
      throw new Error("Invalid native question delivery confirmation");
    }
    await acknowledgeQuestionDelivery(exchange.request);
    state.exchanges.push(exchange);
    state.pendingExchange = undefined;
    return { continue: true };
  };

  const result = await runStreamingQuery(
    options,
    prompt,
    {
      ...commonOptions(options),
      tools: ["AskUserQuestion"],
      permissionMode: "default",
      canUseTool,
      hooks: {
        PostToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [acknowledgeConsumedQuestion],
          },
        ],
      },
      outputFormat,
    },
    expectedAnswer,
  );
  if (
    state.exchanges.length !== 1 ||
    state.pendingExchange !== undefined ||
    state.permissionRequestActive ||
    state.unexpectedToolCallbackObserved
  ) {
    throw new Error("Claude did not complete one native question exchange");
  }
  return {
    ...result,
    exchanges: state.exchanges,
    eventOrder: ["question", "answer", "result"],
  };
}
