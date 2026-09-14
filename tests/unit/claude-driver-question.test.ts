import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionReference } from "../../src/core/types.js";

type QueryInput = Parameters<
  typeof import("@anthropic-ai/claude-agent-sdk").query
>[0];
type QueryOperation = AsyncIterable<unknown>;

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(input: QueryInput) => QueryOperation>(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

import {
  runClaudeQuestionCapability,
  runStructuredClaudeQuery,
  type ClaudeQuestionAnswer,
  type ClaudeQuestionRequest,
} from "../../src/runtime/claude/driver.js";

const reference: ExecutionReference = {
  executionId: "execution-claude-driver",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "g1-claude-question",
  workspaceIdentity: "g1-workspace",
};
const options = { reference, cwd: "/workspace" };
const nativeQuestions = [
  {
    question: "Which color should be used?",
    header: "Color",
    options: [
      { label: "Blue", description: "Use the blue option" },
      { label: "Red", description: "Use the red option" },
    ],
    multiSelect: false,
  },
  {
    question: "Which styles should be enabled?",
    header: "Style",
    options: [
      {
        label: "Concise",
        description: "Prefer short output",
        preview: "short",
      },
      { label: "Detailed", description: "Prefer detailed output" },
    ],
    multiSelect: true,
  },
];

function successfulResult(answer: string) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { answer },
    session_id: "session-claude-driver",
  };
}

async function firstStreamMessage(
  prompt: QueryInput["prompt"],
): Promise<unknown> {
  if (typeof prompt === "string") {
    throw new Error("Expected streaming Claude input");
  }
  return (await prompt[Symbol.asyncIterator]().next()).value;
}

function requiredCanUseTool(options: QueryInput["options"]) {
  const canUseTool = options?.canUseTool;
  if (canUseTool === undefined) throw new Error("Missing canUseTool callback");
  return canUseTool;
}

function requiredPostToolUse(options: QueryInput["options"]) {
  const hook = options?.hooks?.PostToolUse?.[0]?.hooks[0];
  if (hook === undefined) throw new Error("Missing PostToolUse hook");
  return hook;
}

function postToolUseInput(toolUseId: string) {
  return {
    hook_event_name: "PostToolUse" as const,
    tool_name: "AskUserQuestion",
    tool_input: { questions: nativeQuestions },
    tool_response: { answers: {} },
    tool_use_id: toolUseId,
    session_id: "session-claude-driver",
    transcript_path: "/protected/transcript.jsonl",
    cwd: "/workspace",
  };
}

describe("Claude Driver streaming question contract", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("uses streaming input and a resumable protected Session for a structured query", async () => {
    let streamedMessage: unknown;
    let sdkOptions: QueryInput["options"];
    queryMock.mockImplementation(({ prompt, options }) => ({
      async *[Symbol.asyncIterator]() {
        sdkOptions = options;
        streamedMessage = await firstStreamMessage(prompt);
        yield successfulResult("AGENTPORT_G1_OK");
      },
    }));

    const result = await runStructuredClaudeQuery(
      options,
      "Return a structured result",
      "AGENTPORT_G1_OK",
    );
    expect(result).toMatchObject({
      answer: "AGENTPORT_G1_OK",
      executionReference: reference,
    });
    expect(result.sessionReference).toMatch(/^g1s-[a-f0-9]{64}-[a-f0-9]{64}$/u);
    expect(result.sessionReference).not.toContain("session-claude-driver");
    expect(result.protectedSessionToken).toBe("session-claude-driver");
    expect(sdkOptions).toMatchObject({ persistSession: true });
    expect(streamedMessage).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: "Return a structured result" },
    });
  });

  it("passes a protected resume token only as the SDK resume option", async () => {
    let sdkOptions: QueryInput["options"];
    queryMock.mockImplementation(({ prompt, options }) => ({
      async *[Symbol.asyncIterator]() {
        sdkOptions = options;
        await firstStreamMessage(prompt);
        yield successfulResult("AGENTPORT_G1_OK");
      },
    }));

    await runStructuredClaudeQuery(
      { ...options, resumeSessionToken: "session-prior-claude" },
      "Return a structured result",
      "AGENTPORT_G1_OK",
    );
    expect(sdkOptions).toMatchObject({
      resume: "session-prior-claude",
      persistSession: true,
    });
    expect(sdkOptions?.env).not.toHaveProperty("CLAUDE_SESSION_TOKEN");
  });

  it("starts an explicit fresh Session with only the Caller-provided summary", async () => {
    let streamedMessage: unknown;
    let sdkOptions: QueryInput["options"];
    queryMock.mockImplementation(({ prompt, options: queryOptions }) => ({
      async *[Symbol.asyncIterator]() {
        sdkOptions = queryOptions;
        streamedMessage = await firstStreamMessage(prompt);
        yield successfulResult("AGENTPORT_G1_OK");
      },
    }));

    await runStructuredClaudeQuery(
      { ...options, freshContextSummary: "Decision: continue with blue." },
      "Return a structured result",
      "AGENTPORT_G1_OK",
    );

    expect(sdkOptions?.resume).toBeUndefined();
    expect(streamedMessage).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content:
          "Caller-provided context summary for this explicitly fresh Session:\nDecision: continue with blue.\n\nReturn a structured result",
      },
    });
  });

  it("rejects unexpected model output without reflecting it in the error", async () => {
    const marker = "credential-shaped-model-output";
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield successfulResult(marker);
      },
    }));

    const operation = runStructuredClaudeQuery(
      options,
      "Return a structured result",
      "AGENTPORT_G1_OK",
    );
    await expect(operation).rejects.toThrow(
      "Claude returned an invalid bounded result",
    );
    await operation.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(marker);
    });
  });

  it("preserves one native multi-question collection and answers it once", async () => {
    let permissionResult: unknown;
    queryMock.mockImplementation(({ prompt, options: sdkOptions }) => ({
      async *[Symbol.asyncIterator]() {
        await firstStreamMessage(prompt);
        permissionResult = await requiredCanUseTool(sdkOptions)(
          "AskUserQuestion",
          { questions: nativeQuestions },
          {
            signal: new AbortController().signal,
            requestId: "request-native-1",
            toolUseID: "tool-native-1",
          },
        );
        await requiredPostToolUse(sdkOptions)(
          postToolUseInput("tool-native-1"),
          "tool-native-1",
          { signal: new AbortController().signal },
        );
        yield successfulResult("AGENTPORT_G1_QUESTION_OK");
      },
    }));
    const answerBridge = vi.fn((request: ClaudeQuestionRequest) =>
      Promise.resolve<ClaudeQuestionAnswer>({
        questionId: request.questionId,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        answers: {
          "Which color should be used?": "Blue",
          "Which styles should be enabled?": "Concise, Detailed",
        },
      }),
    );

    const result = await runClaudeQuestionCapability(
      options,
      "Ask two questions",
      "AGENTPORT_G1_QUESTION_OK",
      answerBridge,
    );

    expect(answerBridge).toHaveBeenCalledTimes(1);
    const call = answerBridge.mock.calls[0];
    expect(call?.[0]).toMatchObject({
      requestId: "request-native-1",
      toolUseId: "tool-native-1",
      toolActivity: "none",
      questions: nativeQuestions,
    });
    expect(call?.[0]?.questionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(call?.[0]?.questionId).not.toBe(call?.[0]?.requestId);
    expect(permissionResult).toEqual({
      behavior: "allow",
      toolUseID: "tool-native-1",
      updatedInput: {
        questions: nativeQuestions,
        answers: {
          "Which color should be used?": "Blue",
          "Which styles should be enabled?": "Concise, Detailed",
        },
      },
    });
    expect(result.eventOrder).toEqual(["question", "answer", "result"]);
    expect(result.exchanges).toHaveLength(1);
  });

  it("does not acknowledge delivery until Claude consumes the callback result", async () => {
    let callbackReturned: (() => void) | undefined;
    let releaseSdkMessage: (() => void) | undefined;
    const callbackHasReturned = new Promise<void>((resolve) => {
      callbackReturned = resolve;
    });
    const sdkMayContinue = new Promise<void>((resolve) => {
      releaseSdkMessage = resolve;
    });
    queryMock.mockImplementation(({ prompt, options: sdkOptions }) => ({
      async *[Symbol.asyncIterator]() {
        await firstStreamMessage(prompt);
        await requiredCanUseTool(sdkOptions)(
          "AskUserQuestion",
          { questions: nativeQuestions },
          {
            signal: new AbortController().signal,
            requestId: "request-native-1",
            toolUseID: "tool-native-1",
          },
        );
        callbackReturned?.();
        await sdkMayContinue;
        await requiredPostToolUse(sdkOptions)(
          postToolUseInput("tool-native-1"),
          "tool-native-1",
          { signal: new AbortController().signal },
        );
        yield successfulResult("AGENTPORT_G1_QUESTION_OK");
      },
    }));
    const acknowledgeDelivery = vi.fn(() => Promise.resolve());
    const operation = runClaudeQuestionCapability(
      options,
      "Ask two questions",
      "AGENTPORT_G1_QUESTION_OK",
      (request) =>
        Promise.resolve({
          questionId: request.questionId,
          requestId: request.requestId,
          toolUseId: request.toolUseId,
          answers: {
            "Which color should be used?": "Blue",
            "Which styles should be enabled?": "Concise, Detailed",
          },
        }),
      acknowledgeDelivery,
    );

    try {
      await callbackHasReturned;
      expect(acknowledgeDelivery).not.toHaveBeenCalled();
    } finally {
      releaseSdkMessage?.();
      await operation.catch(() => undefined);
    }
    expect(acknowledgeDelivery).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched post-tool-use confirmation without acknowledgement", async () => {
    queryMock.mockImplementation(({ prompt, options: sdkOptions }) => ({
      async *[Symbol.asyncIterator]() {
        await firstStreamMessage(prompt);
        await requiredCanUseTool(sdkOptions)(
          "AskUserQuestion",
          { questions: nativeQuestions },
          {
            signal: new AbortController().signal,
            requestId: "request-native-1",
            toolUseID: "tool-native-1",
          },
        );
        await requiredPostToolUse(sdkOptions)(
          postToolUseInput("tool-native-other"),
          "tool-native-other",
          { signal: new AbortController().signal },
        );
        yield successfulResult("must-not-complete");
      },
    }));
    const acknowledgeDelivery = vi.fn(() => Promise.resolve());

    await expect(
      runClaudeQuestionCapability(
        options,
        "Ask two questions",
        "must-not-complete",
        (request) =>
          Promise.resolve({
            questionId: request.questionId,
            requestId: request.requestId,
            toolUseId: request.toolUseId,
            answers: {
              "Which color should be used?": "Blue",
              "Which styles should be enabled?": "Concise, Detailed",
            },
          }),
        acknowledgeDelivery,
      ),
    ).rejects.toThrow("Invalid native question delivery confirmation");
    expect(acknowledgeDelivery).not.toHaveBeenCalled();
  });

  it("denies a concurrent native question while the first callback is pending", async () => {
    let concurrentResult: unknown;
    let releaseAnswer: ((value: ClaudeQuestionAnswer) => void) | undefined;
    const pendingAnswer = new Promise<ClaudeQuestionAnswer>((resolve) => {
      releaseAnswer = resolve;
    });
    queryMock.mockImplementation(({ prompt, options: sdkOptions }) => ({
      async *[Symbol.asyncIterator]() {
        await firstStreamMessage(prompt);
        const canUseTool = requiredCanUseTool(sdkOptions);
        const first = canUseTool(
          "AskUserQuestion",
          { questions: nativeQuestions },
          {
            signal: new AbortController().signal,
            requestId: "request-native-1",
            toolUseID: "tool-native-1",
          },
        );
        await Promise.resolve();
        concurrentResult = await canUseTool(
          "AskUserQuestion",
          { questions: nativeQuestions },
          {
            signal: new AbortController().signal,
            requestId: "request-native-2",
            toolUseID: "tool-native-2",
          },
        );
        releaseAnswer?.({
          questionId: "request-native-1",
          requestId: "request-native-1",
          toolUseId: "tool-native-1",
          answers: {
            "Which color should be used?": "Blue",
            "Which styles should be enabled?": "Concise, Detailed",
          },
        });
        await first;
        yield successfulResult("AGENTPORT_G1_QUESTION_OK");
      },
    }));

    await expect(
      runClaudeQuestionCapability(
        options,
        "Ask two questions",
        "AGENTPORT_G1_QUESTION_OK",
        () => pendingAnswer,
      ),
    ).rejects.toThrow("Claude did not complete one native question exchange");
    expect(concurrentResult).toEqual({
      behavior: "deny",
      message: "Concurrent tool activity",
    });
  });

  it.each<[string, (request: ClaudeQuestionRequest) => ClaudeQuestionAnswer]>([
    [
      "mismatched identity",
      (request) => ({
        questionId: "question-other",
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        answers: {
          "Which color should be used?": "Blue",
          "Which styles should be enabled?": "Concise",
        },
      }),
    ],
    [
      "missing answer",
      (request) => ({
        questionId: request.questionId,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        answers: { "Which color should be used?": "Blue" },
      }),
    ],
    [
      "extra answer",
      (request) => ({
        questionId: request.questionId,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        answers: {
          "Which color should be used?": "Blue",
          "Which styles should be enabled?": "Concise",
          "Unbound question": "must reject",
        },
      }),
    ],
  ])("rejects a %s without completing the exchange", async (_label, answer) => {
    let permissionResult: unknown;
    queryMock.mockImplementation(({ prompt, options: sdkOptions }) => ({
      async *[Symbol.asyncIterator]() {
        await firstStreamMessage(prompt);
        permissionResult = await requiredCanUseTool(sdkOptions)(
          "AskUserQuestion",
          { questions: nativeQuestions },
          {
            signal: new AbortController().signal,
            requestId: "request-native-1",
            toolUseID: "tool-native-1",
          },
        );
        yield successfulResult("must-not-complete");
      },
    }));

    await expect(
      runClaudeQuestionCapability(
        options,
        "Ask two questions",
        "must-not-complete",
        (request) => Promise.resolve(answer(request)),
      ),
    ).rejects.toThrow("Claude did not complete one native question exchange");
    expect(permissionResult).toEqual({
      behavior: "deny",
      message: "Invalid question answer",
    });
  });

  it("rejects a malformed native collection before invoking the answer bridge", async () => {
    let permissionResult: unknown;
    queryMock.mockImplementation(({ prompt, options: sdkOptions }) => ({
      async *[Symbol.asyncIterator]() {
        await firstStreamMessage(prompt);
        permissionResult = await requiredCanUseTool(sdkOptions)(
          "AskUserQuestion",
          {
            questions: [
              {
                ...nativeQuestions[0],
                options: [{ label: "Only", description: "Too few" }],
              },
            ],
          },
          {
            signal: new AbortController().signal,
            requestId: "request-native-1",
            toolUseID: "tool-native-1",
          },
        );
        yield successfulResult("must-not-complete");
      },
    }));
    const answerBridge = vi.fn(() =>
      Promise.reject<ClaudeQuestionAnswer>(
        new Error("Answer bridge must not be called"),
      ),
    );

    await expect(
      runClaudeQuestionCapability(
        options,
        "Ask two questions",
        "must-not-complete",
        answerBridge,
      ),
    ).rejects.toThrow("Claude did not complete one native question exchange");
    expect(answerBridge).not.toHaveBeenCalled();
    expect(permissionResult).toEqual({
      behavior: "deny",
      message: "Invalid question request",
    });
  });
});
