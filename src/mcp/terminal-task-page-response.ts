import {
  SERVER_INFO_META_KEY,
  type CallToolResult,
} from "@modelcontextprotocol/server";

import type { TaskPage } from "../core/types.js";

export const TERMINAL_TASK_PAGE_RESPONSE_BYTES = 8 * 1024 * 1024;

export const DURABLE_ADMISSION_SERVER_INFO = {
  name: "agentport-durable-admission",
  version: "0.0.0",
} as const;

export function terminalTaskPagePayload(
  page: TaskPage,
): Record<string, unknown> {
  return { tasks: page.tasks, nextCursor: page.nextCursor };
}

export function terminalTaskPageResult(page: TaskPage): CallToolResult {
  const payload = { ok: true, ...terminalTaskPagePayload(page) };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Mirrors the modern MCP success envelope for the terminal Task-page seam. */
export function terminalTaskPageResponseBody(
  page: TaskPage,
  requestId: unknown,
): string {
  const result = terminalTaskPageResult(page);
  return JSON.stringify({
    result: {
      ...result,
      resultType: "complete",
      _meta: { [SERVER_INFO_META_KEY]: DURABLE_ADMISSION_SERVER_INFO },
    },
    jsonrpc: "2.0",
    id: requestId,
  });
}

export function terminalTaskPageFits(
  page: TaskPage,
  requestId: unknown,
): boolean {
  return (
    Buffer.byteLength(terminalTaskPageResponseBody(page, requestId), "utf8") <=
    TERMINAL_TASK_PAGE_RESPONSE_BYTES
  );
}
