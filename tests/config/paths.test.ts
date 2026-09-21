import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfigPath } from "../../src/config/paths.js";

describe("resolveConfigPath 的四段優先順序", () => {
  it("有 --config 時優先使用", () => {
    const result = resolveConfigPath("/from/cli.toml", {
      AGENTPORT_CONFIG: "/from/env.toml",
      XDG_CONFIG_HOME: "/from/xdg",
      HOME: "/home/user",
    });

    expect(result).toBe("/from/cli.toml");
  });

  it("沒有 --config 時使用 AGENTPORT_CONFIG", () => {
    const result = resolveConfigPath(undefined, {
      AGENTPORT_CONFIG: "/from/env.toml",
      XDG_CONFIG_HOME: "/from/xdg",
      HOME: "/home/user",
    });

    expect(result).toBe("/from/env.toml");
  });

  it("沒有 --config 與 AGENTPORT_CONFIG 時使用 XDG_CONFIG_HOME", () => {
    const result = resolveConfigPath(undefined, {
      XDG_CONFIG_HOME: "/from/xdg",
      HOME: "/home/user",
    });

    expect(result).toBe(join("/from/xdg", "agentport", "agentport.toml"));
  });

  it("以上皆無時 fallback 到 HOME/.config", () => {
    const result = resolveConfigPath(undefined, { HOME: "/home/user" });

    expect(result).toBe(
      join("/home/user", ".config", "agentport", "agentport.toml"),
    );
  });
});
