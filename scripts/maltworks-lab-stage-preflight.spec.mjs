import assert from "node:assert/strict";
import test from "node:test";
import { validateLabStageConfig } from "./maltworks-lab-stage-preflight.mjs";

const separateD1 = "a0b1c2d3-1234-4567-8abc-a123456789ab";
function stageConfig() {
  return {
    name: "maltworks-api-lab-staging",
    main: "src/index.ts",
    workers_dev: false,
    preview_urls: false,
    vars: {
      APP_ORIGIN: "https://app-staging.maltworks.com.br",
      ADMIN_ORIGIN: "https://admin-staging.maltworks.com.br",
      TELEMETRY_PERSIST_INTERVAL_SECONDS: "180",
      TELEMETRY_RETENTION_DAYS: "0",
      HISTORY_5MIN_RETENTION_DAYS: "0",
      HISTORY_HOURLY_RETENTION_DAYS: "0",
      LAB_STAGING_ROLLUP_ONLY: "true",
    },
    durable_objects: { bindings: [{ name: "REALTIME", class_name: "RealtimeHub" }] },
    migrations: [{ tag: "v1-realtime-lab-staging", new_sqlite_classes: ["RealtimeHub"] }],
    d1_databases: [{
      binding: "DB", database_name: "maltworks-lab-staging",
      database_id: separateD1, migrations_dir: "migrations",
    }],
  };
}

test("staging config accepts only dedicated resources without cron", () => {
  const valid = validateLabStageConfig(stageConfig());
  assert.equal(valid.worker, "maltworks-api-lab-staging");
  assert.equal(valid.databaseId, separateD1);
  assert.equal(valid.workersDevDisabled, true);
  assert.equal(valid.cronDisabled, true);
});

test("staging permits only the approved five-minute rollup cron", () => {
  const cfg = stageConfig();
  cfg.triggers = { crons: ["*/5 * * * *"] };
  const valid = validateLabStageConfig(cfg);
  assert.equal(valid.cronDisabled, false);
  assert.equal(valid.cronSchedule, "*/5 * * * *");

  for (const crons of [
    ["* * * * *"],
    ["*/10 * * * *"],
    ["*/5 * * * *", "*/5 * * * *"],
    ["*/5 * * * *", "* * * * *"],
  ]) {
    assert.throws(() => validateLabStageConfig({ ...cfg, triggers: { crons } }));
  }
  assert.throws(() => validateLabStageConfig({ ...cfg, triggers: { crons: "*/5 * * * *" } }));
});

test("staging config rejects production Worker, public workers.dev and database", () => {
  const change = (modify) => {
    const cfg = stageConfig();
    modify(cfg);
    assert.throws(() => validateLabStageConfig(cfg));
  };
  change((c) => { c.name = "maltworks-api"; });
  change((c) => { c.workers_dev = true; });
  change((c) => { c.preview_urls = true; });
  change((c) => { delete c.preview_urls; });
  change((c) => { c.d1_databases[0].database_id = "a1bf5a75-1bec-4437-92fa-64e69c3da081"; });
  change((c) => { c.d1_databases[0].database_id = "REPLACE_WITH_NEW_STAGING_D1_UUID"; });
  change((c) => { c.d1_databases[0].database_name = "maltworks-recovery-20261027"; });
});

test("staging config rejects production email, R2, cron and dangerous routes", () => {
  const change = (modify) => {
    const cfg = stageConfig();
    modify(cfg);
    assert.throws(() => validateLabStageConfig(cfg));
  };
  change((c) => { c.triggers = { crons: ["* * * * *"] }; });
  change((c) => { c.send_email = [{ name: "EMAIL" }]; });
  change((c) => { c.r2_buckets = [{ binding: "FIRMWARE", bucket_name: "maltworks-firmware" }]; });
  change((c) => { c.routes = [{ pattern: "api.maltworks.com.br/*", zone_name: "maltworks.com.br" }]; });
  change((c) => { c.vars.APP_ORIGIN = "https://app.maltworks.com.br"; });
  change((c) => { c.vars.PASSWORD_PEPPER = "should-not-be-in-versioned-files"; });
  change((c) => { c.vars.TELEMETRY_RETENTION_DAYS = "7"; });
  change((c) => { delete c.vars.HISTORY_5MIN_RETENTION_DAYS; });
  change((c) => { c.vars.HISTORY_HOURLY_RETENTION_DAYS = "365"; });
  change((c) => { c.vars.LAB_STAGING_ROLLUP_ONLY = "false"; });
  const allowed = stageConfig();
  allowed.routes = [{ pattern: "api-staging.maltworks.com.br/*", zone_name: "maltworks.com.br" }];
  assert.equal(validateLabStageConfig(allowed).routesConfigured, true);
});
