# Organization plan policy — 10 Nov 2026

This increment implements the controller claim portion of API issue #23.
`src/plan-policy.ts` is the immutable server policy for the shipped controller
quota and history entitlements; history callers keep their existing exports.

| Plan | Linked controllers | History range | Aggregate access |
| --- | ---: | ---: | --- |
| Essencial (`essential`) | 1 | 7 days | Raw only |
| Plus (`plus`) | 2 | 90 days | Five-minute |
| Pro (`pro`) | 5 | 365 days | Five-minute and hourly |

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
The lockfile was not upgraded. Installation reported 11 dependency advisories
(2 moderate, 9 high); triage is separate from this claim-policy change.

## Remaining inconsistencies / commercial gates

- Recipes, fermentation/batches, density, exports and notifications do not yet
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
