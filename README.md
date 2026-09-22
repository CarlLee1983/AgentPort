# AgentPort

[English](README.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

![AgentPort courier routing a task through a gateway to an authorised workspace](site/assets/agentport-cover.png)

AgentPort exposes AI coding runtimes on a target host—Claude Code and Codex—as Logical Agents that can execute work remotely. The host administrator binds each Agent to a specific Workspace and Runtime in configuration. Remote Callers can dispatch work only within that authorization; they cannot choose arbitrary paths or register Agents themselves.

![AgentPort courier handing a task package to an authorised workspace](site/assets/agentport-dispatch.png)

See `CONTEXT.md` for terminology and `specs/agentport-v2.md` for architecture and decisions.

## Installation and deployment

You need Node.js (see `engines.node` in `package.json`) and locally authenticated `claude` and `codex` CLIs. From the repository root, run:

```sh
pnpm install
pnpm service:install
```

This command builds the project, packages the build output and production dependencies into a temporary directory, and installs the service from that package. The long-running service never runs files from this repository. On its first run, it creates a skeleton at `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml` and stops. Add at least one Agent, then run the same command again.

The skeleton configuration lookup order is `--config <path>` → `$AGENTPORT_CONFIG` → `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml`. To use a non-default location:

```sh
pnpm service:install -- --config /path/to/agentport.toml
```

The skeleton keeps one `default` Caller. When adding an Agent, adapt it as follows:

```toml
[server]
listen = "127.0.0.1:3333"
long_poll_max_seconds = 30       # Maximum: 55
turn_timeout_seconds = 3600      # Maximum seconds per Turn; timeout is treated as cancellation (error.code = timeout)

[storage]
db_path = "~/.local/state/agentport/agentport.sqlite"
log_dir = "~/.local/state/agentport/logs"

[runtimes.claude]
command = "~/.local/bin/claude"  # Optional; defaults to PATH lookup

[[agents]]
name = "stationhub"              # Unique; [a-z0-9-]+
description = "StationHub backend" # Optional
workspace = "~/Dev/CMG/StationHub"
runtime = "claude"               # claude | codex
policy = "workspace-write"       # Required: read-only | workspace-write | full
extra_args = ["--model", "opus"]

[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"  # Tokens are read only from environment variables, never TOML
```

`~` expands to `$HOME`; relative paths are resolved from the configuration file's directory. Unknown fields are errors.

`service install` creates an adjacent `agentport.env` file (mode `0600`), fills any missing Caller tokens, and prints each new token once only. Give that value to the MCP client securely; do not put tokens in TOML or logs. If the configuration already exists, installation does not overwrite it or existing tokens.

After a successful installation, `~/.local/bin/agentport` points to the fixed installed version. Normal operations no longer require this repository:

```sh
agentport check-config
agentport service status
agentport service restart
agentport service uninstall
```

Use `restart` after changing TOML or the environment file. `uninstall` removes only the service definition, installation directory, and AgentPort-created wrapper; configuration, environment, SQLite data, and logs remain. Preview the service definition and system commands with `pnpm service:install -- --dry-run`.

On macOS, the service runs as a login-user LaunchAgent, so after a reboot it waits for that user to log in and unlock Keychain. Linux uses a systemd user unit; **the Linux path has not been verified on a real host**. If you need it to run while logged out, assess the consequences yourself before running `loginctl enable-linger $USER`.

## Remote access

Do not normally change `listen` to a non-loopback address. A remote machine should reach the local loopback through SSH port forwarding:

```sh
ssh -N -L 3333:127.0.0.1:3333 <host>
```

The remote MCP client can then use `http://127.0.0.1:3333/`, which reaches the host's loopback directly. Change `[server] listen` only when you explicitly need direct HTTP without SSH. In that case, `[server] allowed_hosts` is required and validated at startup; otherwise `check-config` and `serve` refuse to run.

## Scheduled backlog trigger

AgentPort does not schedule work itself. An optional external trigger can run from launchd, cron, or a systemd timer and submit one read-only backlog-triage Task through the authenticated MCP endpoint. MCP is used to submit the Task; it cannot create, list, pause, or delete schedules. Keep the URL, token, and Agent name in the trigger's mode-`0600` environment file rather than repeating them on every command. The trigger does not retry or deduplicate submissions, so the external scheduler remains responsible for one invocation per run. See [`docs/operations/backlog-trigger.md`](docs/operations/backlog-trigger.md) for the script, environment, and scheduler examples.

## MCP client configuration examples

AgentPort's HTTP server is stateless Streamable HTTP. Its handler is mounted across the entire listening address and does not inspect the path, so these examples consistently use the root URL `http://127.0.0.1:3333/`.

**Claude Code** (through the SSH tunnel above):

```sh
claude mcp add --transport http agentport http://127.0.0.1:3333/ \
  --header "Authorization: Bearer ${AGENTPORT_TOKEN}"
```

`${AGENTPORT_TOKEN}` is expanded by the Caller's shell when `claude mcp add` runs; Claude Code does not read it as a runtime environment variable. The expanded plaintext token is written directly to `~/.claude.json` (or a project's `.mcp.json`, depending on `-s` scope). Tested with Claude Code 2.1.278: header values do not support runtime `${VAR}` expansion. Writing `\${AGENTPORT_TOKEN}` prevents shell expansion but sends the literal string `${AGENTPORT_TOKEN}`, which cannot authenticate. There is currently no way to avoid plaintext storage; treat that configuration file as a protected secret-bearing file, as you would its other MCP credentials.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.agentport]
url = "http://127.0.0.1:3333/"
bearer_token_env_var = "AGENTPORT_TOKEN"
tool_timeout_sec = 120
```

Set `AGENTPORT_TOKEN` in the Caller's own environment first. Codex reads it at connection time through `bearer_token_env_var` and does not write it to `config.toml`; it must be the value named by a Caller `token_env` in the host's `agentport.toml`. Long polling is limited by `[server] long_poll_max_seconds` (≤ 55 seconds). Codex supports per-MCP-server `tool_timeout_sec` to override its default tool timeout. The key appears in the codex-cli 0.155.0 configuration schema, verified from binary strings. Official documentation states a 60-second timeout, but its version relationship to local 0.155.0 and the effective default were not verified. Set an explicit value above `long_poll_max_seconds` (such as `120`) instead of relying on an assumed default.

**Local stdio** runs directly on the host without networking. If `serve` is already running and you open another `stdio` instance, they cannot share a `db_path` because of the single-instance lock described in the Task state model. Use another configuration file that changes `[storage] db_path`—and normally `log_dir` to keep logs separate—while copying the same Agents, Callers, and server settings:

```sh
cp ~/.config/agentport/agentport.toml ~/.config/agentport/agentport.stdio.toml
# Edit agentport.stdio.toml and change [storage] db_path (and log_dir) to paths not used by serve, for example:
#   db_path = "~/.local/state/agentport/agentport-stdio.sqlite"
#   log_dir = "~/.local/state/agentport/logs-stdio"

agentport stdio --config ~/.config/agentport/agentport.stdio.toml
```

Starting stdio with the same `db_path` returns `SQLITE_BUSY`, exits non-zero, and prints that another AgentPort process is using the path.

## Deployment verification

- `agentport check-config` prints the expected Agent list and exits with code 0.
- The LaunchAgent or systemd unit is running (`launchctl print gui/$(id -u)/com.agentport.serve` or `systemctl --user status agentport`).
- Calling `list_agents` from the client returns the same list as `check-config`.
- A Claude task reaches `completed`.
- A Codex task reaches `completed`.

## MCP tools

Every tool returns `structuredContent` and identical JSON in `content[0].text`. Tool-level errors return `isError: true` with `{ "error": { "code", "message" } }`; codes are `not_found`, `invalid_state`, and `unknown_agent`.

| Tool          | Input                                              | Result                                                                                                            |
| ------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list_agents` | —                                                  | `{ agents: [{ name, description?, runtime, policy }] }`                                                           |
| `submit_task` | `{ agent, prompt }`                                | `{ task_id, context_id, state: "queued" }`; creates a new Context                                                 |
| `follow_up`   | `{ context_id, prompt }`                           | Same shape; reuses the Context's Agent and Runtime Session                                                        |
| `get_task`    | `{ task_id, wait_seconds? }`                       | Full Task record; with `wait_seconds` > 0, waits for a state change or `min(wait_seconds, long_poll_max_seconds)` |
| `cancel_task` | `{ task_id }`                                      | `{ task_id, state }`; an already terminal Task returns `invalid_state`                                            |
| `list_tasks`  | `{ agent?, context_id?, state?, limit?, cursor? }` | `{ tasks: [summaries], next_cursor }`, newest first; default limit 50, maximum 100                                |

Task states are `queued → running → completed | failed | cancelled`. A Task record includes `final_text`, `diff_stat` (the Turn's `git diff --stat` plus untracked files), `commits`, `usage`, `hints` (`permission_denied`, `git`, `truncated`), `error`, and `raw_log_path` (raw CLI output). `error.code` may be `runtime_failed`, `session_unresumable`, `interrupted` (running during a service restart), `cancelled`, or `timeout`.

The typical flow is `submit_task` → repeated `get_task` calls with `wait_seconds` until terminal → `follow_up` if the Runtime's final reply asks a question. Tasks remain queryable after a service restart. Queued Tasks continue automatically; running Tasks become `interrupted`, after which a `follow_up` in the same Context can resume the work.

## Known limitations

- **Codex follow-up after cancellation is unstable.** After cancelling a running Codex Task, a `follow_up` in the same Context may complete without remembering work before cancellation, or return `session_unresumable`. Claude resumes normally after cancellation.
- **Claude `read-only` maps to `plan` mode.** Claude does not attempt writes, so `hints.permission_denied` does not appear, and it leaves a file in `~/.claude/plans/`.
- **Claude `workspace-write` maps to `acceptEdits`.** File edits are allowed automatically, but some Bash commands can still be denied and are recorded in `hints.permission_denied`.
- **Policy is not an isolation boundary.** The service runs as the host administrator, and a Runtime can access everything that user can access. See `docs/adr/0009-*` and `docs/adr/0011-*`.
- **Each `db_path` permits only one service process.** See local stdio above.

## Development

```sh
pnpm install
pnpm check      # format:check → lint → typecheck → build → test; always use this for verification
```

`pnpm test` first runs tests that do not touch the package dependency tree in parallel, then separately runs production-package acceptance. The latter temporarily rebuilds repository `node_modules` links with `pnpm deploy --prod`; do not run it concurrently with tests that load modules from that dependency tree. `pnpm service:install` itself installs required build dependencies with the frozen lockfile first, so it can still build after a production deploy leaves a production-only dependency tree.

Real CLI tests are skipped by default. They require locally logged-in `claude` and `codex` CLIs and consume subscription allowance:

```sh
AGENTPORT_REAL_CLI=1 pnpm vitest run tests/driver/claude/real-cli.test.ts \
  tests/driver/codex/real-cli.test.ts tests/mcp/follow-up-real-cli.test.ts tests/mcp/cancel-real-cli.test.ts
```

## Documentation

- `CONTEXT.md`: domain vocabulary
- `specs/agentport-v2.md`: product specification and implementation decisions for build tickets
- `docs/adr/`: architecture decisions (0001 / 0002 / 0003 / 0005 / 0009 are inherited from v1; 0011 covers v2 credentials)
- `.scratch/agentport-v2/map.md`: decision map and open questions; `.scratch/agentport-v2-build/`: build tickets
