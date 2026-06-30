"""Build the dashboard payload directly from the SQLite database.

This module is imported by the FastAPI app. There are no file reads here —
the only source is the Tidepool SQLite database produced by the import
scripts.
"""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any


RANGES = [
    ("very_low", "Very Low", "<54", "value < 54"),
    ("low", "Low", "54-69", "value >= 54 AND value < 70"),
    ("in_range", "In Range", "70-180", "value >= 70 AND value <= 180"),
    ("high", "High", "181-250", "value > 180 AND value <= 250"),
    ("very_high", "Very High", ">250", "value > 250"),
]

MEAL_ORDER = ["breakfast", "lunch", "dinner", "overnight/other"]


def query_all(conn: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(sql).fetchall()]


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)).fetchone()
        is not None
    )


def relation_exists(conn: sqlite3.Connection, relation_name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
            (relation_name,),
        ).fetchone()
        is not None
    )


def macro_calories(row: dict[str, Any]) -> dict[str, Any]:
    carb_calories = (row.get("carbs_g") or 0) * 4.0
    fat_calories = (row.get("fat_g") or 0) * 9.0
    protein_calories = (row.get("protein_g") or 0) * 4.0
    macro_total = carb_calories + fat_calories + protein_calories
    total = row.get("energy_kcal") or macro_total or None
    enriched = dict(row)
    enriched.update(
        {
            "carb_calories": round(carb_calories, 1),
            "fat_calories": round(fat_calories, 1),
            "protein_calories": round(protein_calories, 1),
            "macro_calories": round(macro_total, 1),
            "carb_calorie_pct": round(100.0 * carb_calories / total, 1) if total else None,
            "fat_calorie_pct": round(100.0 * fat_calories / total, 1) if total else None,
            "protein_calorie_pct": round(100.0 * protein_calories / total, 1) if total else None,
        }
    )
    return enriched


def build_cronometer_data(conn: sqlite3.Connection) -> dict[str, Any]:
    if not table_exists(conn, "cronometer_nutrition"):
        return {"daily": [], "groups": [], "totals": {"rows": 0, "days": 0, "latest_day": None}}

    rows = query_all(
        conn,
        """
        WITH ranked AS (
            SELECT
                *,
                ROW_NUMBER() OVER (
                    PARTITION BY date, meal_group
                    ORDER BY imported_at DESC, row_hash DESC
                ) AS row_rank
            FROM cronometer_nutrition
        )
        SELECT
            row_hash,
            source_file,
            imported_at,
            date,
            meal_group AS "group",
            energy_kcal,
            net_carbs_g,
            carbs_g,
            fiber_g,
            sugars_g,
            added_sugars_g,
            fat_g,
            saturated_fat_g,
            protein_g,
            sodium_mg,
            water_g,
            completed
        FROM ranked
        WHERE row_rank = 1
        ORDER BY date, meal_group
        """,
    )
    for row in rows:
        if row.get("completed") is not None:
            row["completed"] = bool(row["completed"])

    daily = [macro_calories(row) for row in rows if row["group"] == "Total"]
    groups = [macro_calories(row) for row in rows if row["group"] != "Total"]
    raw_total = query_all(
        conn,
        """
        SELECT COUNT(*) AS rows, COUNT(DISTINCT date) AS days, MAX(date) AS latest_day
        FROM cronometer_nutrition
        """,
    )[0]
    return {
        "daily": daily,
        "groups": groups,
        "totals": raw_total,
    }


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def start_minutes(value: str) -> int:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.hour * 60 + dt.minute


def build_basal_schedule_snapshots(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = query_all(
        conn,
        """
        SELECT
            e.time,
            e.local_time,
            max(CASE WHEN a.key = 'basalSchedule.start' THEN a.value_text END) AS start,
            max(CASE WHEN a.key = 'basalSchedule.rate' THEN a.value_real END) AS rate
        FROM events e
        JOIN event_attributes a ON a.row_num = e.row_num
        WHERE e.type = 'pumpSettings.basalSchedules'
        GROUP BY e.row_num
        ORDER BY e.local_time, start
        """,
    )
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["local_time"] and row["start"] and row["rate"] is not None:
            grouped[row["local_time"]].append(
                {"start_minute": start_minutes(row["start"]), "rate": float(row["rate"])}
            )

    snapshots = []
    for local_time, entries in grouped.items():
        snapshots.append(
            {
                "local_time": parse_dt(local_time),
                "entries": sorted(entries, key=lambda item: item["start_minute"]),
            }
        )
    return sorted(snapshots, key=lambda item: item["local_time"])


def schedule_for_time(snapshots: list[dict[str, Any]], when: datetime) -> list[dict[str, Any]]:
    selected = snapshots[0]["entries"] if snapshots else []
    for snapshot in snapshots:
        if snapshot["local_time"] <= when:
            selected = snapshot["entries"]
        else:
            break
    return selected


def scheduled_rate(entries: list[dict[str, Any]], when: datetime) -> float:
    if not entries:
        return 0.0
    minute = when.hour * 60 + when.minute
    active = entries[-1]["rate"]
    for entry in entries:
        if minute >= entry["start_minute"]:
            active = entry["rate"]
        else:
            break
    return active


def next_schedule_boundary(entries: list[dict[str, Any]], when: datetime) -> datetime:
    minute = when.hour * 60 + when.minute
    for entry in entries:
        if entry["start_minute"] > minute:
            return when.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
                minutes=entry["start_minute"]
            )
    return when.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)


def add_rollup(target: dict[str, dict[str, float]], key: str, actual: float, expected: float, minutes: float) -> None:
    row = target.setdefault(
        key,
        {
            "delivered_units": 0.0,
            "scheduled_units": 0.0,
            "net_deviation_units": 0.0,
            "extra_basal_units": 0.0,
            "reduced_basal_units": 0.0,
            "minutes": 0.0,
        },
    )
    deviation = actual - expected
    row["delivered_units"] += actual
    row["scheduled_units"] += expected
    row["net_deviation_units"] += deviation
    row["extra_basal_units"] += max(0.0, deviation)
    row["reduced_basal_units"] += max(0.0, -deviation)
    row["minutes"] += minutes


def build_basal_deviation(conn: sqlite3.Connection) -> dict[str, Any]:
    snapshots = build_basal_schedule_snapshots(conn)
    rows = query_all(
        conn,
        """
        SELECT local_time, rate, duration, delivery_type
        FROM events
        WHERE type = 'basal'
          AND delivery_type IN ('automated', 'scheduled')
          AND rate IS NOT NULL
          AND duration IS NOT NULL
        ORDER BY local_time
        """,
    )

    daily: dict[str, dict[str, float]] = {}
    hourly: dict[str, dict[str, float]] = {}

    for row in rows:
        duration = float(row["duration"])
        rate = float(row["rate"])
        if duration <= 0:
            continue
        start = parse_dt(row["local_time"])
        end = start + timedelta(minutes=duration)
        cursor = start

        while cursor < end:
            entries = schedule_for_time(snapshots, cursor)
            hour_boundary = cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            boundary = min(end, hour_boundary, next_schedule_boundary(entries, cursor))
            minutes = (boundary - cursor).total_seconds() / 60.0
            if minutes <= 0:
                cursor = end
                continue

            expected_rate = scheduled_rate(entries, cursor)
            actual_units = rate * minutes / 60.0
            expected_units = expected_rate * minutes / 60.0
            day_key = cursor.date().isoformat()
            hour_key = f"{day_key}T{cursor.hour:02d}:00"
            add_rollup(daily, day_key, actual_units, expected_units, minutes)
            add_rollup(hourly, hour_key, actual_units, expected_units, minutes)
            cursor = boundary

    daily_rows = []
    for day, row in sorted(daily.items()):
        delivered = row["delivered_units"]
        scheduled = row["scheduled_units"]
        daily_rows.append(
            {
                "day": day,
                "delivered_units": round(delivered, 3),
                "scheduled_units": round(scheduled, 3),
                "net_deviation_units": round(row["net_deviation_units"], 3),
                "extra_basal_units": round(row["extra_basal_units"], 3),
                "reduced_basal_units": round(row["reduced_basal_units"], 3),
                "extra_pct_of_delivered": round(100.0 * row["extra_basal_units"] / delivered, 1)
                if delivered
                else None,
                "observed_hours": round(row["minutes"] / 60.0, 2),
            }
        )

    hourly_rows = []
    for hour, row in sorted(hourly.items()):
        delivered = row["delivered_units"]
        hourly_rows.append(
            {
                "hour": hour,
                "day": hour[:10],
                "hour_of_day": int(hour[11:13]),
                "delivered_units": round(delivered, 3),
                "scheduled_units": round(row["scheduled_units"], 3),
                "net_deviation_units": round(row["net_deviation_units"], 3),
                "extra_basal_units": round(row["extra_basal_units"], 3),
                "reduced_basal_units": round(row["reduced_basal_units"], 3),
                "extra_pct_of_delivered": round(100.0 * row["extra_basal_units"] / delivered, 1)
                if delivered
                else None,
                "observed_minutes": round(row["minutes"], 1),
            }
        )

    return {
        "schedule": snapshots[-1]["entries"] if snapshots else [],
        "daily": daily_rows,
        "hourly": hourly_rows,
    }


def build_journal_daily(tidepool: dict[str, Any]) -> list[dict[str, Any]]:
    """Compute Journal daily rows from Tidepool-derived aggregates."""
    insulin = {row["day"]: row for row in tidepool["daily_insulin"]}
    food = {row["day"]: row for row in tidepool["daily_food"]}
    glucose = {row["day"]: row for row in tidepool["daily_ranges"]}
    days = sorted(set(insulin) | set(food) | set(glucose))

    rows: list[dict[str, Any]] = []
    for day in days:
        insulin_row = insulin.get(day)
        basal = insulin_row["basal_units"] if insulin_row else None
        bolus = insulin_row["bolus_units"] if insulin_row else None
        total = insulin_row["total_units"] if insulin_row else None
        carbs = (food.get(day) or {}).get("carbs")
        avg_bg = (glucose.get(day) or {}).get("avg_glucose")

        basal_pct = round(100.0 * basal / total, 1) if basal is not None and total else None
        bolus_pct = round(100.0 * bolus / total, 1) if bolus is not None and total else None
        bolus_per_carb = round(bolus / carbs, 3) if bolus is not None and carbs else None
        carbs_per_bolus = round(carbs / bolus, 1) if carbs is not None and bolus else None

        rows.append(
            {
                "date": day,
                "carbs": round(carbs, 1) if isinstance(carbs, (int, float)) else None,
                "total": round(total, 1) if isinstance(total, (int, float)) else None,
                "basal": round(basal, 1) if isinstance(basal, (int, float)) else None,
                "bolus": round(bolus, 1) if isinstance(bolus, (int, float)) else None,
                "avg_bg": avg_bg,
                "basal_pct": basal_pct,
                "bolus_pct": bolus_pct,
                "bolus_per_carb": bolus_per_carb,
                "carbs_per_bolus": carbs_per_bolus,
            }
        )
    return rows


def build_period_summaries(tidepool: dict[str, Any], log_data: dict[str, Any]) -> list[dict[str, Any]]:
    daily_ranges = {row["day"]: row for row in tidepool["daily_ranges"]}
    basal = {row["day"]: row for row in tidepool["basal_deviation"]["daily"]}
    log = {row["date"]: row for row in log_data["daily"]}
    days = sorted(set(daily_ranges) | set(basal) | set(log))
    if not days:
        return []

    latest = datetime.fromisoformat(days[-1])
    periods = [
        ("1 week", 7),
        ("2 weeks", 14),
        ("1 month", 30),
        ("3 months", 90),
        ("6 months", 180),
    ]
    summaries = []
    for label, days_back in periods:
        start = (latest - timedelta(days=days_back - 1)).date().isoformat()
        period_days = [day for day in days if start <= day <= days[-1]]
        reading_count = sum((daily_ranges.get(day) or {}).get("readings", 0) for day in period_days)
        glucose_sum = sum(
            ((daily_ranges.get(day) or {}).get("avg_glucose") or 0) * (daily_ranges.get(day) or {}).get("readings", 0)
            for day in period_days
        )
        in_range_count = sum((daily_ranges.get(day) or {}).get("in_range_count", 0) for day in period_days)
        delivered = sum((basal.get(day) or {}).get("delivered_units", 0) for day in period_days)
        scheduled = sum((basal.get(day) or {}).get("scheduled_units", 0) for day in period_days)
        extra = sum((basal.get(day) or {}).get("extra_basal_units", 0) for day in period_days)
        carbs = sum((log.get(day) or {}).get("carbs", 0) or 0 for day in period_days)
        bolus = sum((log.get(day) or {}).get("bolus", 0) or 0 for day in period_days)
        total_insulin = delivered + bolus
        summaries.append(
            {
                "label": label,
                "days_requested": days_back,
                "days_available": len(period_days),
                "start": period_days[0] if period_days else None,
                "end": period_days[-1] if period_days else None,
                "avg_glucose": round(glucose_sum / reading_count, 1) if reading_count else None,
                "time_in_range_pct": round(100.0 * in_range_count / reading_count, 1) if reading_count else None,
                "delivered_basal_units": round(delivered, 2),
                "scheduled_basal_units": round(scheduled, 2),
                "extra_basal_units": round(extra, 2),
                "extra_basal_per_day": round(extra / len(period_days), 2) if period_days else None,
                "extra_pct_of_delivered": round(100.0 * extra / delivered, 1) if delivered else None,
                "correction_load_pct_tdi": round(100.0 * extra / total_insulin, 1) if total_insulin else None,
                "carbs": round(carbs, 1),
                "bolus_units": round(bolus, 2),
                "bolus_per_carb": round(bolus / carbs, 3) if carbs else None,
            }
        )
    return summaries


def meal_name(value: datetime) -> str:
    hour = value.hour + value.minute / 60.0
    if 6.5 <= hour < 10.5:
        return "breakfast"
    if 10.5 <= hour < 15.5:
        return "lunch"
    if 15.5 <= hour < 20:
        return "dinner"
    return "overnight/other"


def rows_between(rows: list[dict[str, Any]], start: datetime, end: datetime, key: str = "local_time") -> list[dict[str, Any]]:
    return [row for row in rows if start <= parse_dt(row[key]) < end]


def overlap_units(hourly: list[dict[str, Any]], start: datetime, end: datetime, key: str) -> float:
    total = 0.0
    for row in hourly:
        hour_start = parse_dt(row["hour"])
        hour_end = hour_start + timedelta(hours=1)
        overlap = max(0.0, (min(end, hour_end) - max(start, hour_start)).total_seconds() / 3600.0)
        if overlap:
            total += (row.get(key) or 0.0) * overlap
    return total


def average(values: list[float | None]) -> float | None:
    filtered = [value for value in values if value is not None]
    return sum(filtered) / len(filtered) if filtered else None


def stddev(values: list[float | None]) -> float | None:
    filtered = [value for value in values if value is not None]
    if not filtered:
        return None
    avg = sum(filtered) / len(filtered)
    return (sum((value - avg) ** 2 for value in filtered) / len(filtered)) ** 0.5


def glucose_summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "avg_glucose": None,
            "min_glucose": None,
            "max_glucose": None,
            "stddev_glucose": None,
            "cv_pct": None,
        }
    avg_value = sum(values) / len(values)
    sd_value = stddev(values) or 0.0
    return {
        "avg_glucose": round(avg_value, 1),
        "min_glucose": round(min(values), 1),
        "max_glucose": round(max(values), 1),
        "stddev_glucose": round(sd_value, 1),
        "cv_pct": round(100.0 * sd_value / avg_value, 1) if avg_value else None,
    }


def range_counts(values: list[float]) -> dict[str, Any]:
    counts = {
        "very_low_count": sum(1 for value in values if value < 54),
        "low_count": sum(1 for value in values if 54 <= value < 70),
        "in_range_count": sum(1 for value in values if 70 <= value <= 180),
        "high_count": sum(1 for value in values if 180 < value <= 250),
        "very_high_count": sum(1 for value in values if value > 250),
    }
    total = len(values)
    pcts = {
        key.replace("_count", "_pct"): round(100.0 * count / total, 1) if total else None
        for key, count in counts.items()
    }
    return {**counts, **pcts}


def build_glucose_ranges(glucose_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_day: dict[str, dict[str, list[float]]] = defaultdict(lambda: {"cbg": [], "smbg": []})
    for row in glucose_rows:
        value = row.get("value")
        row_type = row.get("type")
        if row_type not in ("cbg", "smbg") or value is None:
            continue
        by_day[row["day"]][row_type].append(float(value))

    daily_ranges: list[dict[str, Any]] = []
    all_cbg: list[float] = []
    all_smbg = 0
    for day, grouped in sorted(by_day.items()):
        cbg_values = grouped["cbg"]
        smbg_values = grouped["smbg"]
        all_cbg.extend(cbg_values)
        all_smbg += len(smbg_values)
        daily_ranges.append(
            {
                "day": day,
                "readings": len(cbg_values),
                "cgm_readings": len(cbg_values),
                "smbg_readings": len(smbg_values),
                **glucose_summary(cbg_values),
                **range_counts(cbg_values),
            }
        )

    totals = {
        "readings": len(all_cbg),
        "cgm_readings": len(all_cbg),
        "smbg_readings": all_smbg,
        **glucose_summary(all_cbg),
    }
    return daily_ranges, totals


def round_or_none(value: float | None, digits: int = 1) -> float | None:
    return round(value, digits) if value is not None else None


def pct_true(values: list[bool | None]) -> float | None:
    filtered = [value for value in values if value is not None]
    if not filtered:
        return None
    return 100.0 * sum(1 for value in filtered if value) / len(filtered)


def summarize_meals(meals: list[dict[str, Any]], start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
    filtered = [
        meal
        for meal in meals
        if (start is None or meal["date"] >= start) and (end is None or meal["date"] <= end)
    ]
    by_meal: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for meal in filtered:
        by_meal[meal["meal"]].append(meal)

    summaries = []
    for name in MEAL_ORDER:
        rows = by_meal.get(name, [])
        if not rows:
            continue
        carbs = sum(row["carbs"] for row in rows)
        bolus = sum(row["bolus"] for row in rows)
        summaries.append(
            {
                "meal": name,
                "meals": len(rows),
                "carbs_per_bolus": round_or_none(carbs / bolus, 1) if bolus else None,
                "pre_bg": round_or_none(average([row["pre_bg"] for row in rows]), 1),
                "peak_4h": round_or_none(average([row["peak_4h"] for row in rows]), 1),
                "pct_high_4h": round_or_none(average([row["pct_high_4h"] for row in rows]), 1),
                "recovery_minutes_4h": round_or_none(average([row["recovery_minutes_4h"] for row in rows]), 0),
                "area_over_180_4h": round_or_none(average([row["area_over_180_4h"] for row in rows]), 1),
                "extra_basal_4h": round_or_none(average([row["extra_basal_4h"] for row in rows]), 2),
                "net_basal_4h": round_or_none(average([row["net_basal_4h"] for row in rows]), 2),
                "correction_efficiency": round_or_none(average([row["correction_efficiency"] for row in rows]), 2),
                "observed_sensitivity": round_or_none(average([row["observed_sensitivity"] for row in rows]), 1),
                "low_after_correction_pct": round_or_none(pct_true([row["low_after_correction"] for row in rows]), 0),
                "burden_score": round_or_none(average([row["burden_score"] for row in rows]), 1),
                "burden_variability": round_or_none(stddev([row["burden_score"] for row in rows]), 1),
            }
        )
    return summaries


def recovery_minutes(glucose_rows: list[dict[str, Any]], start: datetime) -> float | None:
    went_high = False
    for row in glucose_rows:
        value = row["value"]
        if value > 180:
            went_high = True
            continue
        if went_high and 70 <= value <= 180:
            return (parse_dt(row["local_time"]) - start).total_seconds() / 60.0
    return None


def area_over_threshold(glucose_rows: list[dict[str, Any]], threshold: float = 180.0) -> float | None:
    if len(glucose_rows) < 2:
        return None
    total = 0.0
    previous = glucose_rows[0]
    for row in glucose_rows[1:]:
        previous_time = parse_dt(previous["local_time"])
        current_time = parse_dt(row["local_time"])
        hours = (current_time - previous_time).total_seconds() / 3600.0
        if hours > 0:
            previous_excess = max(0.0, previous["value"] - threshold)
            current_excess = max(0.0, row["value"] - threshold)
            total += ((previous_excess + current_excess) / 2.0) * hours
        previous = row
    return total


def crossed_high(glucose_rows: list[dict[str, Any]]) -> bool:
    return any(row["value"] > 180 for row in glucose_rows)


def longest_minutes_over_threshold(glucose_rows: list[dict[str, Any]], threshold: float, max_gap_minutes: float = 15.0) -> float:
    longest = 0.0
    run_start: datetime | None = None
    previous_time: datetime | None = None
    for row in glucose_rows:
        current_time = parse_dt(row["local_time"])
        if row["value"] > threshold:
            if run_start is None or previous_time is None or (current_time - previous_time).total_seconds() / 60.0 > max_gap_minutes:
                run_start = current_time
            if run_start is not None:
                longest = max(longest, (current_time - run_start).total_seconds() / 60.0)
            previous_time = current_time
            continue
        run_start = None
        previous_time = None
    return longest


def low_after_high(glucose_rows: list[dict[str, Any]]) -> bool | None:
    if not glucose_rows:
        return None
    saw_high = False
    for row in glucose_rows:
        if row["value"] > 180:
            saw_high = True
        if saw_high and row["value"] < 70:
            return True
    return False if saw_high else None


def correction_efficiency(extra_basal: float, area_over_180: float | None) -> float | None:
    if area_over_180 is None or area_over_180 < 1:
        return None
    return 100.0 * extra_basal / area_over_180


def meal_burden_score(area_over_180: float | None, recovery: float | None, extra_basal: float) -> float | None:
    if area_over_180 is None:
        return None
    recovery_component = recovery or 0.0
    return area_over_180 + (recovery_component / 10.0) + (extra_basal * 20.0)


def observed_sensitivity(glucose_rows: list[dict[str, Any]], extra_basal: float) -> float | None:
    if extra_basal <= 0 or not glucose_rows:
        return None
    peak_row = max(glucose_rows, key=lambda row: row["value"])
    if peak_row["value"] <= 180:
        return None
    after_peak = [row for row in glucose_rows if parse_dt(row["local_time"]) >= parse_dt(peak_row["local_time"])]
    if not after_peak:
        return None
    end_value = after_peak[-1]["value"]
    drop = peak_row["value"] - end_value
    return drop / extra_basal if drop > 0 else None


def build_meal_analysis(conn: sqlite3.Connection, tidepool: dict[str, Any], periods: list[dict[str, Any]]) -> dict[str, Any]:
    if not all(relation_exists(conn, name) for name in ("food", "events")):
        return {"all": [], "periods": {period["label"]: [] for period in periods}, "events": []}

    foods = query_all(
        conn,
        """
        SELECT f.local_time, f.carbs, e.name
        FROM food f
        JOIN events e ON e.id = f.id
        WHERE e.timezone_offset IS NOT NULL
        ORDER BY f.local_time
        """,
    )
    boluses = query_all(
        conn,
        """
        SELECT local_time, normal AS bolus_units
        FROM events
        WHERE type = 'bolus' AND timezone_offset IS NOT NULL
        ORDER BY local_time
        """,
    )
    glucose = query_all(
        conn,
        """
        SELECT local_time, value
        FROM events
        WHERE type = 'cbg' AND value IS NOT NULL
        ORDER BY local_time
        """,
    )
    hourly = tidepool["basal_deviation"]["hourly"]

    clusters: list[dict[str, Any]] = []
    for food in foods:
        food_time = parse_dt(food["local_time"])
        carbs = float(food["carbs"] or 0.0)
        if (
            clusters
            and (food_time - parse_dt(clusters[-1]["last"])).total_seconds() / 60.0 <= 75
            and meal_name(food_time) == clusters[-1]["meal"]
        ):
            clusters[-1]["carbs"] += carbs
            clusters[-1]["last"] = food["local_time"]
        else:
            clusters.append(
                {
                    "start": food["local_time"],
                    "last": food["local_time"],
                    "meal": meal_name(food_time),
                    "carbs": carbs,
                }
            )

    used_bolus: set[int] = set()
    meals = []
    for cluster in clusters:
        start = parse_dt(cluster["start"])
        last = parse_dt(cluster["last"])
        end = last + timedelta(hours=4)
        bolus_rows = []
        for index, bolus in enumerate(boluses):
            bolus_time = parse_dt(bolus["local_time"])
            if index not in used_bolus and start - timedelta(minutes=30) <= bolus_time <= last + timedelta(minutes=60):
                bolus_rows.append((index, bolus))
        for index, _bolus in bolus_rows:
            used_bolus.add(index)

        glucose_rows = rows_between(glucose, start, end)
        low_window_rows = rows_between(glucose, start, last + timedelta(hours=6))
        pre_rows = rows_between(glucose, start - timedelta(minutes=20), start + timedelta(minutes=10))
        extra_basal_4h = overlap_units(hourly, start, end, "extra_basal_units")
        net_basal_4h = overlap_units(hourly, start, end, "net_deviation_units")
        area_4h = area_over_threshold(glucose_rows)
        recovery_4h = recovery_minutes(glucose_rows, start)
        bolus_units = sum(row["bolus_units"] or 0.0 for _index, row in bolus_rows)
        announced_ratio = cluster["carbs"] / bolus_units if bolus_units > 0 else None
        minutes_over_250 = longest_minutes_over_threshold(glucose_rows, 250.0)
        sustained_over_250 = minutes_over_250 >= 120.0
        cleanup_units = extra_basal_4h if sustained_over_250 and extra_basal_4h > 0 else 0.0
        review_ratio = cluster["carbs"] / (bolus_units + cleanup_units) if sustained_over_250 and bolus_units + cleanup_units > 0 else None
        carb_gap = cleanup_units * announced_ratio if sustained_over_250 and announced_ratio is not None else None
        meals.append(
            {
                "date": start.date().isoformat(),
                "start": cluster["start"],
                "meal": cluster["meal"],
                "carbs": cluster["carbs"],
                "bolus": bolus_units,
                "pre_bg": average([row["value"] for row in pre_rows]),
                "peak_4h": max((row["value"] for row in glucose_rows), default=None),
                "pct_high_4h": 100.0 * sum(1 for row in glucose_rows if row["value"] > 180) / len(glucose_rows)
                if glucose_rows
                else None,
                "minutes_over_250_4h": minutes_over_250,
                "sustained_over_250_2h": sustained_over_250,
                "review_carbs_per_unit": review_ratio,
                "estimated_missing_carbs": carb_gap,
                "recovery_minutes_4h": recovery_4h,
                "area_over_180_4h": area_4h,
                "crossed_high_4h": crossed_high(glucose_rows),
                "low_after_correction": low_after_high(low_window_rows),
                "extra_basal_4h": extra_basal_4h,
                "net_basal_4h": net_basal_4h,
                "correction_efficiency": correction_efficiency(extra_basal_4h, area_4h),
                "observed_sensitivity": observed_sensitivity(glucose_rows, extra_basal_4h),
                "burden_score": meal_burden_score(area_4h, recovery_4h, extra_basal_4h),
            }
        )

    return {
        "all": summarize_meals(meals),
        "periods": {
            period["label"]: summarize_meals(meals, period["start"], period["end"])
            for period in periods
        },
        "events": meals,
    }


def event_text(raw: dict[str, Any]) -> str | None:
    for key in ("note", "notes", "message", "text", "description", "name"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def build_daily_events(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = query_all(
        conn,
        """
        SELECT id, type, subtype, local_time, duration, name, raw_json
        FROM events
        WHERE local_time IS NOT NULL
          AND (
            type = 'deviceEvent'
            OR lower(type) LIKE '%note%'
            OR lower(COALESCE(subtype, '')) LIKE '%note%'
            OR lower(COALESCE(name, '')) LIKE '%note%'
          )
        ORDER BY local_time
        """,
    )
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        raw = json.loads(row.get("raw_json") or "{}")
        kind: str | None = None
        label: str | None = None
        detail: str | None = None
        duration = row.get("duration")

        if row.get("type") == "deviceEvent" and row.get("subtype") == "pumpSettingsOverride":
            high_target = raw.get("bgTarget.high")
            low_target = raw.get("bgTarget.low")
            if isinstance(high_target, (int, float)) and isinstance(low_target, (int, float)) and high_target >= 9:
                kind = "exercise"
                label = "Exercise"
                detail = f"Pump override · {int(round(duration))}m" if isinstance(duration, (int, float)) else "Pump override"
        elif (
            "note" in str(row.get("type", "")).lower()
            or "note" in str(row.get("subtype", "")).lower()
            or "note" in str(row.get("name", "")).lower()
        ):
            text = event_text(raw) or row.get("name")
            if text:
                kind = "note"
                label = "Note"
                detail = text

        if not kind or not label:
            continue
        event_id = row.get("id") or f"{row['local_time']}-{kind}"
        if event_id in seen:
            continue
        seen.add(event_id)
        events.append(
            {
                "id": event_id,
                "day": row["local_time"][:10],
                "local_time": row["local_time"],
                "kind": kind,
                "label": label,
                "detail": detail,
                "duration_minutes": round(duration, 1) if isinstance(duration, (int, float)) else None,
            }
        )
    return events


def build_tidepool_data(conn: sqlite3.Connection) -> dict[str, Any]:
    glucose_rows = query_all(
        conn,
        """
        SELECT
            substr(local_time, 1, 10) AS day,
            type,
            value
        FROM events
        WHERE type IN ('cbg', 'smbg') AND value IS NOT NULL
          AND local_time IS NOT NULL
        ORDER BY local_time
        """,
    )
    daily_ranges, totals = build_glucose_ranges(glucose_rows)

    daily_insulin = query_all(conn, "SELECT * FROM daily_insulin") if relation_exists(conn, "daily_insulin") else []
    food = (
        query_all(
            conn,
            """
            SELECT
                substr(local_time, 1, 10) AS day,
                COUNT(*) AS meals,
                ROUND(SUM(carbs), 1) AS carbs
            FROM food
            GROUP BY day
            ORDER BY day
            """,
        )
        if relation_exists(conn, "food")
        else []
    )
    glucose_points = query_all(
        conn,
        """
        SELECT
            substr(local_time, 1, 10) AS day,
            local_time,
            ROUND(value, 1) AS value
        FROM events
        WHERE type = 'cbg' AND value IS NOT NULL
        ORDER BY local_time
        """,
    )
    smbg_points = query_all(
        conn,
        """
        SELECT
            substr(local_time, 1, 10) AS day,
            local_time,
            ROUND(value, 1) AS value
        FROM events
        WHERE type = 'smbg' AND value IS NOT NULL
        ORDER BY local_time
        """,
    )
    basal_deviation = build_basal_deviation(conn)
    return {
        "ranges": [
            {"key": key, "label": label, "bounds": bounds}
            for key, label, bounds, _condition in RANGES
        ],
        "daily_ranges": daily_ranges,
        "daily_insulin": daily_insulin,
        "daily_food": food,
        "glucose_points": glucose_points,
        "smbg_points": smbg_points,
        "daily_events": build_daily_events(conn),
        "basal_deviation": basal_deviation,
        "totals": totals,
    }


def empty_tidepool_data() -> dict[str, Any]:
    return {
        "ranges": [
            {"key": key, "label": label, "bounds": bounds}
            for key, label, bounds, _condition in RANGES
        ],
        "daily_ranges": [],
        "daily_insulin": [],
        "daily_food": [],
        "glucose_points": [],
        "smbg_points": [],
        "daily_events": [],
        "basal_deviation": {"schedule": [], "daily": [], "hourly": []},
        "totals": {
            "readings": 0,
            "cgm_readings": 0,
            "smbg_readings": 0,
            "avg_glucose": None,
            "min_glucose": None,
            "max_glucose": None,
            "stddev_glucose": None,
            "cv_pct": None,
        },
    }


def build_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    """Compute the full dashboard payload from the SQLite database.

    Returns a well-formed empty payload when the database has no tables yet,
    so the dashboard can render an empty state instead of erroring out.
    """
    cronometer_data = build_cronometer_data(conn)
    if table_exists(conn, "events"):
        tidepool_data = build_tidepool_data(conn)
        log_data = {"daily": build_journal_daily(tidepool_data)}
        period_summaries = build_period_summaries(tidepool_data, log_data)
        meal_analysis = build_meal_analysis(conn, tidepool_data, period_summaries)
    else:
        tidepool_data = empty_tidepool_data()
        log_data = {"daily": []}
        period_summaries = []
        meal_analysis = {"all": [], "periods": {}, "events": []}

    return {
        "generated_from": {"db": "sqlite"},
        "tidepool": tidepool_data,
        "log": log_data,
        "cronometer": cronometer_data,
        "period_summaries": period_summaries,
        "meal_analysis": meal_analysis,
    }
