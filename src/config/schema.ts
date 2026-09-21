import { z } from "zod";

export const POLICIES = ["read-only", "workspace-write", "full"] as const;
export const RUNTIME_NAMES = ["claude", "codex"] as const;

export const PolicySchema = z.enum(POLICIES);
export const RuntimeNameSchema = z.enum(RUNTIME_NAMES);

export const AgentSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, "agent name 只能包含小寫英數字與連字號"),
  description: z.string().optional(),
  workspace: z.string(),
  runtime: RuntimeNameSchema,
  policy: PolicySchema,
  extra_args: z.array(z.string()).optional(),
});

export const CallerSchema = z.strictObject({
  name: z.string(),
  token_env: z.string(),
});

/** `command` 未設時各自預設成裸名，交給語意驗證走 `PATH` 查找（見 `src/driver/registry.ts`）。 */
export const ClaudeRuntimeConfigSchema = z
  .strictObject({
    command: z.string().default("claude"),
  })
  .prefault({});

export const CodexRuntimeConfigSchema = z
  .strictObject({
    command: z.string().default("codex"),
  })
  .prefault({});

export const ConfigSchema = z.strictObject({
  server: z
    .strictObject({
      listen: z.string().default("127.0.0.1:3333"),
      long_poll_max_seconds: z.number().int().min(1).max(55).default(30),
      allowed_hosts: z.array(z.string()).default([]),
      turn_timeout_seconds: z.number().int().min(1).default(3600),
    })
    .prefault({}),
  storage: z
    .strictObject({
      db_path: z.string().default("~/.local/state/agentport/agentport.sqlite"),
      log_dir: z.string().default("~/.local/state/agentport/logs"),
    })
    .prefault({}),
  runtimes: z
    .strictObject({
      claude: ClaudeRuntimeConfigSchema,
      codex: CodexRuntimeConfigSchema,
    })
    .prefault({}),
  agents: z.array(AgentSchema).min(1, "agents[] 不可為空"),
  callers: z.array(CallerSchema).default([]),
});

/**
 * 只驗證頂層形狀（server / storage / runtimes 完整驗證，agents / callers 只驗證陣列本身），
 * 不深入驗證每個 agent / caller 的欄位；供 `loadConfig` 逐項 safeParse 之用，
 * 讓單一項目的結構錯誤不會擋住其他項目跑語意驗證。
 */
export const ConfigShapeSchema = z.strictObject({
  server: ConfigSchema.shape.server,
  storage: ConfigSchema.shape.storage,
  runtimes: ConfigSchema.shape.runtimes,
  agents: z.array(z.unknown()).min(1, "agents[] 不可為空"),
  callers: z.array(z.unknown()).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;
export type RuntimeName = z.infer<typeof RuntimeNameSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Caller = z.infer<typeof CallerSchema>;
export type Config = z.infer<typeof ConfigSchema>;
