import type {
  CanUseTool,
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  ToolInputSchemas,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";

type Assert<T extends true> = T;
type RequiredOptions = Pick<
  Options,
  | "abortController"
  | "canUseTool"
  | "cwd"
  | "resume"
  | "settingSources"
  | "spawnClaudeCodeProcess"
>;
type QueryPrompt = Parameters<
  typeof import("@anthropic-ai/claude-agent-sdk").query
>[0]["prompt"];
type AskUserQuestionSchema = Extract<ToolInputSchemas, AskUserQuestionInput>;

export type ClaudeCapabilityContract = {
  options: RequiredOptions;
  permissionCallback: CanUseTool;
  queryControls: Pick<Query, "close" | "interrupt">;
  streamingInput: Assert<
    AsyncIterable<SDKUserMessage> extends QueryPrompt ? true : false
  >;
  askUserQuestion: {
    name: "AskUserQuestion";
    permissionInput: AskUserQuestionInput & Parameters<CanUseTool>[1];
    sdkSchema: Assert<
      AskUserQuestionSchema extends AskUserQuestionInput ? true : false
    >;
  };
};
