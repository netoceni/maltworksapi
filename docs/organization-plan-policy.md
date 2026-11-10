# Organization plan policy — 10 Nov 2026

This increment implements the controller claim portion of API issue #23.
`src/plan-policy.ts` is the immutable server policy for the shipped controller
quota and history entitlements; history callers keep their existing exports.

| Plan | Linked controllers | History range | Aggregate access | Cloud recipes | Batches / density |
| --- | ---: | ---: | --- | --- | --- |
| Essencial (`essential`) | 1 | 7 days | Raw only | No | No |
| Plus (`plus`) | 2 | 90 days | Five-minute | Yes | No |
| Pro (`pro`) | 5 | 365 days | Five-minute and hourly | Yes | Yes |

## Grants and enforcement

The existing `organization_history_plans` table now supplies both controller
and history policy. Its historical name is retained to avoid a schema migration
or a second, conflicting source of grants. Missing/unknown codes resolve to
Essencial. Valid rows remain **manual pilot grants**, not paid subscriptions.
There is no provider, subscription status, expiry, renewal or grace period yet.
An expired-subscription test would invent an absent lifecycle model; revoking
a manual grant and downgrading are tested instead. Do not claim billing support.

A new claim checks the current stored plan, indexed organization count and
unclaimed device in the same SQL UPDATE. It does not trust cached membership
plans or request fields. D1 serializes these writes. The audit insert uses
`changes()` in the same D1 batch transaction, so rejected claims do not create
success audits and audit failures roll back the assignment. Pairing credentials
are rechecked in the UPDATE to reject changes between validation and assignment.
No counter table, new migration, remote SQL or deployment is required.

Every linked controller counts, including offline/disabled rows. Unlinked
pending controllers consume no organization slot. Authorized deletion frees a
slot. Existing same-organization retry and credential rebind behavior is retained.
The existing organization membership permissions are unchanged; claim/rebind
currently use membership without an owner/admin-only role restriction, unlike
device deletion. Fine-grained mutation permissions need separate review.

## Downgrades and concurrency

Downgrading or revoking a grant never deletes devices/history, changes status,
revokes credentials, blocks telemetry, or stops device operation. A customer
over the new quota can keep every already-linked controller but cannot link a
new one until its count falls below the cap or the plan increases. Premium
history query authorization follows the current tier; archive retention remains
independent of a customer's downgrade.

A claim serialized before a downgrade can succeed under the old cap; after the
plan update commits, new assignments evaluate the lower cap. Already-linked
hardware is deliberately grandfathered, not evicted to satisfy the new cap.
Same-device competing claims cannot transfer hardware across organizations.
Quota rejection is HTTP 403 `CONTROLLER_PLAN_LIMIT_REACHED`; a competing device
assignment is HTTP 409 `DEVICE_ALREADY_CLAIMED`. Existing valid retries return
200 and credential rebind requests return 202, even above quota.

## Validation

`test/controller-plans.integration.spec.ts` exercises the genuine HTTP router,
cookie sessions and isolated D1 SQL, not a mocked database:

- Exact 1/2/5 boundaries and eight requests competing for the final slot per tier.
- Client entitlement overrides, both registration formats and cross-organization rejection.
- Same-device races and plan changes racing new claims.
- Pro -> Plus -> Essencial, grant revocation, retries, rebind, listing, latest
  state, all five devices authenticating and ingesting persisted telemetry.
- Disabled-device accounting, upgrade, deletion releasing capacity and indexed count.
- Failed audit rolling back the assignment without consuming capacity.

Run `npm run check`, `npm test`, and
`node --test scripts/maltworks-lab*.spec.mjs`. These use local resources only.
The restricted desktop runtime initially could not start `cloudflare:test-internal`;
the same installed dependencies passed when permitted to run the local runtime.
The original claim-policy increment did not upgrade dependencies and reported
11 advisories. Those records were subsequently triaged and patched in API #29,
now incorporated into integration; the full current audit reports zero known
vulnerabilities. See `dependency-triage-20261110.md` for versions and limitations.

## Remaining inconsistencies / commercial gates

- Exports and notifications do not yet
  have a complete centrally enforced commercial policy. Their product semantics,
  API gates and expired-subscription behavior remain work in #23.
- Raw `/v1/devices/:id/telemetry` now applies the same history plan windows as
  aggregate access. See the follow-up behavior and validation below.
- API #22 has passed CI but remains independent/unmerged. This branch is based
  on API #21 to include its portable Lab fixture/runtime fix. Review this PR
  against #21; after #21 merges, retarget this PR to main and rerun CI. Do not
  merge main as part of this task: the push workflow migrates remote D1 and deploys.
- API #22's PR description still says validation is pending despite successful
  CI. Admin source/package README remains 5.18 while its label references API 5.19.
- Account-wide Paid D1 billing monitoring is still outside #22's per-DB checks.
- Firmware release clearance remains tracked privately in Admin #5; no sensitive
  findings or exploitation details are copied into this public API repository.

## Admin staging validation without Cloudflare

Inspected Admin PR #4 head `d2f915d38bfd687682f657f7093d33b944b7ef14`.
`npm run check` passed all six local static checks. There is no `npm test` script.
The checks cover assets, JS syntax, HTML IDs, exact production/staging API host
selection, CSP and isolated Worker name/domain. The API staging example sets
`ADMIN_ORIGIN` to the same staging Admin host used by #4; CORS accepts the
configured origin. The source uses credentialed fetch and API admin handlers
require system-admin authorization. These are source/static observations.

Without Cloudflare/account access this does **not** establish DNS, deployed
Worker/version, actual API D1 isolation or migrations, Access policies/service
credentials, browser cookie/CORS behavior or a real admin login. The checked-in
API staging file is only an example with a placeholder D1 ID; it omits Admin
R2/email bindings and must not be mistaken for proof of a deployed full Admin
backend. Its guards deliberately restrict the telemetry Lab's resources.
No deployment, remote migration or live staging mutation was performed.

## Raw history authorization follow-up

The read-only raw history route resolves current organization entitlements from
D1 after device ownership authorization. Its access window is inclusive from
`serverNow - maxRangeSeconds` through `serverNow`: Essencial 7 days, Plus 90,
Pro 365. Missing grants default to Essencial. Query parameters cannot grant a
higher tier. The policy is evaluated on every request, including pagination.

- Explicit numeric `range` above the plan returns 403 `HISTORY_PLAN_REQUIRED`.
  Existing range syntax limits (15 seconds through 365 days) remain unchanged.
- `range=all` means all **available** raw samples in the current plan window.
  Counts, minimum/maximum timestamps, bucket sizing and points use that same
  window. Empty results retain the previous response shape.
- Omitted range and `before` pagination always keep the lower bound anchored
  to server time. Old cursors return an empty page; a future cursor cannot widen
  the window. The default cursor includes the current server second. Invalid,
  fractional, negative or unsafe integer cursors return 400
  `INVALID_HISTORY_CURSOR` instead of a database/server error.
- Short-window realtime points are filtered to the same requested time window.
  Existing short-range chart merging remains supported.
- Downgrades/revoked manual grants immediately restrict subsequent reads without
  deleting stored samples. Upgrades can expose retained samples again. No
  additional retention or long-term raw storage is promised by a paid tier:
  queries return only data still available under the independent retention policy.

Seven new real HTTP/D1 tests cover each plan (and missing grant), exact inclusive
boundary and one second too old, all/numeric/default/paginated queries, future
rows, metadata, malicious entitlement parameters, downgrades/revocation/upgrade,
tenant separation, authentication, invalid inputs and empty windows. They also
prove a downgraded device still ingests telemetry and exposes its latest state,
and that historical reads do not remove old samples. The existing sampling,
realtime, aggregate and controller quota tests remain in the full regression suite.

This follow-up is stacked on API #24 so only the raw-history change appears in
its diff. No migration, telemetry ingestion, device credentials, retention policy,
Worker configuration or workflow was changed. No merge/deploy is authorized.

## Cloud recipes follow-up (development only)

No physical devices are currently running; all validation uses simulated
controllers and isolated local/CI D1. This is not a hardware or deployed-system
validation report.

`canUseRecipes` in the central policy permits Plus and Pro and denies Essencial
or missing/invalid grants. Every public library handler (list/create/update/delete)
checks the current organization's stored grant after authentication, membership
and existing write-role checks. Failure is 403 `RECIPE_PLAN_REQUIRED`. Client
fields cannot override entitlements, and a paid plan does not override viewer
restrictions or tenant isolation. Library access is blocked on downgrade, including
read/delete; existing recipes/stages remain stored for a later upgrade.

Two other entry points use a cloud recipe: starting a new device profile and
associating a recipe when starting a fermentation record. Both now require the
same entitlement, preventing recipe-ID access from bypassing the library gate.
Existing batch snapshots are historical records, not library access. The batch/
density follow-up below now restricts their parent endpoints to Pro. Plus recipe
access alone does not grant batch or density access.

The gate authorizes new requests; it does not cancel commands accepted before a
downgrade or interrupt profiles already on a controller. Telemetry, command
confirmation/delivery and pause/resume/stop remain independent of the recipe tier.
Manual setpoint, alarms and configuration retain their existing safety and role
checks. No credentials, retention, schema or control-safety code was changed.
A request authorized before a concurrent grant change may complete; subsequent
requests resolve the new grant from D1. Subscription expiry remains unimplemented
because there is no subscription lifecycle yet; manual revocation defaults to
Essencial and is tested.

Seven new tests exercise real HTTP routes and D1 with simulated telemetry:
missing/Essencial denial with zero recipe/audit/command/batch mutations, Plus/Pro
CRUD and use, request override attempts, viewer restrictions, cross-tenant recipe
IDs and organization selection, grant revocation/upgrade and downgrade preservation.
A simulated profile accepted before downgrade is delivered and acknowledged;
pause/resume/stop are confirmed after downgrade and manual setpoint remains usable.
The existing broad API regression explicitly grants Plus for its recipe scenario.
History helpers project only their existing fields to preserve their return shape.

This recipe increment is stacked on API #25. Review its isolated diff, then
retarget and rerun CI after dependencies are handled in a separately authorized
release process. No merge, deploy or remote migration was performed.

## Batches and density follow-up (development only)

Central `canUseBatches` and `canUseDensity` flags are true only for Pro. Missing,
revoked or unrecognized grants default to Essencial. New requests read the
selected organization's current D1 grant; body/query flags cannot override it.
There are still no real devices running. All checks use simulated controllers
and isolated D1/R2; no hardware or deployed environment was exercised.

| Endpoint group | Gate | Denial |
| --- | --- | --- |
| Batch list, detail, update and compare | Pro batches | 403 BATCH_PLAN_REQUIRED |
| Ingredient and journal additions/deletions | Pro batches | 403 BATCH_PLAN_REQUIRED |
| Attachment upload, download and delete | Pro batches, before R2 access | 403 BATCH_PLAN_REQUIRED |
| Device fermentation get, start and finish | Pro batches | 403 BATCH_PLAN_REQUIRED |
| Device gravity reading add/delete | Pro density | 403 DENSITY_PLAN_REQUIRED |

Batch detail/list/compare and fermentation responses include gravity or derived
metrics, so their whole endpoints require Pro; there is no free summary exposing
paid data. Writes through `finalGravity`, `plannedFinalGravity` and finish payloads
are covered by the same batch gate. Starting without a recipe is also gated.
Plus retains library CRUD/new recipe profiles but cannot attach a recipe to a
new batch because starting any batch requires Pro. Existing recipe tests now
assert this distinction; the broad API test explicitly grants Pro at its batch
scenario while preserving Plus for its earlier recipe scenario.

After downgrade/revocation, all batch/density reads and writes (including cloud
finish and historical recipe snapshots inside batch records) are blocked. The
system retains records, readings, ingredients, journal and attachment objects;
a Pro regrant restores access. No automatic deletion, finishing or command
cancellation occurs. Cloud fermentation finish only updates a record, not a
controller profile. Device telemetry, basic setpoint/control and profile
pause/resume/stop keep their existing authorization/safety rules independently.
As with recipes, requests authorized before a concurrent grant change can finish;
subsequent requests use the new grant. Subscription expiry is not invented here.

Seven new tests cover all 16 endpoint/method combinations for missing/revoked,
Essencial and Plus grants, including direct API overrides and comparisons. D1
row/audit snapshots and R2 keys/content remain unchanged on denial. Pro lifecycle,
metrics, readings, attachments and child CRUD, viewer write restrictions, foreign
organizations, session requirements, explicit organization selection and restored
access are checked. A simulated profile accepted before downgrade still receives
telemetry delivery/ack and pause/resume/stop, and basic setpoint remains available.
Existing full API/recipe/history/quota regressions remain part of the suite.

This increment is stacked on API #26. No schema, ingestion, commands, credentials,
retention, Worker configuration or workflow was changed. No remote SQL, deployment
or merge was performed. Exports, notifications, subscription lifecycle and firmware
clearance remain separate work; issue #23 is not closed by this increment.
