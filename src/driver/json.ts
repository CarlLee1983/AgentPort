/**
 * Claude / Codex 兩支 Driver 共用的 JSON 小工具：判斷是不是物件、截斷過長摘要、
 * 從 usage 物件裡只留數值欄位。獨立成檔案避免兩邊各自維護一份一樣的實作。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `summary` 截斷長度，避免單一 tool 呼叫的大型 input/output 撐爆事件。 */
const SUMMARY_MAX_LENGTH = 200;

export function truncate(text: string, maxLength = SUMMARY_MAX_LENGTH): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** `usage` 只留數值欄位；兩邊的 usage 都混雜非數值欄位（如 iterations[]、service_tier）。 */
export function numericUsage(usage: unknown): Record<string, number> | null {
  if (!isRecord(usage)) {
    return null;
  }
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") {
      numeric[key] = value;
    }
  }
  return numeric;
}
