import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

// TEST_MIGRATIONS is set only in vitest.config.ts, so it is not on Env.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
