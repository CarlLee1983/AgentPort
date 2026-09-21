/**
 * 統一的 tool 成功回應：`content[0].text` 與 `structuredContent` 帶同一份 payload
 * 的 JSON。呼叫端不論走文字或結構化欄位都拿到一致的內容。
 */
export function result<T>(payload: T): {
  content: [{ type: "text"; text: string }];
  structuredContent: T;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export interface ToolErrorPayload {
  error: { code: string; message: string };
}

/**
 * 統一的 tool 錯誤回應：`isError: true` 讓 SDK 略過 outputSchema 驗證（錯誤形狀
 * 本來就不符合成功時的 outputSchema），`structuredContent` 帶 `{ error: { code, message } }`，
 * `content[0].text` 是同一份 JSON。
 */
export function toolError(
  code: string,
  message: string,
): {
  content: [{ type: "text"; text: string }];
  structuredContent: ToolErrorPayload;
  isError: true;
} {
  const payload: ToolErrorPayload = { error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}
