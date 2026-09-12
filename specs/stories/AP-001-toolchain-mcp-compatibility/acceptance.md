# Acceptance Criteria

所有 AC 都是 AP-001 **實作後**的驗收要求；治理導入僅檢查本文件結構，尚無任何 AC 通過。
以下命令及 evidence 路徑是本 Story 必須交付的契約，目前尚未實作。

## Happy Path

* [ ] AC-01: fresh checkout 能依 docs/toolchain-compatibility.md 指定的 exact Node 與 pnpm 12 patch，以 pnpm install --frozen-lockfile 安裝 dependency；不更動 lockfile，無既有 node_modules／私人 .env 亦成功。
* [ ] AC-02: repository 僅使用 pnpm 12 與 pnpm-lock.yaml；packageManager、安裝說明與 CI 一致，無 package-lock.json、npm-shrinkwrap.json、yarn.lock 或其他 package manager lockfile。
* [ ] AC-03: format、lint、typecheck、build、test 都有 deterministic command，由 make verify 統合；每項錯誤可傳遞 nonzero exit，不以空測試或無作用指令冒充完成。
* [ ] AC-04: 固定版本官方 MCP Client fixture 在 loopback 完成選定 revision 預期的 protocol negotiation／每請求 version、client info、capabilities 驗證；記錄 request／response 與 exact Client／SDK／revision，遵循既有無狀態 Streamable HTTP 設計。
* [ ] AC-05: 實際驗證 tools/list 與 tools/call；工具 schema、outputSchema、structuredContent 與相同內容 JSON TextContent 符合契約，未知工具與無效 schema 明確失敗，未提供 AgentPort production API。

## Failure Cases

* [ ] AC-06: 缺少／無效 authentication 回 401；unsupported protocol revision、缺必要協定資料／legacy lifecycle 明確失敗、未執行工具、無隱藏 fallback；不同合成 bearer 保有獨立測試身分，Client 輸入不能覆寫身分，token 不出現在回應、log 或 evidence。

## Business Rules

* [ ] AC-07: 固定 Claude SDK 的 query streaming input、cancellation、AskUserQuestion／canUseTool，以及 cwd／settingSources／resume，具可追溯型別／官方來源與靜態檢查結果；記錄對應 Claude binary 版本依據，明確區分未執行的真 Runtime 能力。
* [ ] AC-08: 記錄 exact SQLite binding version 與實際查詢取得的 SQLite runtime version；確認 Node 載入相容性、WAL 修正依據及非阻塞控制事件迴圈的可用方式；不建立 Task storage。
* [ ] AC-09: 記錄指定 Linux 目標的 OS／版本、cgroup v2、service account、launcher permission、protected data directory，以及 vendor credential 來源是否可用的非秘密 metadata；各項有查詢方法／觀察值，缺必要前提記 blocked，不記通過。
* [ ] AC-10: 所有選定版本與 AC 驗證結果有 evidence：來源 revision／摘要、OS、exact versions、日期、命令、fixture、預期／實際與限制；每個 AC 有明確 pass／fail／blocked／skipped，沒有空白或被刪除的失敗項目。

## Regression Requirements

* [ ] AC-11: fresh checkout 依宣告步驟安裝後，make verify 可重複得到 deterministic PASS／FAIL；不需真 vendor credential，檢查失敗確實回 nonzero，含 repository contract 與完整本 Story local checks。
* [ ] AC-12: 沒有啟動真正 AgentPort coding runtime 或 Claude coding task，未建立 scope 外產品模組；fixture 只做本機協定／靜態 capability／SQLite 版本檢查，沒有派送、產品持久化或真模型呼叫。

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | command | `pnpm install --frozen-lockfile` | `fresh checkout with declared exact Node and pnpm 12 patch; no node_modules or private env` | `exit 0; lockfile unchanged; installation log recorded in verification.md` |
| `AC-02` | human | `docs/toolchain-compatibility.md package-manager audit` | `repository manifests, lockfiles, CI and installation instructions` | `only pnpm 12 and pnpm-lock.yaml; one exact packageManager value` |
| `AC-03` | command | `make verify` | `installed declared toolchain; all local layers implemented` | `format lint typecheck build test execute; failures propagate nonzero` |
| `AC-04` | command | `pnpm run test:mcp` | `fixed official Client; loopback-only stateless revision fixture` | `expected revision and per-request metadata accepted; sanitized transcript recorded` |
| `AC-05` | command | `pnpm run test:mcp` | `fixture tools/list and tools/call positive and schema-negative cases` | `matching structured and JSON text results; unknown tool and invalid schema rejected` |
| `AC-06` | command | `pnpm run test:mcp` | `missing and invalid bearer; two distinct synthetic identities; unsupported revision` | `401 or protocol error as applicable; no tool execution or token disclosure; identities distinct` |
| `AC-07` | human | `docs/toolchain-compatibility.md Claude capability matrix` | `fixed SDK package types and official source; static checks; no query execution` | `each required capability traced; binary version basis recorded; runtime behavior explicitly unverified` |
| `AC-08` | human | `docs/toolchain-compatibility.md SQLite compatibility record` | `fixed binding loaded under selected Node; SQLite version query and official WAL fix source` | `exact binding and actual SQLite runtime versions; compatible load and WAL fix; nonblocking approach identified` |
| `AC-09` | human | `docs/toolchain-compatibility.md Linux prerequisite record` | `designated Linux target inspected with metadata-only commands` | `OS cgroup v2 account launcher and protected-directory observations recorded; missing prerequisites blocked; no secrets` |
| `AC-10` | human | `specs/stories/AP-001-toolchain-mcp-compatibility/verification.md` | `all AC observations and exact version source records` | `every AC mapped to reproducible command or explicit review evidence; no missing or hidden failures` |
| `AC-11` | command | `make verify` | `fresh checkout and deterministic install; clean environment; deliberate failing fixture tested separately` | `repeatable exit 0 on valid checkout and nonzero on failed check; no vendor credential needed` |
| `AC-12` | human | `specs/stories/AP-001-toolchain-mcp-compatibility/verification.md runtime absence audit` | `final diff, fixture entrypoints and recorded command/process observations` | `no real coding runtime or model invocation; no product modules or Task storage` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `Authorization` | `Bearer ap001-invalid-token` | reject | `HTTP response; console; verification.md; ForgePilot verification log` | `pnpm run test:mcp asserts 401 and absence of token bytes in response and captured output` |
| `Authorization` | `Bearer ap001-principal-a-token` | redact | `HTTP response; console; verification.md; ForgePilot verification log` | `pnpm run test:mcp captures all fixture output and asserts token bytes absent` |
| `Authorization` | `Bearer ap001-principal-b-token` | redact | `HTTP response; console; verification.md; ForgePilot verification log` | `pnpm run test:mcp asserts distinct principal identity and no token bytes in output` |
| `protocolVersion` | `1900-01-01` | reject | `HTTP protocol error; sanitized compatibility transcript` | `pnpm run test:mcp asserts unsupported revision failure without tool execution` |
| `clientInfo` | `{"name":"ap001-client","version":"1.0.0"}` | preserve | `sanitized compatibility transcript` | `pnpm run test:mcp asserts expected per-request Client metadata` |
| `capabilities` | `{}` | preserve | `sanitized compatibility transcript` | `pnpm run test:mcp asserts expected per-request capability metadata` |
| `request.id` | `ap001-request-1` | preserve | `fixture response; sanitized compatibility transcript` | `pnpm run test:mcp asserts request and response correlation` |
| `request.method` | `initialize` | reject | `protocol error; sanitized compatibility transcript` | `pnpm run test:mcp asserts legacy lifecycle rejection` |
| `tool.name` | `ap001-unknown-tool` | reject | `protocol error; sanitized compatibility transcript` | `pnpm run test:mcp asserts unknown tool failure without execution` |
| `tool.arguments` | `{"unexpected":true}` | reject | `schema error; sanitized compatibility transcript` | `pnpm run test:mcp asserts invalid argument schema failure` |
| `tool.arguments` | `{"principal":"principal-b"}` | reject | `schema error; sanitized compatibility transcript` | `pnpm run test:mcp asserts caller cannot override bearer-derived identity` |
| `tool.structuredContent` | `{"ok":true}` | preserve | `fixture response; sanitized compatibility transcript` | `pnpm run test:mcp asserts outputSchema and structured result` |
| `tool.textContent` | `{"ok":true}` | preserve | `fixture response; sanitized compatibility transcript` | `pnpm run test:mcp parses JSON text and asserts equality to structuredContent` |
| `error.details` | `ap001-invalid-token` | omit | `HTTP response; console; verification.md; ForgePilot verification log` | `pnpm run test:mcp asserts credential sentinel absent from derived error output` |
| `evidence.label` | `ap001-principal-a-token` | omit | `console; verification.md; ForgePilot verification log` | `pnpm run test:mcp asserts credential sentinel absent from derived evidence labels` |

## Verification Notes

`make verify` 是唯一 canonical local gate；pnpm 子命令不是平行 PASS authority。
治理導入時的結構 PASS 不代表上述尚未實作的檢查 PASS。
AP-001 執行後的 `verification.md` 必須逐項記錄實際觀察，保留所有 fail／blocked／skipped 與不支援層的 residual risk。
人工列是必要 evidence，不能由 Story checker 的靜態 PASS 代替。
AC-09 的真 Linux metadata 另行採集；缺外部前提不阻擋 local gate，但會阻擋 AC-09／G0 完成。
真 Claude 正向互動、可靠停止與 Linux execution 屬 S1，AC-07 不替代 G1。
