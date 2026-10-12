// Runs SQL against the deployed results database through Wrangler, so
// scripts need no API token beyond `wrangler login`.

import { execFileSync } from "node:child_process";

export const DATABASE = "cf-ai-memory-results";

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

/** Rows from one SELECT. */
export function query<T>(sql: string): T[] {
  const out = wrangler(["d1", "execute", DATABASE, "--remote", "--json", "--command", sql]);
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

/** Executes a SQL file (several statements). */
export function executeFile(path: string) {
  wrangler(["d1", "execute", DATABASE, "--remote", "--file", path, "--yes"]);
}

/** Quotes a value for SQL built in scripts (never for user-facing endpoints). */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function triggerWorkflow(name: string, id: string, params: unknown): string {
  return wrangler(["workflows", "trigger", name, JSON.stringify(params), "--id", id]);
}
