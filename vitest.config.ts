import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          BOOTSTRAP_SECRET: "test-bootstrap-secret-with-32-characters",
          PASSWORD_PEPPER: "test-password-pepper-with-at-least-32-characters",
          PASSWORD_RESET_SECRET: "test-password-reset-secret-with-32-characters",
          APP_ORIGIN: "https://app.maltworks.com.br",
          SESSION_TTL_DAYS: "30",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    testTimeout: 30_000,
  },
});
