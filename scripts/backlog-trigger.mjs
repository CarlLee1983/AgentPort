import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const DEFAULT_URL = "http://127.0.0.1:3333/";
const REQUIRED_POLICY = "read-only";
const DEFAULT_PROMPT = `Review the configured workspace backlog in read-only mode. Do not modify files, Git state, issue trackers, or remote services. Return prioritized findings, evidence, and the recommended next action. If the supplied context is insufficient, say exactly what is missing.`;

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function toolFailure(response, name) {
  const text = response.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join(" ");
  return `${name} failed${text ? `: ${text}` : ""}`;
}

function objectContent(response, name) {
  if (response.isError) throw new Error(toolFailure(response, name));
  if (
    !response.structuredContent ||
    typeof response.structuredContent !== "object" ||
    Array.isArray(response.structuredContent)
  ) {
    throw new Error(`${name} returned no structured content`);
  }
  return response.structuredContent;
}

async function loadPrompt(env) {
  const configuredPrompt = env.AGENTPORT_BACKLOG_PROMPT?.trim();
  const contextPath = env.AGENTPORT_BACKLOG_CONTEXT_FILE?.trim();
  if (configuredPrompt && contextPath) {
    throw new Error(
      "set only one of AGENTPORT_BACKLOG_PROMPT or AGENTPORT_BACKLOG_CONTEXT_FILE",
    );
  }
  if (configuredPrompt) return configuredPrompt;
  if (!contextPath) return DEFAULT_PROMPT;

  const context = await readFile(contextPath, "utf8");
  return `${DEFAULT_PROMPT}\n\nBacklog context:\n${context}`;
}

export async function submitBacklogTask(env = process.env) {
  const endpoint = new URL(env.AGENTPORT_URL?.trim() || DEFAULT_URL);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("AGENTPORT_URL must use http or https");
  }

  const token = requiredEnvironment(env, "AGENTPORT_TOKEN");
  const agent = requiredEnvironment(env, "AGENTPORT_BACKLOG_AGENT");
  const prompt = await loadPrompt(env);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agentport-backlog-trigger", version: "0.0.0" });

  try {
    await client.connect(transport);
    const listed = objectContent(
      await client.callTool({ name: "list_agents", arguments: {} }),
      "list_agents",
    );
    const agents = listed.agents;
    if (!Array.isArray(agents)) throw new Error("list_agents returned invalid agents");
    const selected = agents.find(
      (candidate) =>
        candidate && typeof candidate === "object" && candidate.name === agent,
    );
    if (!selected || typeof selected !== "object") {
      throw new Error(`configured agent not found: ${agent}`);
    }
    if (selected.policy !== REQUIRED_POLICY) {
      throw new Error(
        `configured agent ${agent} must use ${REQUIRED_POLICY} policy for backlog triage`,
      );
    }

    const submitted = objectContent(
      await client.callTool({
        name: "submit_task",
        arguments: { agent, prompt },
      }),
      "submit_task",
    );
    if (
      typeof submitted.task_id !== "string" ||
      typeof submitted.context_id !== "string" ||
      submitted.state !== "queued"
    ) {
      throw new Error("submit_task returned an invalid Task record");
    }
    return {
      task_id: submitted.task_id,
      context_id: submitted.context_id,
      state: submitted.state,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const task = await submitBacklogTask();
  process.stdout.write(`${JSON.stringify(task)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[agentport-backlog-trigger] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
