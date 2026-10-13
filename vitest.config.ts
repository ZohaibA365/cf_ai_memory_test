import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the real Workers runtime (Miniflare). Remote bindings are
// off, so tests never call Workers AI: agents use the mock model
// (MODEL_MODE "mock") unless a test sets its own, and D1 is a local copy
// with the real migrations applied (test/setup.ts).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        // Test-only: the runtime needs sub-agent (facet) classes listed as
        // Durable Objects to create them here (Agents SDK docs, "Notes for
        // testing"). Production has no Judge binding; see wrangler.jsonc.
        durableObjects: { Judge: { className: "Judge" } },
        bindings: {
          MODEL_MODE: "mock",
          TEST_MIGRATIONS: await readD1Migrations("./migrations")
        }
      }
    }))
  ],
  test: {
    setupFiles: ["./test/setup.ts"]
  }
});
