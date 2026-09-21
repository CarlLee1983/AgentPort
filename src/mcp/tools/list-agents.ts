import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../../config/schema.js";
import { result } from "../result.js";

const InputSchema = z.object({});

const OutputSchema = z.object({
  agents: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      runtime: z.string(),
      policy: z.string(),
    }),
  ),
});

export interface ListAgentsDeps {
  config: Config;
}

/** `list_agents()` → 設定檔內定義的 Agent 清單。 */
export function registerListAgents(
  server: McpServer,
  deps: ListAgentsDeps,
): void {
  server.registerTool(
    "list_agents",
    {
      description: "列出設定檔中已定義的 Agent",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    () => {
      const agents = deps.config.agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        runtime: agent.runtime,
        policy: agent.policy,
      }));
      return result({ agents });
    },
  );
}
