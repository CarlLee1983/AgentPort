import type { TaskRecord } from "../task/schema.js";

/**
 * ADR-0005：終端 Task 頁以未壓縮 UTF-8 JSON-RPC 回應體為權威容量層，8 MiB
 * （8,388,608 bytes）含 JSON-RPC 信封、structuredContent、與其內容相同的
 * `content[0].text`。`src/mcp/result.ts` 把同一份 payload序列化兩次（text block
 * 與 structuredContent），故估算時把 JSON 大小乘以 2，再加一段固定 envelope
 * 餘裕（JSON-RPC 信封欄位、echoed request id 等未反映在 payload 序列化裡的部分）。
 */
const DEFAULT_RESPONSE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_FINAL_TEXT_LIMIT_BYTES =
  DEFAULT_RESPONSE_BODY_LIMIT_BYTES / 2 - 64 * 1024;
const ENVELOPE_OVERHEAD_BYTES = 1024;

export interface CapacityPolicyOptions {
  responseBodyLimitBytes?: number;
  finalTextLimitBytes?: number;
}

export interface CapacityPolicy {
  /** payload 序列化後是否落在目前的回應體容量上限內（ADR-0005）。 */
  fitsCapacity(payload: unknown): boolean;
  /**
   * `final_text` 超過上限時，回傳一份截尾後的新 `TaskRecord` 並標記
   * `hints.truncated = true`；完整內容留在 `raw_log_path`。不改動傳入的 task。
   * 未超過上限時原樣回傳。
   */
  truncateFinalText(task: TaskRecord): TaskRecord;
}

/** 估算一個 tool 成功回應 payload 實際佔用的 JSON-RPC 回應體大小。 */
function estimateResponseBodyBytes(payload: unknown): number {
  return (
    Buffer.byteLength(JSON.stringify(payload), "utf8") * 2 +
    ENVELOPE_OVERHEAD_BYTES
  );
}

/**
 * 依 code point 逐一累加位元組數，超過 `maxBytes` 前停下；比直接切 Buffer
 * 再 `toString` 安全，後者對切在多位元組字元中間的尾巴會補上替代字元，
 * 反而讓結果超過 `maxBytes`。
 */
function truncateUtf8(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > maxBytes) {
      break;
    }
    result += ch;
    bytes += chBytes;
  }
  return result;
}

/**
 * 建立一份容量政策：預設值即 ADR-0005 的 8 MiB 回應體上限與對半分給
 * `final_text` 的上限；測試可傳 `options` 覆寫成小很多的上限，不必真的塞出
 * 8 MiB payload 就能逼出縮頁 / 截尾行為。由 `createApp` 建立一份預設實例，
 * 經 server factory 的 deps 傳給 `get_task` / `list_tasks`。
 */
export function createCapacityPolicy(
  options: CapacityPolicyOptions = {},
): CapacityPolicy {
  const responseBodyLimitBytes =
    options.responseBodyLimitBytes ?? DEFAULT_RESPONSE_BODY_LIMIT_BYTES;
  const finalTextLimitBytes =
    options.finalTextLimitBytes ?? DEFAULT_FINAL_TEXT_LIMIT_BYTES;

  return {
    fitsCapacity(payload) {
      return estimateResponseBodyBytes(payload) <= responseBodyLimitBytes;
    },

    truncateFinalText(task) {
      if (task.final_text === null) {
        return task;
      }
      if (Buffer.byteLength(task.final_text, "utf8") <= finalTextLimitBytes) {
        return task;
      }
      return {
        ...task,
        final_text: truncateUtf8(task.final_text, finalTextLimitBytes),
        hints: { ...task.hints, truncated: true },
      };
    },
  };
}
