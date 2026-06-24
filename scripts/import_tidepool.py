#!/usr/bin/env python3
"""Import a Tidepool JSON export into a local SQLite analysis database."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


TYPE_VIEWS = {
    "cbg": """
        CREATE VIEW cbg AS
        SELECT id, time, local_time, device_id, value, units, upload_id
        FROM events
        WHERE type = 'cbg'
        ORDER BY time
    """,
    "smbg": """
        CREATE VIEW smbg AS
        SELECT id, time, local_time, device_id, value, units, upload_id
        FROM events
        WHERE type = 'smbg'
        ORDER BY time
    """,
    "basal": """
        CREATE VIEW basal AS
        SELECT
            id, time, local_time, device_id, delivery_type, rate, duration,
            rate * duration / 60.0 AS delivered_units,
            upload_id
        FROM events
        WHERE type = 'basal'
        ORDER BY time
    """,
    "bolus": """
        CREATE VIEW bolus AS
        SELECT
            id, time, local_time, device_id, subtype, normal, expected_normal,
            COALESCE(normal, expected_normal) AS bolus_units,
            upload_id
        FROM events
        WHERE type = 'bolus'
        ORDER BY time
    """,
    "food": """
        CREATE VIEW food AS
        SELECT
            e.id,
            e.time,
            e.local_time,
            e.device_id,
            e.name,
            CAST(json_extract(d.decoded, '$.carbohydrate.net') AS REAL) AS carbs,
            json_extract(d.decoded, '$.carbohydrate.units') AS carb_units,
            CAST(json_extract(d.decoded, '$.estimatedAbsorptionDuration') AS REAL) AS absorption_seconds,
            e.upload_id
        FROM events e
        LEFT JOIN decoded_json d ON d.event_id = e.id AND d.field = 'nutrition'
        WHERE e.type = 'food'
        ORDER BY e.time
    """,
    "device_events": """
        CREATE VIEW device_events AS
        SELECT id, time, local_time, device_id, subtype, duration, upload_id
        FROM events
        WHERE type = 'deviceEvent'
        ORDER BY time
    """,
    "pump_settings": """
        CREATE VIEW pump_settings AS
        SELECT
            id, type, time, local_time, active_schedule, schedule_name,
            model, serial_number, upload_id
        FROM events
        WHERE type LIKE 'pumpSettings.%'
        ORDER BY time, type
    """,
    "daily_glucose": """
        CREATE VIEW daily_glucose AS
        SELECT
            substr(local_time, 1, 10) AS day,
            type,
            COUNT(*) AS readings,
            ROUND(AVG(value), 1) AS avg_glucose,
            ROUND(MIN(value), 1) AS min_glucose,
            ROUND(MAX(value), 1) AS max_glucose,
            ROUND(100.0 * SUM(CASE WHEN value < 70 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_low,
            ROUND(100.0 * SUM(CASE WHEN value BETWEEN 70 AND 180 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_in_range,
            ROUND(100.0 * SUM(CASE WHEN value > 180 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_high
        FROM events
        WHERE type IN ('cbg', 'smbg') AND value IS NOT NULL
        GROUP BY day, type
        ORDER BY day, type
    """,
    "daily_insulin": """
        CREATE VIEW daily_insulin AS
        SELECT
            day,
            ROUND(SUM(basal_units), 3) AS basal_units,
            ROUND(SUM(bolus_units), 3) AS bolus_units,
            ROUND(SUM(basal_units + bolus_units), 3) AS total_units
        FROM (
            SELECT substr(local_time, 1, 10) AS day, delivered_units AS basal_units, 0.0 AS bolus_units
            FROM basal
            UNION ALL
            SELECT substr(local_time, 1, 10) AS day, 0.0 AS basal_units, bolus_units AS bolus_units
            FROM bolus
        )
        GROUP BY day
        ORDER BY day
    """,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source",
        nargs="?",
        default="TidepoolExport.json",
        type=Path,
        help="Path to Tidepool JSON export",
    )
    parser.add_argument(
        "--db",
        default=Path("analysis/tidepool.db"),
        type=Path,
        help="SQLite database path to create",
    )
    parser.add_argument(
        "--summary",
        default=Path("analysis/tidepool_summary.md"),
        type=Path,
        help="Markdown summary path to write",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append to an existing database, skipping exact duplicate records",
    )
    return parser.parse_args()


def iso_to_local(value: str | None, offset_minutes: int | None) -> str | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    utc_dt = dt.astimezone(timezone.utc)
    if offset_minutes is None:
        return utc_dt.replace(tzinfo=None).isoformat(timespec="seconds")
    return (utc_dt + timedelta(minutes=offset_minutes)).replace(tzinfo=None).isoformat(timespec="seconds")


def coerce_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def text_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def maybe_decode_json(value: Any) -> Any | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def create_schema(conn: sqlite3.Connection, reset: bool) -> None:
    if reset:
        conn.executescript(
            """
            DROP VIEW IF EXISTS cbg;
            DROP VIEW IF EXISTS smbg;
            DROP VIEW IF EXISTS basal;
            DROP VIEW IF EXISTS bolus;
            DROP VIEW IF EXISTS food;
            DROP VIEW IF EXISTS device_events;
            DROP VIEW IF EXISTS pump_settings;
            DROP VIEW IF EXISTS daily_glucose;
            DROP VIEW IF EXISTS daily_insulin;

            DROP TABLE IF EXISTS decoded_json;
            DROP TABLE IF EXISTS event_attributes;
            DROP TABLE IF EXISTS events;
            DROP TABLE IF EXISTS import_metadata;
            """
        )

    conn.executescript(
        """
        PRAGMA foreign_keys = ON;

        DROP VIEW IF EXISTS cbg;
        DROP VIEW IF EXISTS smbg;
        DROP VIEW IF EXISTS basal;
        DROP VIEW IF EXISTS bolus;
        DROP VIEW IF EXISTS food;
        DROP VIEW IF EXISTS device_events;
        DROP VIEW IF EXISTS pump_settings;
        DROP VIEW IF EXISTS daily_glucose;
        DROP VIEW IF EXISTS daily_insulin;

        CREATE TABLE IF NOT EXISTS import_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
            row_num INTEGER PRIMARY KEY,
            record_hash TEXT NOT NULL UNIQUE,
            id TEXT,
            type TEXT NOT NULL,
            subtype TEXT,
            time TEXT,
            local_time TEXT,
            timezone_offset INTEGER,
            device_id TEXT,
            upload_id TEXT,
            value REAL,
            units TEXT,
            rate REAL,
            duration REAL,
            delivery_type TEXT,
            normal REAL,
            expected_normal REAL,
            volume REAL,
            name TEXT,
            schedule_name TEXT,
            active_schedule TEXT,
            model TEXT,
            serial_number TEXT,
            raw_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS event_attributes (
            event_id TEXT,
            row_num INTEGER NOT NULL,
            key TEXT NOT NULL,
            value_text TEXT,
            value_real REAL,
            value_json TEXT,
            PRIMARY KEY (row_num, key),
            FOREIGN KEY (row_num) REFERENCES events(row_num)
        );

        CREATE TABLE IF NOT EXISTS decoded_json (
            event_id TEXT,
            row_num INTEGER NOT NULL,
            field TEXT NOT NULL,
            decoded TEXT NOT NULL,
            PRIMARY KEY (row_num, field),
            FOREIGN KEY (row_num) REFERENCES events(row_num)
        );

        CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, time);
        CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
        CREATE INDEX IF NOT EXISTS idx_events_record_hash ON events(record_hash);
        CREATE INDEX IF NOT EXISTS idx_event_attributes_key ON event_attributes(key);
        CREATE INDEX IF NOT EXISTS idx_decoded_json_field ON decoded_json(field);
        """
    )
    for sql in TYPE_VIEWS.values():
        conn.execute(sql)


def canonical_record(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def insert_events(conn: sqlite3.Connection, records: list[dict[str, Any]]) -> tuple[Counter[str], int]:
    counts: Counter[str] = Counter()
    skipped = 0
    next_row_num = conn.execute("SELECT COALESCE(MAX(row_num), 0) + 1 FROM events").fetchone()[0]
    for record in records:
        event_id = text_value(record.get("id"))
        event_type = text_value(record.get("type")) or "unknown"
        raw_json = canonical_record(record)
        record_hash = hashlib.sha256(raw_json.encode("utf-8")).hexdigest()
        if conn.execute("SELECT 1 FROM events WHERE record_hash = ?", (record_hash,)).fetchone():
            skipped += 1
            continue

        row_num = next_row_num
        next_row_num += 1
        timezone_offset = record.get("timezoneOffset")
        if not isinstance(timezone_offset, int):
            timezone_offset = None

        conn.execute(
            """
            INSERT INTO events (
                row_num, record_hash, id, type, subtype, time, local_time,
                timezone_offset, device_id, upload_id, value, units, rate,
                duration, delivery_type, normal, expected_normal, volume, name,
                schedule_name, active_schedule, model, serial_number, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row_num,
                record_hash,
                event_id,
                event_type,
                text_value(record.get("subType")),
                text_value(record.get("time")),
                iso_to_local(text_value(record.get("time")), timezone_offset),
                timezone_offset,
                text_value(record.get("deviceId")),
                text_value(record.get("uploadId")),
                coerce_number(record.get("value")),
                text_value(record.get("units")),
                coerce_number(record.get("rate")),
                coerce_number(record.get("duration")),
                text_value(record.get("deliveryType")),
                coerce_number(record.get("normal")),
                coerce_number(record.get("expectedNormal")),
                coerce_number(record.get("volume")),
                text_value(record.get("name")),
                text_value(record.get("scheduleName")),
                text_value(record.get("activeSchedule")),
                text_value(record.get("model")),
                text_value(record.get("serialNumber")),
                raw_json,
            ),
        )

        for key, value in record.items():
            conn.execute(
                """
                INSERT INTO event_attributes (
                    event_id, row_num, key, value_text, value_real, value_json
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    row_num,
                    key,
                    text_value(value),
                    coerce_number(value),
                    json.dumps(value, ensure_ascii=False, sort_keys=True)
                    if isinstance(value, (dict, list))
                    else None,
                ),
            )
            decoded = maybe_decode_json(value)
            if decoded is not None:
                conn.execute(
                    """
                    INSERT INTO decoded_json (event_id, row_num, field, decoded)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        event_id,
                        row_num,
                        key,
                        json.dumps(decoded, ensure_ascii=False, sort_keys=True),
                    ),
                )

        counts[event_type] += 1
    return counts, skipped


def scalar(conn: sqlite3.Connection, sql: str) -> Any:
    return conn.execute(sql).fetchone()[0]


def query_rows(conn: sqlite3.Connection, sql: str) -> list[sqlite3.Row]:
    return conn.execute(sql).fetchall()


def markdown_table(headers: list[str], rows: list[sqlite3.Row]) -> str:
    if not rows:
        return "_No rows._\n"
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join("" if row[h] is None else str(row[h]) for h in headers) + " |")
    return "\n".join(lines) + "\n"


def write_summary(conn: sqlite3.Connection, summary_path: Path, source: Path, db_path: Path) -> None:
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    headers_counts = ["type", "records"]
    headers_daily_glucose = [
        "day",
        "type",
        "readings",
        "avg_glucose",
        "min_glucose",
        "max_glucose",
        "pct_low",
        "pct_in_range",
        "pct_high",
    ]
    headers_daily_insulin = ["day", "basal_units", "bolus_units", "total_units"]

    content = [
        "# Tidepool SQLite Import Summary",
        "",
        f"- Source: `{source}`",
        f"- Database: `{db_path}`",
        f"- Records: `{scalar(conn, 'SELECT COUNT(*) FROM events')}`",
        f"- Time range UTC: `{scalar(conn, 'SELECT MIN(time) FROM events')}` to `{scalar(conn, 'SELECT MAX(time) FROM events')}`",
        f"- Time range local: `{scalar(conn, 'SELECT MIN(local_time) FROM events')}` to `{scalar(conn, 'SELECT MAX(local_time) FROM events')}`",
        "",
        "## Record Counts",
        "",
        markdown_table(
            headers_counts,
            query_rows(
                conn,
                """
                SELECT type, COUNT(*) AS records
                FROM events
                GROUP BY type
                ORDER BY records DESC, type
                """,
            ),
        ),
        "## Daily Glucose",
        "",
        markdown_table(
            headers_daily_glucose,
            query_rows(conn, "SELECT * FROM daily_glucose"),
        ),
        "## Daily Insulin",
        "",
        markdown_table(
            headers_daily_insulin,
            query_rows(conn, "SELECT * FROM daily_insulin"),
        ),
        "## Useful Views",
        "",
        "- `cbg`",
        "- `smbg`",
        "- `basal`",
        "- `bolus`",
        "- `food`",
        "- `device_events`",
        "- `pump_settings`",
        "- `daily_glucose`",
        "- `daily_insulin`",
        "",
    ]
    summary_path.write_text("\n".join(content), encoding="utf-8")


def main() -> None:
    args = parse_args()
    records = json.loads(args.source.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
        raise SystemExit("Expected top-level JSON array of objects")

    args.db.parent.mkdir(parents=True, exist_ok=True)
    if args.db.exists() and not args.append:
        args.db.unlink()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        create_schema(conn, reset=not args.append)
        counts, skipped = insert_events(conn, records)
        conn.executemany(
            "INSERT OR REPLACE INTO import_metadata (key, value) VALUES (?, ?)",
            [
                ("source", str(args.source)),
                ("last_source_record_count", str(len(records))),
                ("last_inserted_record_count", str(sum(counts.values()))),
                ("last_skipped_duplicate_count", str(skipped)),
                ("last_inserted_type_counts", json.dumps(counts, sort_keys=True)),
            ],
        )
        conn.commit()
        write_summary(conn, args.summary, args.source, args.db)
    finally:
        conn.close()

    print(f"Inserted {sum(counts.values())} records into {args.db}")
    if skipped:
        print(f"Skipped {skipped} duplicate records")
    print(f"Wrote summary to {args.summary}")


if __name__ == "__main__":
    main()
