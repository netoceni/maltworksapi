#!/usr/bin/env python3
"""Reproducible isolated SQLite workload for Maltworks intelligent history.

NOT a remote Cloudflare D1, HTTP Worker, or Durable Object load test.
Runs the actual migration 0017 and the same summary SQL as history-rollup.ts.
Only standard-library Python modules are required.

Examples:
  python3 scripts/simulate_history_capacity.py --devices 1,5,10,25,50,100
  python3 scripts/simulate_history_capacity.py --devices 10,25,50 --event-percent 2
"""

import argparse
import json
import math
import sqlite3
import tempfile
import time
from pathlib import Path

DAY = 86400
FREE_D1_WRITES = 100000
FREE_WORKER_REQUESTS = 100000
FREE_DB_BYTES = 500000000
RAW_DELETE_CAP = 400 * 144
FINE_DELETE_CAP = 250 * 144
HOURLY_DELETE_CAP = 100 * 144
BASE_SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE devices(id TEXT PRIMARY KEY);
CREATE TABLE telemetry(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id),
  boot_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  received_at INTEGER NOT NULL, sent_at INTEGER NOT NULL,
  refrigerator_value REAL, thermal_well_value REAL,
  setpoint REAL NOT NULL, control_state TEXT NOT NULL,
  cooling INTEGER NOT NULL, heating INTEGER NOT NULL, alarms_active INTEGER NOT NULL,
  rssi INTEGER NOT NULL, payload_json TEXT NOT NULL,
  UNIQUE(device_id, boot_id, sequence)
);
CREATE INDEX idx_telemetry_device_received ON telemetry(device_id, received_at DESC);
CREATE INDEX idx_telemetry_received_at_id ON telemetry(received_at ASC,id ASC);
"""
HISTORY_COLUMNS = (
    "device_id,bucket_start,samples,refrigerator_count,refrigerator_sum,"
    "refrigerator_min,refrigerator_max,thermal_well_count,thermal_well_sum,"
    "thermal_well_min,thermal_well_max,setpoint_sum,setpoint_min,setpoint_max,"
    "cooling_samples,heating_samples,alarm_samples,rssi_sum,updated_at"
)


def rollup_sql(resolution):
    if resolution not in (300, 3600):
        raise ValueError("Invalid resolution")
    table = "history_5min" if resolution == 300 else "history_hourly"
    bucket = f"CAST(received_at / {resolution} AS INTEGER) * {resolution}"
    selects = (
        f"device_id,{bucket},COUNT(*),COUNT(refrigerator_value),"
        "COALESCE(SUM(refrigerator_value),0),MIN(refrigerator_value),"
        "MAX(refrigerator_value),COUNT(thermal_well_value),"
        "COALESCE(SUM(thermal_well_value),0),MIN(thermal_well_value),"
        "MAX(thermal_well_value),SUM(setpoint),MIN(setpoint),MAX(setpoint),"
        "SUM(cooling),SUM(heating),SUM(alarms_active),SUM(rssi),?"
    )
    updates = ",".join(
        f"{column}=excluded.{column}"
        for column in HISTORY_COLUMNS.split(",")[2:]
    )
    return (
        f"INSERT INTO {table} ({HISTORY_COLUMNS}) SELECT {selects} FROM telemetry "
        f"WHERE received_at>=? AND received_at<? GROUP BY device_id,{bucket} "
        f"ON CONFLICT(device_id,bucket_start) DO UPDATE SET {updates}"
    )


def size_bytes(db):
    return db.execute("PRAGMA page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0]


def sample_rows(devices, start, payload, every_event):
    for minute in range(1440):
        timestamp = start + 60 * minute
        for unit in range(devices):
            device = f"MW-{unit:012X}"
            temperature = round(18 + ((minute + unit) % 30) * 0.03, 2)
            well = None if (minute + unit) % 50 == 0 else temperature - 0.1
            cooling = int((minute + unit) % 20 < 8)
            yield (
                device, "AA001122", minute * 2, timestamp, timestamp, temperature,
                well, 18.0, "COOLING" if cooling else "STABLE",
                cooling, 0, 0, -56, payload,
            )
            if every_event and (minute + unit * 7) % every_event == 0:
                yield (
                    device, "AA001122", minute * 2 + 1, timestamp + 30, timestamp + 30,
                    temperature + 0.1, well, 18.0, "ALARM", cooling, 0, 1, -56, payload,
                )


def workload(count, payload_bytes, event_percent, directory):
    db = sqlite3.connect(directory / f"maltworks-history-{count}.db")
    db.execute("PRAGMA synchronous=OFF")  # Local-only performance measurement.
    db.executescript(BASE_SCHEMA)
    migration_path = Path(__file__).resolve().parents[1] / "migrations" / "0017_intelligent_history.sql"
    db.executescript(migration_path.read_text(encoding="utf-8"))
    db.executemany("INSERT INTO devices VALUES(?)", [(f"MW-{unit:012X}",) for unit in range(count)])
    db.commit()
    baseline = size_bytes(db)

    prefix = '{"benchmark":true,"padding":"'
    payload = prefix + "x" * max(0, payload_bytes - len(prefix) - 2) + '"}'
    start = 1_800_000_000 - (1_800_000_000 % 3600)
    end = start + DAY
    event_every = round(100 / event_percent) if event_percent else None
    insert = (
        "INSERT INTO telemetry(device_id,boot_id,sequence,received_at,sent_at,"
        "refrigerator_value,thermal_well_value,setpoint,control_state,cooling,heating,"
        "alarms_active,rssi,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    t0 = time.perf_counter()
    buffer = []
    for row in sample_rows(count, start, payload, event_every):
        buffer.append(row)
        if len(buffer) == 10000:
            db.executemany(insert, buffer)
            buffer.clear()
    if buffer:
        db.executemany(insert, buffer)
    db.commit()
    insert_ms = (time.perf_counter() - t0) * 1000
    after_raw = size_bytes(db)
    t0 = time.perf_counter()
    db.execute(rollup_sql(300), (end, start, end))
    db.commit()
    fine_ms = (time.perf_counter() - t0) * 1000
    after_fine = size_bytes(db)
    t0 = time.perf_counter()
    db.execute(rollup_sql(3600), (end, start, end))
    db.commit()
    hourly_ms = (time.perf_counter() - t0) * 1000
    after_hourly = size_bytes(db)
    raw = db.execute("SELECT COUNT(*) FROM telemetry").fetchone()[0]
    fine = db.execute("SELECT COUNT(*) FROM history_5min").fetchone()[0]
    hourly = db.execute("SELECT COUNT(*) FROM history_hourly").fetchone()[0]
    assert raw == db.execute("SELECT COALESCE(SUM(samples),0) FROM history_5min").fetchone()[0]
    assert raw == db.execute("SELECT COALESCE(SUM(samples),0) FROM history_hourly").fetchone()[0]

    queries = []
    for unit in range(min(10, count)):
        device = f"MW-{unit:012X}"
        for _ in range(10):
            t0 = time.perf_counter()
            db.execute(
                "SELECT bucket_start,samples,refrigerator_sum * 1.0 / samples "
                "FROM history_5min WHERE device_id=? ORDER BY bucket_start DESC LIMIT 288",
                (device,),
            ).fetchall()
            queries.append((time.perf_counter() - t0) * 1000)
    queries.sort()
    p95 = queries[math.ceil(len(queries) * 0.95) - 1]
    raw_bytes = (after_raw - baseline) / max(raw, 1)
    fine_bytes = (after_fine - after_raw) / max(fine, 1)
    hour_bytes = (after_hourly - after_fine) / max(hourly, 1)
    steady_bytes = raw_bytes * raw * 7 + fine_bytes * fine * 90 + hour_bytes * hourly * 365

    # D1 has a different engine, API latency, billing, and index accounting.
    # This is deliberately a range: 3 principal writes per stored snapshot
    # versus a heuristic 8 based on the previous production observation.
    extra_ops = raw + fine * 2 + hourly * 2
    result = {
        "devices": count,
        "http_requests_day": count * DAY // 5,
        "persisted_rows_day": raw,
        "five_min_rows_day": fine,
        "hourly_rows_day": hourly,
        "sqlite_db_mb_after_24h": round(after_hourly / 1e6, 2),
        "sqlite_insert_ms": round(insert_ms, 1),
        "sqlite_rollup_5min_ms": round(fine_ms, 1),
        "sqlite_rollup_hour_ms": round(hourly_ms, 1),
        "sqlite_query_p95_ms": round(p95, 3),
        "steady_db_mb_projection": round(steady_bytes / 1e6, 1),
        "d1_daily_writes_lower_estimate": raw * 3 + extra_ops,
        "d1_daily_writes_heuristic_estimate": raw * 8 + extra_ops,
        "raw_delete_capacity_day": RAW_DELETE_CAP,
        "raw_backlog_growth_day": max(0, raw - RAW_DELETE_CAP),
        "fine_delete_capacity_day": FINE_DELETE_CAP,
        "fine_backlog_growth_day": max(0, fine - FINE_DELETE_CAP),
        "hourly_delete_capacity_day": HOURLY_DELETE_CAP,
        "hourly_backlog_growth_day": max(0, hourly - HOURLY_DELETE_CAP),
        "workers_free_request_limit_day": FREE_WORKER_REQUESTS,
        "d1_free_written_row_limit_day": FREE_D1_WRITES,
        "d1_free_db_limit_bytes": FREE_DB_BYTES,
    }
    db.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--devices", default="1,5,10,25,50,100")
    parser.add_argument("--payload-bytes", type=int, default=900)
    parser.add_argument("--event-percent", type=float, default=0)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    devices = [int(item) for item in args.devices.split(",")]
    if not devices or any(item < 1 or item > 300 for item in devices):
        parser.error("--devices: comma-separated counts from 1 to 300")
    if args.payload_bytes < 200 or args.payload_bytes > 5000:
        parser.error("--payload-bytes must be 200..5000")
    if args.event_percent < 0 or args.event_percent > 50:
        parser.error("--event-percent must be 0..50")
    with tempfile.TemporaryDirectory(prefix="maltworks-history-") as directory:
        results = [
            workload(item, args.payload_bytes, args.event_percent, Path(directory))
            for item in devices
        ]
    output = {
        "type": "isolated SQLite SQL workload + analytical platform capacity",
        "duration_hours": 24,
        "payload_bytes_assumed": args.payload_bytes,
        "event_percent_assumed": args.event_percent,
        "note": "Do not interpret local SQL latency as live D1 latency or heuristics as billed rows.",
        "scenarios": results,
    }
    rendered = json.dumps(output, indent=2) + "\n"
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
