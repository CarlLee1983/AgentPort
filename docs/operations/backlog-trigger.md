# External backlog trigger

This optional integration submits one read-only backlog-triage Task to a running AgentPort service. It is deliberately outside the daemon: AgentPort executes and records Tasks, while launchd, cron, or a systemd timer decides when to invoke the trigger.

The trigger connects through MCP Streamable HTTP, calls `list_agents`, requires the selected Agent to use `read-only`, then calls `submit_task`. It prints only the returned `task_id`, `context_id`, and initial state as JSON. It never prints the bearer token.

## MCP boundary

The trigger uses MCP only to submit and observe AgentPort work. Current AgentPort versions have no `create_schedule`, `list_schedules`, `pause_schedule`, or `delete_schedule` tool, and do not persist schedule definitions. Configure when to run through the host scheduler. Configure the endpoint URL, bearer token, and selected Agent once in a mode-`0600` environment file; the scheduler invokes Node with `--env-file`, so those values do not need to appear in every command line.

## Preconditions

1. Install and start AgentPort normally.
2. Create a dedicated Caller token for the scheduler and a dedicated `read-only` Agent, preferably in a separate read-only checkout. Policy communicates Runtime intent; it is not an operating-system isolation boundary.
3. Keep a checkout with `pnpm install` available for the trigger. The script uses the repository's pinned MCP client dependency and is not included in the production service package.
4. Copy `examples/backlog-trigger/agentport-backlog.env.example` outside the repository, replace its placeholders, and set mode `0600`.

Example Agent configuration:

```toml
[[agents]]
name = "backlog-triage"
workspace = "/absolute/path/to/read-only-checkout"
runtime = "codex"
policy = "read-only"

[[callers]]
name = "backlog-scheduler"
token_env = "AGENTPORT_TOKEN"
```

The `AGENTPORT_TOKEN` value belongs only in the external trigger environment file. It must match the `token_env` named by the Caller configuration.

## Run once

```sh
node --env-file=/absolute/path/to/agentport-backlog.env \
  scripts/backlog-trigger.mjs
```

For a custom triage brief, set `AGENTPORT_BACKLOG_PROMPT`. To pass an immutable issue snapshot, write it to a local file and set `AGENTPORT_BACKLOG_CONTEXT_FILE`. Do not set both. For example, a host that is already authenticated to GitHub may prepare context without changing any issue:

```sh
gh issue list --repo OWNER/REPOSITORY --state open --limit 20 \
  --json number,title,labels,updatedAt,url,body \
  > /absolute/path/to/open-issues.json
```

The trigger does not use `gh` itself and AgentPort has no GitHub issue API. Issue retrieval, branch/worktree creation, pull-request creation, credentials, and network access remain Runtime or host responsibilities.

## Schedule externally

Copy and replace the absolute-path placeholders in one of these examples:

- macOS: `examples/backlog-trigger/com.agentport.backlog.plist.example`
- Linux systemd user timer: `examples/backlog-trigger/agentport-backlog.service.example` and `examples/backlog-trigger/agentport-backlog.timer.example`
- cron: `examples/backlog-trigger/agentport-backlog.cron.example`

Review the rendered unit or plist before enabling it. These files are examples only; this repository does not install, load, enable, or remove them.

## Delivery semantics

Each invocation creates exactly one new Context and Task if the AgentPort request succeeds. The trigger performs no automatic retry and AgentPort has no submission deduplication, so treat the integration as at-most-once per scheduler invocation. If a scheduler retries after an unknown network failure, it may create duplicate triage Tasks; use the Task history to reconcile before retrying.

The trigger returns after `submit_task` and does not wait for completion. Use an MCP client with `get_task` or `list_tasks` to observe the resulting Task. A separate notification or reporting integration can consume that Task record later.
