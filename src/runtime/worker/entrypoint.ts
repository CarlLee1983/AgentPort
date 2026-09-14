import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_CONTEXT_SUMMARY_BYTES,
  type ExecutionReference,
  type RuntimeExecutionPolicy,
  type RuntimeQuestionIdentity,
} from "../../core/types.js";
import type { RuntimeIngressDescriptor } from "../../core/execution-supervisor.js";
import { isExecutionReference } from "../../supervisor/linux/launcher-protocol.js";
import {
  runClaudeQuestionCapability,
  runStructuredClaudeQuery,
  protectedSessionTokenForExecution,
  sessionReferenceForExecution,
  type ClaudeDriverOptions,
} from "../claude/driver.js";
import {
  isProtectedClaudeSessionToken,
  sessionReferenceFor,
} from "../claude/session-reference.js";
import {
  encodeWorkerObservation,
  projectRuntimeWorkerFailure,
  type RuntimeWorkerQuestion,
} from "./protocol.js";
import {
  RuntimeInputTimeoutError,
  RuntimeWorkerIngressClient,
} from "./ingress-client.js";
import { ActiveExecutionDeadline } from "./execution-deadline.js";

type UnboundWorkerObservation =
  | { kind: "progress"; summary: string }
  | {
      kind: "question";
      questionId: string;
      toolUseId: string;
      requestId: string;
      toolActivity: "none";
      questions: readonly RuntimeWorkerQuestion[];
    }
  | {
      kind: "candidate";
      outcome: "succeeded" | "failed" | "canceled";
      summary: string;
      sessionReference: string | null;
      protectedSessionToken?: string;
    };

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

interface RuntimeWorkerCredential {
  reference: ExecutionReference;
  ingress: RuntimeIngressDescriptor | undefined;
  policy: RuntimeExecutionPolicy;
  continuation: Pick<
    ClaudeDriverOptions,
    "resumeSessionToken" | "freshContextSummary"
  >;
}

function protectedContinuation(
  value: unknown,
  reference: ExecutionReference,
): RuntimeWorkerCredential["continuation"] | undefined {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const payload = value as Record<string, unknown>;
  if (payload.kind === "fresh_session") {
    if (
      Object.keys(payload).length !== 2 ||
      typeof payload.contextSummary !== "string" ||
      Buffer.byteLength(payload.contextSummary, "utf8") >
        MAX_CONTEXT_SUMMARY_BYTES
    ) {
      return undefined;
    }
    return { freshContextSummary: payload.contextSummary };
  }
  const token = payload.protectedSessionToken;
  const sourceReference = payload.sourceReference;
  if (
    Object.keys(payload).length !== 5 ||
    payload.kind !== "resume" ||
    !isExecutionReference(sourceReference) ||
    sourceReference.workspaceIdentity !== reference.workspaceIdentity ||
    typeof payload.sessionReference !== "string" ||
    !isProtectedClaudeSessionToken(token) ||
    payload.sessionReference !== sessionReferenceFor(sourceReference, token)
  ) {
    return undefined;
  }
  return { resumeSessionToken: token };
}

async function runtimeCredential(): Promise<RuntimeWorkerCredential> {
  const credential = argument("--runtime-credential");
  const directory = process.env["CREDENTIALS_DIRECTORY"];
  if (
    credential !== "agentport-runtime" ||
    directory === undefined ||
    !directory.startsWith("/run/credentials/")
  ) {
    throw new Error("Missing protected Runtime credential");
  }
  const bytes = await readFile(join(directory, credential));
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid protected Runtime credential");
    }
    const payload = value as Record<string, unknown>;
    const reference = payload.reference;
    const ingressValue = payload.ingress;
    const policyValue = payload.policy;
    if (
      Object.keys(payload).length !== 5 ||
      payload.version !== 1 ||
      !isExecutionReference(reference) ||
      !(
        policyValue === null ||
        (typeof policyValue === "object" &&
          !Array.isArray(policyValue) &&
          Object.keys(policyValue).length === 2 &&
          Number.isSafeInteger(
            (policyValue as Record<string, unknown>).executionLimitSeconds,
          ) &&
          Number(
            (policyValue as Record<string, unknown>).executionLimitSeconds,
          ) > 0 &&
          Number.isSafeInteger(
            (policyValue as Record<string, unknown>).inputWaitSeconds,
          ) &&
          Number((policyValue as Record<string, unknown>).inputWaitSeconds) > 0)
      ) ||
      (ingressValue !== null &&
        (typeof ingressValue !== "object" ||
          Array.isArray(ingressValue) ||
          Object.keys(ingressValue).length !== 2 ||
          typeof (ingressValue as Record<string, unknown>).endpoint !==
            "string" ||
          typeof (ingressValue as Record<string, unknown>).token !== "string"))
    ) {
      throw new Error("Invalid protected Runtime credential");
    }
    const continuation = protectedContinuation(payload.continuation, reference);
    if (continuation === undefined) {
      throw new Error("Invalid protected Runtime credential");
    }
    const ingress =
      ingressValue === null
        ? undefined
        : {
            endpoint: String(
              (ingressValue as Record<string, unknown>).endpoint,
            ),
            token: String((ingressValue as Record<string, unknown>).token),
          };
    return {
      reference,
      ingress,
      policy:
        policyValue === null
          ? { executionLimitSeconds: 3_600, inputWaitSeconds: 86_400 }
          : {
              executionLimitSeconds: Number(
                (policyValue as Record<string, unknown>).executionLimitSeconds,
              ),
              inputWaitSeconds: Number(
                (policyValue as Record<string, unknown>).inputWaitSeconds,
              ),
            },
      continuation,
    };
  } finally {
    bytes.fill(0);
  }
}

async function observationEmitter(
  reference: ExecutionReference,
  descriptor: RuntimeIngressDescriptor | undefined,
): Promise<{
  emit: (observation: UnboundWorkerObservation) => Promise<void>;
  waitForQuestionAnswer: (request: {
    questionId: string;
    toolUseId: string;
    requestId: string;
    questions: readonly RuntimeWorkerQuestion[];
  }) => Promise<{
    questionId: string;
    toolUseId: string;
    requestId: string;
    answers: Record<string, string>;
  }>;
  acknowledgeQuestionDelivery: (
    identity: RuntimeQuestionIdentity,
  ) => Promise<void>;
}> {
  let ordinal = 0;
  if (descriptor === undefined) {
    return {
      emit(observation): Promise<void> {
        ordinal += 1;
        const bound =
          observation.kind === "candidate"
            ? { ...observation, reference, ordinal, finalOrdinal: ordinal }
            : { ...observation, reference, ordinal };
        process.stdout.write(`${encodeWorkerObservation(bound)}\n`);
        return Promise.resolve();
      },
      waitForQuestionAnswer(request) {
        return Promise.resolve({
          questionId: request.questionId,
          toolUseId: request.toolUseId,
          requestId: request.requestId,
          answers: Object.fromEntries(
            request.questions.map((question) => [
              question.question,
              question.options[0]?.label ?? "",
            ]),
          ),
        });
      },
      acknowledgeQuestionDelivery: () => Promise.resolve(),
    };
  }
  const ingress = await RuntimeWorkerIngressClient.connect(descriptor);
  return {
    async emit(observation): Promise<void> {
      ordinal += 1;
      const bound =
        observation.kind === "candidate"
          ? { ...observation, reference, ordinal, finalOrdinal: ordinal }
          : { ...observation, reference, ordinal };
      await ingress.emit(
        encodeWorkerObservation(bound),
        ordinal,
        observation.kind,
      );
    },
    async waitForQuestionAnswer(request) {
      return {
        questionId: request.questionId,
        toolUseId: request.toolUseId,
        requestId: request.requestId,
        answers: await ingress.waitForQuestionAnswer(request),
      };
    },
    acknowledgeQuestionDelivery: (identity) =>
      ingress.acknowledgeQuestionDelivery(identity),
  };
}

async function emitProgress(
  reference: ExecutionReference,
  ingress: RuntimeIngressDescriptor | undefined,
  summary: string,
): Promise<void> {
  const output = await observationEmitter(reference, ingress);
  await output.emit({ kind: "progress", summary });
}

async function runIsolationProbe(
  reference: ExecutionReference,
  ingress: RuntimeIngressDescriptor | undefined,
): Promise<void> {
  const output = await observationEmitter(reference, ingress);
  try {
    const runtimeHome = process.env["HOME"];
    if (runtimeHome === undefined) throw new Error("Missing Runtime home");
    const credentialMarkerPath = join(
      runtimeHome,
      ".agentport-g1-test-credential",
    );
    const marker = await readFile(credentialMarkerPath, "utf8");
    if (marker.length === 0) throw new Error("Credential marker is empty");
    await access(process.cwd(), constants.R_OK | constants.W_OK);
    await output.emit({ kind: "progress", summary: "credential-available" });
    await output.emit({
      kind: "candidate",
      outcome: "succeeded",
      summary: "isolation-probe-ok",
      sessionReference: null,
    });
  } catch (error) {
    await output.emit(projectRuntimeWorkerFailure(error, "isolation-probe"));
  }
  keepAlive();
}

function keepAlive(): void {
  setInterval(() => undefined, 60_000);
}

function claudeOptions(
  reference: ExecutionReference,
  continuation: RuntimeWorkerCredential["continuation"],
  deadline: ActiveExecutionDeadline,
): ClaudeDriverOptions {
  const pathToClaudeCodeExecutable = argument("--claude-executable");
  if (pathToClaudeCodeExecutable === undefined) {
    throw new Error("Missing protected Claude executable path");
  }
  return {
    reference,
    cwd: process.cwd(),
    pathToClaudeCodeExecutable,
    abortController: deadline.abortController,
    ...continuation,
  };
}

async function runClaudeMode(
  credential: RuntimeWorkerCredential,
  mode: string,
): Promise<void> {
  const { reference } = credential;
  const output = await observationEmitter(reference, credential.ingress);
  const deadline = new ActiveExecutionDeadline(
    credential.policy.executionLimitSeconds,
  );
  const timeout = { input: false };
  const answerQuestion = async (request: {
    questionId: string;
    toolUseId: string;
    requestId: string;
    toolActivity: "none";
    questions: readonly RuntimeWorkerQuestion[];
  }) => {
    await output.emit({
      kind: "question",
      questionId: request.questionId,
      toolUseId: request.toolUseId,
      requestId: request.requestId,
      toolActivity: request.toolActivity,
      questions: request.questions,
    });
    deadline.pause();
    try {
      return await output.waitForQuestionAnswer(request);
    } catch (error) {
      if (error instanceof RuntimeInputTimeoutError) timeout.input = true;
      throw error;
    } finally {
      deadline.resume();
    }
  };
  await output.emit({ kind: "progress", summary: "claude-worker-ready" });
  try {
    if (mode === "claude-structured") {
      const result = await runStructuredClaudeQuery(
        claudeOptions(reference, credential.continuation, deadline),
        "Return a structured answer whose answer field is exactly AGENTPORT_G1_OK. Do not use tools.",
        "AGENTPORT_G1_OK",
      );
      await output.emit({
        kind: "candidate",
        outcome: "succeeded",
        summary: result.answer,
        sessionReference: sessionReferenceForExecution(result, reference),
        protectedSessionToken: protectedSessionTokenForExecution(
          result,
          reference,
        ),
      });
    } else if (mode === "claude-question" || mode === "claude-g4") {
      const driverOptions = claudeOptions(
        reference,
        credential.continuation,
        deadline,
      );
      if (
        mode === "claude-g4" &&
        (driverOptions.resumeSessionToken !== undefined ||
          driverOptions.freshContextSummary !== undefined)
      ) {
        const result = await runStructuredClaudeQuery(
          driverOptions,
          "Continue this AgentPort Context and return a structured answer whose answer field is exactly AGENTPORT_G4_CONTINUATION_OK. Do not use tools.",
          "AGENTPORT_G4_CONTINUATION_OK",
        );
        await output.emit({
          kind: "candidate",
          outcome: "succeeded",
          summary: result.answer,
          sessionReference: sessionReferenceForExecution(result, reference),
          protectedSessionToken: protectedSessionTokenForExecution(
            result,
            reference,
          ),
        });
        return;
      }
      const result = await runClaudeQuestionCapability(
        driverOptions,
        `Call AskUserQuestion exactly once with exactly two questions: first ask which color to use with Blue and Red options, then ask which response style to use with Concise and Detailed options. After the tool returns, produce a structured answer whose answer field is exactly ${mode === "claude-g4" ? "AGENTPORT_G4_QUESTION_OK" : "AGENTPORT_G1_QUESTION_OK"}.`,
        mode === "claude-g4"
          ? "AGENTPORT_G4_QUESTION_OK"
          : "AGENTPORT_G1_QUESTION_OK",
        answerQuestion,
        (request) => output.acknowledgeQuestionDelivery(request),
      );
      await output.emit({
        kind: "candidate",
        outcome: "succeeded",
        summary: result.answer,
        sessionReference: sessionReferenceForExecution(result, reference),
        protectedSessionToken: protectedSessionTokenForExecution(
          result,
          reference,
        ),
      });
    } else if (mode === "claude-cancel-active") {
      const result = await runStructuredClaudeQuery(
        claudeOptions(reference, credential.continuation, deadline),
        "Return a structured answer whose answer field is exactly AGENTPORT_G1_ACTIVE_OK after carefully counting from 1 to 100 internally.",
        "AGENTPORT_G1_ACTIVE_OK",
      );
      await output.emit({
        kind: "candidate",
        outcome: "succeeded",
        summary: result.answer,
        sessionReference: sessionReferenceForExecution(result, reference),
        protectedSessionToken: protectedSessionTokenForExecution(
          result,
          reference,
        ),
      });
    } else if (mode === "claude-cancel-question") {
      await runClaudeQuestionCapability(
        claudeOptions(reference, credential.continuation, deadline),
        "You must call AskUserQuestion exactly once to ask whether to continue.",
        "AGENTPORT_G1_QUESTION_WAITING_OK",
        answerQuestion,
        (request) => output.acknowledgeQuestionDelivery(request),
      );
      throw new Error("Claude question unexpectedly left pure waiting");
    } else {
      throw new Error("Unsupported Claude worker mode");
    }
  } catch (error) {
    await output.emit(
      deadline.expired
        ? {
            kind: "candidate",
            outcome: "failed",
            summary: "execution_timeout",
            sessionReference: null,
          }
        : timeout.input
          ? {
              kind: "candidate",
              outcome: "failed",
              summary: "input_timeout",
              sessionReference: null,
            }
          : projectRuntimeWorkerFailure(error, "claude-capability"),
    );
  } finally {
    deadline.dispose();
  }
  keepAlive();
}

async function run(): Promise<void> {
  const credential = await runtimeCredential();
  const { reference } = credential;
  const mode = argument("--mode");
  if (mode === "idle") {
    await emitProgress(reference, credential.ingress, "fixture-ready");
    keepAlive();
    return;
  }
  if (mode === "blocked") {
    await emitProgress(reference, credential.ingress, "fixture-blocked");
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0);
    return;
  }
  if (mode === "descendants") {
    await emitProgress(
      reference,
      credential.ingress,
      "fixture-descendants-ready",
    );
    spawn("/usr/bin/setsid", ["/bin/sh", "-c", "sleep 600"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    spawn("/bin/sh", ["-c", "sleep 600"], { stdio: "ignore" }).unref();
    keepAlive();
    return;
  }
  if (mode === "isolation-probe") {
    await runIsolationProbe(reference, credential.ingress);
    return;
  }
  if (mode?.startsWith("claude-") === true) {
    await runClaudeMode(credential, mode);
    return;
  }
  throw new Error("Unsupported Runtime worker mode");
}

void run().catch(() => {
  process.exitCode = 1;
});
