import { query } from "@anthropic-ai/claude-agent-sdk";

const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort();
}, 9_000);
timeout.unref();

try {
  let verified = false;
  for await (const message of query({
    prompt: "Reply with exactly AGENTPORT_READY.",
    options: {
      cwd: process.env.HOME ?? "/",
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      maxBudgetUsd: 0.01,
      tools: [],
      permissionMode: "dontAsk",
      abortController: controller,
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      verified = true;
      break;
    }
  }
  if (!verified) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
