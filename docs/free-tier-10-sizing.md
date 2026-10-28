# Maltworks — Free pilot sizing for 10 controllers (28 October 2026)

Status: API PR #17 in review; **not deployed**. Firmware cadence is developed
separately in Controller PR #3. The live production database remains
`maltworks-recovery-20261027`; no migration, deletion or database rebind
is part of this change.

## Cloudflare Free limits (verified 2026-10-28)

- Workers: 100,000 requests per day **across the account**, 10 ms CPU per
  HTTP request/cron invocation.
- SQLite Durable Objects: 100,000 billed requests per day, including
  WebSocket messages and Worker-to-DO RPC sessions; 100,000 SQL rows
  written per day (and separate storage/duration limits).
- D1: 100,000 rows written and 5 million rows read per day,
  500 MB per database, 5 GB total storage per account.
- Quotas generally reset at midnight UTC, not midnight Brasília.
- **Each quota is independent.** A Worker request does not equal one D1
  row write. Indexes, deletes, summary UPSERTs and extra requests matter.

Primary references:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/

## Target operating parameters

| Variable | Target |
| --- | --- |
| Pilot maximum | 10 simultaneously reporting controllers |
| HTTP telemetry interval | 30 seconds (firmware PR #3) |
| WebSocket heartbeat | 30 seconds (firmware PR #3) |
| D1 steady telemetry persistence | 180 seconds (API PR #17) |
| DO presence SQL write coalescing | 20 seconds |
| Offline detection | 90 seconds |
| DO outage D1 persistence limit | 180 seconds |
| Raw telemetry retention | 7 days |
| D1 cleanup limit | 250 expired rows / 10 minutes |
| Archive | Pending API PR #14; 5-minute and hourly rollups |

## 24-hour continuous fleet budget (10 devices)

| Metric | Computation | Forecast |
| --- | --- | ---: |
| Workers HTTP telemetry | 10 × 86,400 / 30 | 28,800 requests |
| Durable Objects HTTP RPC | 10 × 86,400 / 30 | 28,800 requests |
| Durable Objects WS heartbeat | 10 × 86,400 / 30 | 28,800 messages |
| Durable Objects combined | 28,800 + 28,800 | 57,600 requests |
| Stable D1 raw snapshots | 10 × 86,400 / 180 | 4,800 snapshots |
| Five-minute summaries | 10 × 86,400 / 300 | 2,880 bucket rows |
| Hourly summaries | 10 × 86,400 / 3600 | 240 bucket rows |

The 2026-10-28 production diagnostic showed ~8.3 D1 written rows
per HTTP-persisted sample, **including other backend activity**. As a
conservative heuristic (not a billing guarantee), using 8 written rows
per snapshot and 2% event overhead gives about 39,168 written rows/day
for ingestion, ~9,792 for eventual snapshot cleanup (factor of 2),
and ~6,240 for rollup inserts (factor of 2): **~55,200/day total
in this simplified model**. Command results, notifications, SQL indexes,
retries, multiple browser sessions, higher alarm rates, cleanup of old
historical backlog and other Workers are not fully modeled.

Current DO presence coalescing skips near-duplicate updates within
20 seconds, bounding the write rate toward at most 43,200 logical
presence updates/day for ten devices, before indices and overhead.
DO request count is unaffected by SQL write coalescing.

### Headroom and safeguards
- Budget an operating target **below 80%** of any daily quota, not 99%.
- Cloud traffic is the sum of all devices and browser usage. Free does
  not guarantee ten users simultaneously browsing continuously.
- Test a prolonged DO failure. The API deliberately does not revert to
  30-second D1 writes, preventing an outage from also exhausting D1.
- A configured ESP32 still sending HTTP at 5 seconds will produce
  17,280 requests/day **for one device**. The firmware default change
  does **not** override existing NVS settings. Manually adjust already
  provisioned units when hardware becomes available.
- Offline thresholds apply to the 30s pilot. Long telemetry intervals
  configured manually need an updated presence policy; don't configure
  above 30 seconds for this pilot without reviewing offline detection.
- The D1 500 MB cap is **storage**, not a count of devices or a
  preallocated 500 MB memory setting. Avoid recreating the D1 database.

## Deployment dependency and acceptance

1. Test API #17 in isolated D1 and verify 180s snapshots, 90s presence,
   command handling, OTA checks, alarms, 20s DO coalescing.
2. Compile Controller PR #3; test 30s NVS defaults/heartbeat on hardware
   when available and manually change any existing saved 5s settings.
3. For History #14, update local capacity test to 10 devices, 30s HTTP,
   30s heartbeat, 180s D1. Keep the raw cleanup at 250/10min.
4. Confirm with Cloudflare metrics Workers requests, DO requests/SQL writes,
   D1 rows_written/rows_read/storage and errors; they do not all appear
   in the same D1 read-only workflow.
5. Only then evaluate a controlled production rollout. No write actions,
   backups restored, migration or firmware flashing are included here.

The Maltworks Lab PR #16 can generate fake telemetry for these scenarios,
but it **does not connect to Cloudflare**. It cannot currently validate
real quotas, connection lifetime or hardware behavior.
