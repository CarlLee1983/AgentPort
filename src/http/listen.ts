export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1", "[::1]"];

export interface ParsedListen {
  host: string;
  port: number;
}

/** `host:port`（含裸 IPv6 需以 `[]` 包住）。 */
export function parseListen(listen: string): ParsedListen {
  const separatorIndex = listen.lastIndexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`listen 格式錯誤，需為 host:port：${listen}`);
  }
  const host = listen.slice(0, separatorIndex);
  const portText = listen.slice(separatorIndex + 1);
  const port = Number(portText);
  if (
    host.length === 0 ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(`listen 格式錯誤，需為 host:port：${listen}`);
  }
  return { host, port };
}

/** `listen` 的 host 是不是 loopback（127.0.0.1 / localhost / ::1）。 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(host);
}

/**
 * 從 `allowed_hosts` 的一筆項目取出裸 hostname：項目可以是 `host` 或
 * `host:port`（`hostHeaderValidation` / `originValidation` 都只認 hostname，
 * port-agnostic），裸 IPv6 一律要求呼叫端以 `[]` 包住。只有恰好一個冒號時才
 * 視為 `host:port`，避免誤切沒加中括號的裸 IPv6 位址。
 */
export function hostnameOf(entry: string): string {
  if (entry.startsWith("[")) {
    const closeBracket = entry.indexOf("]");
    return closeBracket === -1 ? entry : entry.slice(0, closeBracket + 1);
  }
  const colonCount = entry.split(":").length - 1;
  if (colonCount === 1) {
    return entry.slice(0, entry.indexOf(":"));
  }
  return entry;
}
