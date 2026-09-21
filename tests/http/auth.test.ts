import { describe, expect, it } from "vitest";

import { resolveBearerCallers } from "../../src/http/auth.js";

describe("resolveBearerCallers", () => {
  it("每個 caller 的 token_env 都有值時回傳解析好的 BearerCaller[]", () => {
    const outcome = resolveBearerCallers(
      [
        { name: "grok", token_env: "AGENTPORT_TOKEN_GROK" },
        { name: "codex-ci", token_env: "AGENTPORT_TOKEN_CODEX" },
      ],
      {
        AGENTPORT_TOKEN_GROK: "secret-1",
        AGENTPORT_TOKEN_CODEX: "secret-2",
      },
    );

    expect(outcome).toEqual({
      ok: true,
      callers: [
        { name: "grok", token: "secret-1" },
        { name: "codex-ci", token: "secret-2" },
      ],
    });
  });

  it("token_env 缺或空時回傳 ok:false 並列出缺的變數名，不用空字串頂替", () => {
    const outcome = resolveBearerCallers(
      [
        { name: "grok", token_env: "AGENTPORT_TOKEN_GROK" },
        { name: "codex-ci", token_env: "AGENTPORT_TOKEN_CODEX" },
      ],
      {
        AGENTPORT_TOKEN_GROK: "secret-1",
        AGENTPORT_TOKEN_CODEX: "",
      },
    );

    expect(outcome).toEqual({
      ok: false,
      missing: ["AGENTPORT_TOKEN_CODEX"],
    });
  });
});
