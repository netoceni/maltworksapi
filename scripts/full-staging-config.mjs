import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const template = new URL("../wrangler.app-staging.example.jsonc", import.meta.url);
const forbidden = new Set(["a1bf5a75-1bec-4437-92fa-64e69c3da081", "26b9ecab-1aaa-4120-93a5-1c409555d28b"]);
const placeholder = "REPLACE_WITH_NEW_FULL_STAGING_D1_UUID";
const expectedVars = {
  APP_ORIGIN: "https://app-staging.maltworks.com.br", ADMIN_ORIGIN: "https://admin-staging.maltworks.com.br",
  SESSION_TTL_DAYS: "1", D1_BILLING_PLAN: "paid", TELEMETRY_PERSIST_INTERVAL_SECONDS: "180",
  TELEMETRY_RETENTION_DAYS: "0", HISTORY_5MIN_RETENTION_DAYS: "0", HISTORY_HOURLY_RETENTION_DAYS: "0",
  LAB_STAGING_ROLLUP_ONLY: "true", LAB_STAGING_ENABLE_RETENTION: "false",
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireCondition(ok, message) { if (!ok) throw new Error(message); }

export function validateFullStaging(config, { allowPlaceholder = false } = {}) {
  const keys = ["$schema", "account_id", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "routes", "observability", "vars", "r2_buckets", "durable_objects", "migrations", "d1_databases", "triggers", "send_email"];
  requireCondition(Object.keys(config).every(k => keys.includes(k)), "Unplanned external binding or config field");
  requireCondition(config.account_id === "4e8c08f70722d344cf39c362a110d706", "Wrong Cloudflare account");
  requireCondition(config.name === "maltworks-api-staging" && config.main === "src/index.ts", "Wrong full-staging Worker");
  requireCondition(config.compatibility_date === "2026-08-06" && equal(config.compatibility_flags, ["nodejs_compat"]), "Unexpected application runtime change");
  requireCondition(equal(config.observability, { enabled: true, traces: { enabled: true, head_sampling_rate: 1 } }), "Staging logs/traces must be explicit");
  requireCondition(config.workers_dev === false && config.preview_urls === false, "Public preview URLs forbidden");
  requireCondition(equal(config.routes, []) || equal(config.routes, [{ pattern: "api-staging.maltworks.com.br", custom_domain: true }]), "Unexpected hostname/route");
  requireCondition(config.d1_databases?.length === 1, "Exactly one staging D1 required");
  const db = config.d1_databases[0];
  requireCondition(db.binding === "DB" && db.database_name === "maltworks-app-staging" && db.migrations_dir === "migrations", "Wrong D1 identity");
  requireCondition(typeof db.database_id === "string" && !forbidden.has(db.database_id.toLowerCase()) &&
    ((allowPlaceholder && db.database_id === placeholder) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(db.database_id)), "A new D1 UUID, distinct from production and Lab, is required");
  requireCondition(Object.keys(db).every(k => ["binding", "database_name", "database_id", "migrations_dir"].includes(k)), "Unplanned D1 option, preview or remote dev binding");
  requireCondition(equal(config.durable_objects, { bindings: [{ name: "REALTIME", class_name: "RealtimeHub" }] }), "Cross-Worker DO binding forbidden");
  requireCondition(equal(config.migrations, [{ tag: "v1-realtime-app-staging", new_sqlite_classes: ["RealtimeHub"] }]), "Wrong dedicated DO migration");
  requireCondition(equal(config.r2_buckets, [{ binding: "FIRMWARE", bucket_name: "maltworks-staging-firmware" }, { binding: "BATCH_FILES", bucket_name: "maltworks-staging-batch-files" }]), "Only dedicated staging buckets are allowed");
  const maintenance = config.vars?.LAB_STAGING_ROLLUP_ONLY === "false";
  for (const [key, value] of Object.entries(expectedVars)) {
    requireCondition(config.vars?.[key] === (key === "LAB_STAGING_ROLLUP_ONLY" && maintenance ? "false" : value), "Unsafe staging variable: " + key);
  }
  requireCondition(equal(config.triggers, { crons: [maintenance ? "* * * * *" : "*/5 * * * *"] }), "Unexpected staging cron");
  requireCondition(!config.services?.length && !config.queues && !config.dispatch_namespaces?.length, "Unexpected external service binding");
  const extraVars = Object.keys(config.vars).filter(k => !Object.hasOwn(expectedVars, k));
  const email = config.send_email ?? [];
  requireCondition(Array.isArray(email), "Email bindings must be an array");
  if (email.length) {
    const to = config.vars.SALES_EMAIL_TO;
    requireCondition(typeof to === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(to) && !to.toLowerCase().endsWith("@maltworks.com.br"), "Use an approved external test inbox");
    requireCondition(equal(email, [{ name: "EMAIL", allowed_destination_addresses: [to] }]), "Email must restrict recipients to one test inbox");
    requireCondition(config.vars.SALES_EMAIL_FROM === "notificacoes@staging.maltworks.com.br" && config.vars.NOTIFICATION_EMAIL_FROM === config.vars.SALES_EMAIL_FROM, "Use the separately verified staging sender");
    requireCondition(extraVars.every(k => ["SALES_EMAIL_TO", "SALES_EMAIL_FROM", "NOTIFICATION_EMAIL_FROM"].includes(k)), "Unexpected variable or secret");
  } else requireCondition(extraVars.length === 0, "Email variables require an approved restricted binding");
  return config;
}

export function buildFullStaging({ databaseId, withDomain = false, withMaintenance = false, emailTo } = {}) {
  const config = JSON.parse(readFileSync(template, "utf8"));
  config.d1_databases[0].database_id = databaseId;
  if (withDomain) config.routes = [{ pattern: "api-staging.maltworks.com.br", custom_domain: true }];
  if (withMaintenance) {
    config.vars.LAB_STAGING_ROLLUP_ONLY = "false";
    config.triggers.crons = ["* * * * *"];
  }
  if (emailTo) {
    config.send_email = [{ name: "EMAIL", allowed_destination_addresses: [emailTo] }];
    Object.assign(config.vars, { SALES_EMAIL_FROM: "notificacoes@staging.maltworks.com.br", NOTIFICATION_EMAIL_FROM: "notificacoes@staging.maltworks.com.br", SALES_EMAIL_TO: emailTo });
  }
  return validateFullStaging(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) console.log("LOCAL ONLY: node scripts/full-staging-config.mjs <new-d1-uuid> [--with-domain] [--with-maintenance] [--email-to=inbox] [--write]. No network, provisioning or deploy.");
  else {
    requireCondition(args.every((a, i) => i === 0 || a === "--with-domain" || a === "--with-maintenance" || a === "--write" || a.startsWith("--email-to=")), "Unknown option");
    const config = buildFullStaging({ databaseId: args[0], withDomain: args.includes("--with-domain"), withMaintenance: args.includes("--with-maintenance"), emailTo: args.find(a => a.startsWith("--email-to="))?.slice(11) });
    if (args.includes("--write")) writeFileSync(new URL("../wrangler.app-staging.jsonc", import.meta.url), JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    else console.log(JSON.stringify(config, null, 2));
  }
}
