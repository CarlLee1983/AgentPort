import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  createG1ClaudeHarnessEnvironment,
  isClaudeSubscriptionAuthStatus,
} from "../../src/runtime/claude/auth-policy.js";
import type { ExecutionReference } from "../../src/core/types.js";
import {
  createClaudeWorkerEnvironment,
  sessionReferenceForExecution,
  type ClaudeStructuredResult,
} from "../../src/runtime/claude/driver.js";

const executionReference: ExecutionReference = {
  executionId: "execution-claude-boundary",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "g1-claude-structured",
  workspaceIdentity: "g1-workspace",
};

describe("Claude Driver credential boundary", () => {
  it("uses only the protected Runtime home and non-secret process settings", () => {
    const environment = createClaudeWorkerEnvironment({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/runtime",
      CLAUDE_CONFIG_DIR: "/runtime/.claude",
      ANTHROPIC_API_KEY: "credential-marker",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-marker",
      AGENTPORT_CORE_TOKEN: "must-not-cross",
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
    });
    expect(environment).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/runtime",
      CLAUDE_CONFIG_DIR: "/runtime/.claude",
      CLAUDE_AGENT_SDK_CLIENT_APP: "agentport-g1/0.0.0",
    });
  });

  it.each([
    ["not logged in", { loggedIn: false, authMethod: "none" }],
    [
      "ambient OAuth token",
      {
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        subscriptionType: "max",
      },
    ],
    [
      "API key",
      {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
        subscriptionType: "max",
      },
    ],
    [
      "third-party provider",
      {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "bedrock",
        subscriptionType: "max",
      },
    ],
    [
      "non-subscription account",
      {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: null,
      },
    ],
    [
      "missing credential source",
      {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
      },
    ],
  ])(
    "rejects %s as the dedicated Runtime authentication source",
    (_label, status) => {
      expect(isClaudeSubscriptionAuthStatus(status)).toBe(false);
    },
  );

  it("accepts protected first-party Claude subscription OAuth", () => {
    expect(
      isClaudeSubscriptionAuthStatus({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        apiKeySource: "none",
        subscriptionType: "max",
      }),
    ).toBe(true);
  });

  it("runs the root harness without ambient credentials or process injection", () => {
    expect(
      createG1ClaudeHarnessEnvironment({
        AGENTPORT_G1_CLAUDE: "1",
        AGENTPORT_G1_LINUX: "1",
        AGENTPORT_G1_RUNTIME_HOME: "/runtime",
        ANTHROPIC_API_KEY: "credential-marker",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-marker",
        NODE_OPTIONS: "--import=/host/injection.mjs",
        PATH: "/host/bin",
      }),
    ).toEqual({
      AGENTPORT_G1_CLAUDE: "1",
      AGENTPORT_G1_LINUX: "1",
      AGENTPORT_G1_RUNTIME_HOME: "/runtime",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    });
  });

  it("rejects a Session reference produced for another execution", () => {
    const otherExecutionResult: ClaudeStructuredResult = {
      answer: "done",
      sessionReference: "session-from-other-execution",
      executionReference: {
        ...executionReference,
        executionId: "execution-claude-other",
      },
    };

    expect(() =>
      sessionReferenceForExecution(otherExecutionResult, executionReference),
    ).toThrow("Claude Session reference does not belong to this execution");
  });

  it.each([
    ["an oversized value", "s".repeat(513)],
    [
      "a credential-shaped value",
      "oauth-token-credential-marker-12345678901234567890",
    ],
    ["a host path", "/var/lib/agentport-runtime/.claude/session"],
  ])("rejects %s as a Session reference", (_label, sessionReference) => {
    expect(() =>
      sessionReferenceForExecution(
        {
          answer: "done",
          sessionReference,
          executionReference,
        },
        executionReference,
      ),
    ).toThrow("Claude returned an invalid Session reference");
  });

  it.each([
    ["ordinary ambient environment", {}],
    [
      "process-injection environment",
      {
        AGENTPORT_G1_CLEAN_ENV: "1",
        NODE_OPTIONS: "--import=/host/injection.mjs",
      },
    ],
  ])("refuses a root harness started from %s", (_label, environment) => {
    const result = spawnSync("/bin/sh", ["scripts/run-g1-claude.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: "/host/bin", ...environment },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("G1_CLAUDE_HARNESS_FAILED\n");
  });
});
