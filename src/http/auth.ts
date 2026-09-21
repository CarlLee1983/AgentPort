import { timingSafeEqual } from "node:crypto";

export interface BearerCaller {
  name: string;
  token: string;
}

export interface BearerCallerConfig {
  name: string;
  token_env: string;
}

export type ResolveBearerCallersResult =
  { ok: true; callers: BearerCaller[] } | { ok: false; missing: string[] };

/**
 * 從設定檔的 `callers[]` 與環境變數解析出實際的 bearer token 表；`token_env`
 * 缺或為空一律回報 `missing`（環境變數名），不用空字串頂替——空字串永遠不會
 * 比對成功（`createBearerAuth` 一開始就擋掉空 token），與其讓它悄悄失效，不如
 * 直接讓 `agentport serve` 拒絕啟動並點名缺了哪些環境變數。
 */
export function resolveBearerCallers(
  callers: BearerCallerConfig[],
  env: Record<string, string | undefined>,
): ResolveBearerCallersResult {
  const missing: string[] = [];
  const resolved: BearerCaller[] = [];
  for (const caller of callers) {
    const token = env[caller.token_env];
    if (token === undefined || token.length === 0) {
      missing.push(caller.token_env);
      continue;
    }
    resolved.push({ name: caller.name, token });
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, callers: resolved };
}

export type BearerAuthResult = { ok: true; caller: string } | { ok: false };

export type BearerAuth = (
  authorizationHeader: string | undefined,
) => BearerAuthResult;

/**
 * 用設定檔 `callers[]`（token 已由呼叫端從 `token_env` 對應的環境變數讀出）
 * 做常數時間比對；缺 header、格式不對或查無對應 token 一律回傳 `{ ok: false }`。
 */
export function createBearerAuth(callers: BearerCaller[]): BearerAuth {
  return (authorizationHeader) => {
    if (
      authorizationHeader === undefined ||
      !authorizationHeader.startsWith("Bearer ")
    ) {
      return { ok: false };
    }
    const token = authorizationHeader.slice("Bearer ".length);
    if (token.length === 0) {
      return { ok: false };
    }
    for (const caller of callers) {
      if (timingSafeEqualStrings(token, caller.token)) {
        return { ok: true, caller: caller.name };
      }
    }
    return { ok: false };
  };
}

/** 長度不同時仍跑一次常數時間比對（跟自己比），避免用長度差洩漏時間資訊。 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
