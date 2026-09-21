#!/usr/bin/env node
import { loadConfig } from "./config/load.js";
import { resolveConfigPath } from "./config/paths.js";

const USAGE = "usage: agentport check-config [--config <path>]";

type ParsedArgs = { ok: true; configPath: string | undefined } | { ok: false };

/** 只接受 `--config <path>`；缺值或任何未知旗標都視為用法錯誤。 */
function parseCheckConfigArgs(args: string[]): ParsedArgs {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== "--config") {
      return { ok: false };
    }
    const value = args[i + 1];
    if (value === undefined) {
      return { ok: false };
    }
    configPath = value;
    i += 1;
  }
  return { ok: true, configPath };
}

function runCheckConfig(args: string[]): number {
  const parsedArgs = parseCheckConfigArgs(args);
  if (!parsedArgs.ok) {
    console.error(USAGE);
    return 2;
  }
  const configPath = resolveConfigPath(parsedArgs.configPath, process.env);
  const result = loadConfig(configPath, process.env);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`${error.path}: ${error.message}`);
    }
    return 1;
  }

  const { agents, callers } = result.config;
  console.log("name\truntime\tpolicy\tworkspace");
  for (const agent of agents) {
    console.log(
      `${agent.name}\t${agent.runtime}\t${agent.policy}\t${agent.workspace}`,
    );
  }
  console.log(`callers: ${String(callers.length)}`);
  return 0;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === "check-config") {
    return runCheckConfig(rest);
  }

  console.error(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
