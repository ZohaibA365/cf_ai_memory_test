// Runs SQL against the deployed results database through Wrangler, so
// scripts need no API token beyond `wrangler login`.

import { execFileSync } from "node:child_process";

export const DATABASE = "cf-ai-memory-results";

function run(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

function wrangler(args: string[]): string {
  try {
    try {
      return run(args);
    } catch (error) {
      // The OAuth token can expire mid-session ("Authentication error
      // [code: 10000]", or "not authorized" [code: 7403]); `wrangler whoami`
      // refreshes it, then retry once.
      const text = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
      if (!/code: (10000|7403)|Authentication error/i.test(text)) throw error;
      run(["whoami"]);
      return run(args);
    }
  } catch (error) {
    // Surface the API's own message (e.g. "no such column") instead of a
    // stack trace.
    const out = String((error as { stdout?: string }).stdout ?? "");
    try {
      const parsed = JSON.parse(out) as { error?: { text?: string; notes?: { text: string }[] } };
      const notes = parsed.error?.notes?.map((n) => n.text).join("; ");
      throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed: ${notes || parsed.error?.text || out}`);
    } catch (parseError) {
      if (parseError instanceof Error && parseError.message.startsWith("wrangler")) throw parseError;
      throw error;
    }
  }
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
