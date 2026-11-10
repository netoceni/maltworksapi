import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFullStaging, validateFullStaging } from "./full-staging-config.mjs";
const id = "11111111-2222-4333-8444-555555555555";
test("full staging is private by default and rejects production/Lab resource reuse", () => {
  const c = buildFullStaging({ databaseId: id });
  assert.deepEqual(c.routes, []); assert.equal(c.send_email, undefined);
  for (const bad of [undefined, "REPLACE_WITH_NEW_FULL_STAGING_D1_UUID", "a1bf5a75-1bec-4437-92fa-64e69c3da081", "26b9ecab-1aaa-4120-93a5-1c409555d28b"]) assert.throws(() => buildFullStaging({ databaseId: bad }));
  const template = JSON.parse(readFileSync(new URL("../wrangler.app-staging.example.jsonc", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateFullStaging(template, { allowPlaceholder: true }));
  assert.throws(() => validateFullStaging(template));
});
test("full staging rejects incorrect routes, shared buckets, DOs, remote dev and cron", () => {
  for (const mutate of [c => c.routes.push({ pattern: "api.maltworks.com.br", custom_domain: true }),
    c => c.r2_buckets[0].bucket_name = "maltworks-firmware", c => c.durable_objects.bindings[0].script_name = "maltworks-api",
    c => c.kv_namespaces = [{ binding: "KV", id: "unexpected" }], c => c.workers_dev = true, c => c.preview_urls = true, c => c.d1_databases[0].remote = true,
    c => c.vars.APP_ORIGIN = "https://app.maltworks.com.br", c => c.vars.HISTORY_5MIN_RETENTION_DAYS = "90",
    c => c.triggers.crons = ["* * * * *"], c => c.vars.PASSWORD_PEPPER = "do-not-store-secrets",
    c => c.account_id = "another-account", c => c.send_email = { name: "EMAIL" }, c => c.observability.enabled = false]) {
    const c = buildFullStaging({ databaseId: id }); mutate(c); assert.throws(() => validateFullStaging(c));
  }
});
test("domain cutover is explicit and optional email is restricted to a test inbox", () => {
  const c = buildFullStaging({ databaseId: id, withDomain: true, emailTo: "qa@example.test" });
  assert.equal(c.routes[0].pattern, "api-staging.maltworks.com.br");
  assert.deepEqual(c.send_email[0].allowed_destination_addresses, ["qa@example.test"]);
  c.send_email = [{ name: "EMAIL" }]; assert.throws(() => validateFullStaging(c));
  assert.throws(() => buildFullStaging({ databaseId: id, emailTo: "qa@maltworks.com.br" }));
});

test("full cron is opt-in and never enables retention", () => {
  const c = buildFullStaging({ databaseId: id, withMaintenance: true });
  assert.deepEqual(c.triggers.crons, ["* * * * *"]);
  assert.equal(c.vars.LAB_STAGING_ROLLUP_ONLY, "false");
  for (const k of ["TELEMETRY_RETENTION_DAYS", "HISTORY_5MIN_RETENTION_DAYS", "HISTORY_HOURLY_RETENTION_DAYS"]) {
    assert.equal(c.vars[k], "0");
    const changed = structuredClone(c); changed.vars[k] = "1";
    assert.throws(() => validateFullStaging(changed));
  }
});
