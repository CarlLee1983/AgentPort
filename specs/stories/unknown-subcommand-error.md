# Unknown subcommand error

## Goal

When `agentport` is run with no subcommand or an unknown one, it prints a
short error that names the bad input and lists every valid subcommand. It
exits quickly without loading configuration, SQLite, drivers, or the MCP
server.

## Out of Scope

- Error output for unknown flags or missing values inside a known subcommand
  (`check-config --bogus` and similar). That output stays as it is.
- Unknown `service` sub-subcommands (`agentport service foo`).
- Adding `--help`, `-h`, `help`, or `--version`.
- "Did you mean …?" suggestions.
- Changing exit codes or output for any known subcommand.

## Acceptance Criteria

1. `node dist/cli.js bogus` exits with code 2.
2. Its stderr's first line is exactly `agentport：未知的指令 'bogus'`.
3. Its stderr contains a usage line for each of `check-config`, `stdio`,
   `serve`, and `service`.
4. Its stdout is empty, and its stderr contains no stack trace (no line
   starting with `    at `).
5. `node dist/cli.js` with no arguments exits with code 2 and prints the same
   subcommand list to stderr. Its first line is
   `agentport：缺少指令`.
6. On the unknown-command path, the process loads none of `better-sqlite3`,
   `@modelcontextprotocol/server`, or `src/driver/*`. A test under
   `tests/cli/` checks this by running the built CLI with a preloaded module
   (`node --import`) that records every resolved module through
   `module.registerHooks` and asserting none of them was loaded.
7. `pnpm check` passes.
