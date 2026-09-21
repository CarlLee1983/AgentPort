import { describe, expect, it } from "vitest";

import { buildAuthInfo } from "../../src/http/server.js";

describe("buildAuthInfo", () => {
  it("clientId 是驗證過的 caller 名稱，token 一律填固定字串（不外洩原始 bearer token）", () => {
    const authInfo = buildAuthInfo("grok");
    expect(authInfo.clientId).toBe("grok");
    expect(authInfo.token).toBe("redacted");
  });
});
