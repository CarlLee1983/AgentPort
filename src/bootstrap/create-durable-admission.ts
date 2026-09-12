import { DurableAgentExecutionService } from "../core/agent-execution-service.js";
import type { AgentExecutionService } from "../core/types.js";
import { createDurableAdmissionMcpHandler } from "../mcp/adapter.js";
import {
  SqliteDurableAdmissionStore,
  type DurableAdmissionStoreOptions,
} from "../storage/sqlite-durable-admission-store.js";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { AgentRegistry, type RegistryConfiguration } from "./registry.js";

export interface DurableAdmissionConfiguration {
  registry: RegistryConfiguration;
  cursorSecret: string;
  storage: DurableAdmissionStoreOptions;
}

export interface DurableAdmissionComposition {
  registry: AgentRegistry;
  service: AgentExecutionService;
  mcpHandler: McpHttpHandler;
  close(): Promise<void>;
}

export async function createDurableAdmission(
  configuration: DurableAdmissionConfiguration,
): Promise<DurableAdmissionComposition> {
  const store = await SqliteDurableAdmissionStore.open(configuration.storage);
  try {
    const registry = await AgentRegistry.create(configuration.registry, store);
    const service = new DurableAgentExecutionService(registry, store, {
      cursorSecret: configuration.cursorSecret,
    });
    await service.initializeAfterRestart();
    const mcpHandler = createDurableAdmissionMcpHandler(service);
    return {
      registry,
      service,
      mcpHandler,
      close: async () => {
        try {
          await mcpHandler.close();
        } finally {
          await store.close();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([store.close()]);
    throw error;
  }
}
