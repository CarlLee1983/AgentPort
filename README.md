# AgentPort

> **Robust, Durable, and Secure MCP Bridge for Local AI Coding Runtimes**

AgentPort connects external AI callers (such as Claude Desktop, Cursor, or specialized orchestrators) to host-bound AI coding runtimes (e.g., Claude Code CLI) via standard **Model Context Protocol (MCP)** tools.

It models the host's coding capability as **Logical Agents** with explicit bindings to pre-configured workspaces and execution policies. AgentPort provides rock-solid reliability: tasks are durably committed before responding, control operations run out-of-band without blocking on model execution, and tasks retain identity across daemon restarts without phantom reruns.

---

## Key Principles & Architecture

- **Durable Admission First**: Every submitted task, edit, question reply, and cancellation intent is atomically committed to SQLite WAL storage before returning a response to the caller.
- **Out-of-Band Control Plane**: Control tools (`get_task`, `cancel_task`, `list_tasks`) do not block on model reasoning or agent execution loops. Callers can inspect status, query events, or issue cancellations at any time.
- **Clean Architectural Seams**:
  - **Core Service (`AgentExecutionService`)**: Single source of truth for task lifecycles, access scopes, and mutation invariants.
  - **Storage (`SqliteDurableAdmissionStore`)**: Atomic transactions, idempotent operation receipts, dedicated database worker, and reserved bytes for control operations.
  - **Supervisor Interface (`ExecutionSupervisor`)**: Responsible for generation fencing, opaque execution units, and cryptographically verified stop evidence. Linux implementations leverage **cgroup v2** for complete process tree cleanup (preventing orphaned background processes).
  - **Runtime Driver (`ClaudeDriver`)**: Translates Claude Code CLI / SDK events, intercepts `AskUserQuestion` into native pending questions, and manages execution session boundaries.
  - **MCP Adapter**: Exposes clean, typed JSON-RPC tools with structured output schemas conforming to the MCP specification.

```
┌────────────────────────────────────────────────────────┐
│                   External MCP Caller                  │
│       (Claude Desktop, Cursor, Automated Scripts)      │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS / Streamable HTTP (MCP)
                            ▼
┌────────────────────────────────────────────────────────┐
│                   AgentPort Ingress                    │
│      Loopback Listener / TLS Proxy / Bearer Auth       │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                      MCP Adapter                       │
│    agentport_submit_task / agentport_get_task / ...    │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                 AgentExecutionService                  │
│  Access Scope, Revision Fencing, Lifecycle Projection  │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
               ▼                          ▼
┌───────────────────────────┐ ┌──────────────────────────┐
│   SQLite Durable Store    │ │   Execution Dispatcher   │
│ WAL, Receipts, Event Log, │ └───────────┬──────────────┘
│ Capacity Safe Pagination  │             │
└───────────────────────────┘             ▼
                              ┌──────────────────────────┐
                              │   Execution Supervisor   │
                              │ cgroup v2 / StopEvidence │
                              └───────────┬──────────────┘
                                          │
                                          ▼
                              ┌──────────────────────────┐
                              │  Runtime Driver & Worker │
                              │ Claude Code / AskUserQ   │
                              └──────────────────────────┘
```

---

## Core Domain Concepts

| Term | Definition |
| :--- | :--- |
| **Caller** | The external entity (or AI agent) invoking AgentPort's MCP tools. |
| **Access Scope** | Security perimeter grouping callers and agents. Authorizations and queries are strictly scoped. |
| **Logical Agent** | An authorized persona mapped by the host administrator to a specific workspace and runtime policy. |
| **Workspace** | Canonical directory path on the host where an agent operates. |
| **Task** | A tracked unit of work with durable state, revision, and terminal outcomes. |
| **Execution** | An actual execution attempt of a task, governed by an **Execution Generation** and **Execution Unit**. |
| **Context** | An unbroken sequence of tasks and clarifications sharing logical flow and workspace continuity. |
| **Clarification Reply** | Caller answer to a question raised by the coding agent (`AskUserQuestion`), keeping the task running. |

---

## Published MCP Tools

AgentPort registers **10 standard application tools** over MCP (`legacy: reject`, structured JSON content):

### 1. Task Lifecycle & Admission
- **`agentport_submit_task`**: Durably admits a new queued task and context (idempotent with `operationId`).
- **`agentport_edit_task`**: Modifies a never-started task using compare-and-swap on `expectedRevision`.
- **`agentport_cancel_task`**: Durably cancels queued work or records cancellation intent for active executions.

### 2. Observation & Query
- **`agentport_get_task`**: Reads the committed task snapshot, current state, active question, and outcomes without blocking.
- **`agentport_list_tasks`**: Lists task summaries in the caller's scope with **capacity-safe pagination** (guaranteed under 8 MiB response payload limits).
- **`agentport_get_events`**: Fetches committed lifecycle events with opaque cursors.
- **`agentport_list_agents`**: Lists configured logical agents available to the authenticated principal.

### 3. Interactive Clarification & Context Management
- **`agentport_reply`**: Durably records an answer to a pending question, waking up the paused execution.
- **`agentport_resume_context`**: Resumes a paused/blocked context using either `preserve` (resumable native session) or `fresh_session` (caller-provided summary).
- **`agentport_acknowledge_interruption`**: Cleanly acknowledges an interrupted or recovery-unknown task after verified stop evidence.

---

## Prerequisites

- **Node.js**: `24.21.0` (enforced via `.npmrc` / `package.json` engines)
- **Package Manager**: `pnpm` `12.4.1` (exact lockfile required)
- **Platform**:
  - **Development & Verification**: macOS or Linux (full test suite, mock execution, durable store, MCP contracts).
  - **Production Runtime Execution**: Linux with **systemd** and **cgroup v2** support (required for runtime isolation, credential management, and generation fencing).

---

## Getting Started

### Installation

Clone the repository and install exact dependencies using the frozen lockfile:

```bash
pnpm install --frozen-lockfile
```

### Build & Typecheck

```bash
# Typecheck
pnpm run typecheck

# Build TypeScript output
pnpm run build
```

---

## Quality Verification & Test Suites

AgentPort uses `make verify` as its primary automated repository quality gate. The repository includes focused test suites for every layer:

```bash
# Canonical Repository Gate (format, lint, typecheck, build, test, contracts)
make verify

# Platform-neutral tests (Unit, Integration, Contracts, Acceptance)
pnpm run test:platform-neutral

# MCP Protocol & Adapter Compatibility tests
pnpm run test:mcp

# Failure injection, storage limits, and recovery crash-window matrix
pnpm run test:faults

# Outer MCP Observation under load (2s SLA verification)
pnpm run test:observation-load

# Terminal summary capacity & safe pagination (8 MiB JSON-RPC compliance)
pnpm run test:terminal-summary-capacity

# Linux Supervisor & cgroup isolation (requires Linux target)
pnpm run test:linux
```

---

## Configuration & Security Boundary

- **Bearer Authentication**: Callers must provide a valid Bearer token mapped in the host's `Registry`. Tokens identify the `Principal` and resolve their `Access Scope`.
- **Revision Fencing**: In-flight mutations are rejected if the Registry's configuration or agent allowlists change before transaction commit.
- **Auditing & Privacy**: Product audit records log normalized tool calls and one-way SHA-256 fingerprints. Raw arguments, tokens, and prompt texts are strictly excluded from audit logs and events.
- **Capacity Protections**:
  - Uncompressed JSON-RPC responses are capped to prevent wire saturation.
  - SQLite storage maintains reserved byte quotas to ensure cancellation and terminal receipts can always be recorded even under storage pressure.

For comprehensive operational practices, storage recovery, and Linux deployment topologies, see:
- [Technical Design](docs/technical-design.md)
- [Durable Admission Operations](docs/durable-admission-operations.md)
- [Domain Glossary (CONTEXT.md)](CONTEXT.md)
- [Development Workflow](docs/development-workflow.md)

---

## License

Internal / Proprietary. Refer to repository governance for details.
