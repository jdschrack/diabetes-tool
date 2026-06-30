import json
import sqlite3

from scripts.import_tidepool import create_schema
from server.dashboard import build_payload


def insert_event(conn: sqlite3.Connection, row_num: int, event_type: str, local_time: str, **values):
    conn.execute(
        """
        INSERT INTO events (
            row_num, record_hash, id, type, time, local_time, timezone_offset,
            value, units, raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row_num,
            f"hash-{row_num}",
            values.get("id", f"event-{row_num}"),
            event_type,
            values.get("time", local_time.replace("+00:00", "Z")),
            local_time,
            values.get("timezone_offset", -240),
            values.get("value"),
            values.get("units", "mg/dL"),
            json.dumps(values.get("raw", {})),
        ),
    )


def make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    create_schema(conn, reset=False)
    return conn


def test_clinical_glucose_metrics_use_cgm_only():
    conn = make_conn()
    insert_event(conn, 1, "cbg", "2026-06-25T08:00:00", value=100)
    insert_event(conn, 2, "cbg", "2026-06-25T08:05:00", value=200)
    insert_event(conn, 3, "smbg", "2026-06-25T08:10:00", value=50)
    conn.commit()

    payload = build_payload(conn)
    day = payload["tidepool"]["daily_ranges"][0]
    totals = payload["tidepool"]["totals"]

    assert day["readings"] == 2
    assert day["cgm_readings"] == 2
    assert day["smbg_readings"] == 1
    assert day["avg_glucose"] == 150.0
    assert day["min_glucose"] == 100.0
    assert day["max_glucose"] == 200.0
    assert day["stddev_glucose"] == 50.0
    assert day["cv_pct"] == 33.3
    assert day["in_range_count"] == 1
    assert day["high_count"] == 1
    assert day["in_range_pct"] == 50.0
    assert day["high_pct"] == 50.0

    assert totals["readings"] == 2
    assert totals["cgm_readings"] == 2
    assert totals["smbg_readings"] == 1
    assert totals["avg_glucose"] == 150.0


def test_smbg_only_day_is_present_without_cgm_metrics():
    conn = make_conn()
    insert_event(conn, 1, "smbg", "2026-06-25T08:10:00", value=123)
    conn.commit()

    payload = build_payload(conn)
    day = payload["tidepool"]["daily_ranges"][0]

    assert day["day"] == "2026-06-25"
    assert day["readings"] == 0
    assert day["cgm_readings"] == 0
    assert day["smbg_readings"] == 1
    assert day["avg_glucose"] is None
    assert day["in_range_pct"] is None


def test_null_food_carbs_do_not_crash_meal_analysis():
    conn = make_conn()
    insert_event(conn, 1, "food", "2026-06-25T12:00:00", units=None, raw={"name": "No carb detail"})
    insert_event(conn, 2, "cbg", "2026-06-25T12:05:00", value=140)
    conn.commit()

    payload = build_payload(conn)

    assert payload["meal_analysis"]["events"][0]["carbs"] == 0.0
