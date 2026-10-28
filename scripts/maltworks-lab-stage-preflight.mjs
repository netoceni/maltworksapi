#!/usr/bin/env node
/**
 * Fail-closed staging configuration guard. Does not call Cloudflare or deploy.
 * Run before any Wrangler migration/deploy using an isolated staging config.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RECOVERED_PRODUCTION_D1_UUID = "a1bf5a75-1bec-4437-92fa-64e69c3da081";

export function validateLabStageConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Invalid staging config");
  if (config.name !== "maltworks-api-lab-staging" || config.main !== "src/index.ts" ||
      config.workers_dev !== false) {
    throw new Error("Staging must use a dedicated Worker and disable workers.dev");
  }
  if (config.triggers?.crons?.length) {
    throw new Error("Lab staging cron is disabled until resource budgets are validated");
  }
  if (config.r2_buckets?.length || config.send_email?.length || config.queues ||
      config.services?.length) {
    throw new Error("Lab staging cannot inherit production email, R2, queue or service bindings");
  }
  if (config.d1_databases?.length !== 1) {
    throw new Error("Lab staging requires exactly one separate D1 binding");
  }
  const [db] = config.d1_databases;
  if (db.binding !== "DB" || db.database_name !== "maltworks-lab-staging" ||
      !UUID.test(db.database_id) ||
      db.database_id.toLowerCase() === RECOVERED_PRODUCTION_D1_UUID ||
      db.migrations_dir !== "migrations") {
    throw new Error("Lab staging D1 must be a new, valid and separate database");
  }
  if (!Array.isArray(config.durable_objects?.bindings) ||
      config.durable_objects.bindings.length !== 1 ||
      config.durable_objects.bindings[0].name !== "REALTIME" ||
      config.durable_objects.bindings[0].class_name !== "RealtimeHub") {
    throw new Error("Lab staging requires its own RealtimeHub binding");
  }
  if (!Array.isArray(config.migrations) || config.migrations.length !== 1 ||
      config.migrations[0].tag !== "v1-realtime-lab-staging") {
    throw new Error("Lab staging must use a separate DO migration namespace");
  }
  if (config.vars?.APP_ORIGIN !== "https://app-staging.maltworks.com.br" ||
      config.vars?.ADMIN_ORIGIN !== "https://admin-staging.maltworks.com.br" ||
      config.vars?.TELEMETRY_PERSIST_INTERVAL_SECONDS !== "180") {
    throw new Error("Lab staging must not use production origins or telemetry config");
  }
  for (const key of Object.keys(config.vars ?? {})) {
    if (/(secret|token|pepper|password|private_key)/i.test(key)) {
      throw new Error("Never put secrets into versioned Wrangler vars");
    }
  }
  const routes = config.routes ?? [];
  if (!Array.isArray(routes) || routes.some((route) =>
    typeof route !== "object" ||
    route.pattern !== "api-staging.maltworks.com.br/*" ||
    route.zone_name !== "maltworks.com.br")) {
    throw new Error("Staging route must only target api-staging.maltworks.com.br");
  }
  return {
    worker: config.name,
    database: db.database_name,
    databaseId: db.database_id,
    routesConfigured: routes.length > 0,
    workersDevDisabled: true,
    cronDisabled: true,
    emailAndFirmwareBindingsDisabled: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error("Supply the dedicated staging config file path");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const result = validateLabStageConfig(config);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write("Lab staging config rejected: " + error.message + "\n");
    process.exitCode = 1;
  }
}
