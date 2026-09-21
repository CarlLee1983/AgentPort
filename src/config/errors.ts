import type { ZodError } from "zod";

export interface ConfigError {
  path: string;
  message: string;
}

/**
 * 把 zod issue 的 path（如 `["agents", 1, "workspace"]`）轉成 `agents[1].workspace`。
 */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${String(segment)}]`;
    } else {
      const key = String(segment);
      result += result ? `.${key}` : key;
    }
  }
  return result || "$";
}

export function zodIssuesToConfigErrors(
  issues: ZodError["issues"],
): ConfigError[] {
  return issues.map((issue) => {
    if (issue.code === "unrecognized_keys") {
      return {
        path: formatIssuePath(issue.path),
        message: `未知欄位：${issue.keys.join(", ")}`,
      };
    }
    return { path: formatIssuePath(issue.path), message: issue.message };
  });
}
