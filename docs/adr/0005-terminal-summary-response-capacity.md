---
status: accepted
inherited_from: ../AgentPort/docs/adr/0005-terminal-summary-response-capacity.md (v1, 2026-09)
---

> 自 v1 原樣繼承（地圖 Notes：0005 回應容量上限）。v2 的 `list_tasks` / `get_task` 以此 8 MiB 回應體上限縮頁與截尾；v1 專有的 tool 名、cursor 格式、evidence 路徑不適用。


# Terminal Task pages are bounded at the AgentPort JSON-RPC response body

This decision is grounded in AP-017 / WI-018 Evidence EV-074 and Human Review
EV-075, including the sanitized local record
`node_modules/.cache/agentport-ap017/terminal-summary-capacity-1789532067558.json`
named by the post-WI-018 handoff. That record compared `logicalSummary`,
`workerFrame`, `structuredResult`, `jsonText`, `serializedTextContent` and
`jsonRpcResponseBody`; some enclosing JSON-escape layers exceeded the target
while inner layers did not. AP-017 characterized those relationships and did
not select an authority or capacity verdict.

Terminal `agentport_list_tasks` pages use the complete uncompressed UTF-8
JSON-RPC response body produced by AgentPort as the authoritative 8 MiB
(8,388,608-byte inclusive) capacity layer. The bound includes the JSON-RPC
envelope, structured MCP result, equivalent JSON TextContent and every bounded
envelope field, including the echoed request ID; it excludes HTTP headers,
transfer framing, compression, TLS and proxy-specific encoding.

When the requested or default item count would exceed the bound, `limit` is an
upper bound: AgentPort returns a capacity-safe prefix of complete Task summaries
and a non-null `nextCursor` sealed after the final returned Task. Following the
cursor must return every remaining authorized Task exactly once. AgentPort does
not truncate summaries, omit an item while returning a terminal cursor, slice a
page after sealing a cursor for a larger page, or introduce a page-level
`output_limit` error.

Authorization and cursor concealment run before capacity selection. Existing
scope, filter and retention cursor bindings, foreign `not_found`, revoked
`access_denied`, tool names, schemas, public codes and cursor format remain
unchanged; private instruction and result content do not enter Gate rationale,
the ADR, technical documentation, audit, logs or sanitized evidence. Compatible
Callers must treat 50 and 100 as requested upper bounds and follow
`nextCursor`, rather than assume exact successful page cardinality.

This chooses honest bounded application responses and existing cursor recovery
over exact 50/100-item page cardinality. Treating only `structuredContent` as
authoritative was rejected because it permits a much larger AgentPort response
body; atomic `output_limit` was rejected because legal default pages could fail
and Callers would need a new public error and retry search. Product behavior is
unchanged until a separately approved execution Story implements and verifies
this contract. The decision requires no storage, schema or cursor migration.
Rolling back a later implementation can restore exact 50/100-item cardinality,
but also reintroduces AgentPort response bodies above the selected bound and
must explicitly accept that operational risk.
