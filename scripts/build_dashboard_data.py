#!/usr/bin/env python3
"""Build browser-ready dashboard data from Tidepool SQLite and log.csv."""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


RANGES = [
    ("very_low", "Very Low", "<54", "value < 54"),
    ("low", "Low", "54-69", "value >= 54 AND value < 70"),
    ("in_range", "In Range", "70-180", "value >= 70 AND value <= 180"),
    ("high", "High", "181-250", "value > 180 AND value <= 250"),
    ("very_high", "Very High", ">250", "value > 250"),
]

MEAL_ORDER = ["breakfast", "lunch", "dinner", "overnight/other"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=Path("analysis/tidepool.db"), type=Path)
    parser.add_argument("--log", default=Path("log.csv"), type=Path)
    parser.add_argument("--out", default=Path("dashboard/dashboard-data.js"), type=Path)
    return parser.parse_args()


def parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.strip().replace(",", "")
    if not cleaned:
        return None
    if cleaned.endswith("%"):
        cleaned = cleaned[:-1]
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_log(path: Path) -> dict[str, Any]:
    rows = list(csv.reader(path.open(newline="", encoding="utf-8-sig")))
    daily: list[dict[str, Any]] = []
    baseline: list[dict[str, Any]] = []

    for idx, row in enumerate(rows):
        if row and row[0] == "Date":
            headers = row
            for data_row in rows[idx + 1 :]:
                if not data_row or not data_row[0] or data_row[0].startswith("Average"):
                    break
                item = dict(zip(headers, data_row))
                daily.append(
                    {
                        "date": item.get("Date"),
                        "carbs": parse_float(item.get("Carbs (g)")),
                        "total": parse_float(item.get("Total (u)")),
                        "basal": parse_float(item.get("Basal (u)")),
                        "bolus": parse_float(item.get("Bolus (u)")),
                        "avg_bg": parse_float(item.get("Avg BG (mg/dL)")),
                        "basal_pct": parse_float(item.get("Basal %")),
                        "bolus_pct": parse_float(item.get("Bolus %")),
                        "bolus_per_carb": parse_float(item.get("Bolus/g carb")),
                        "carbs_per_bolus": parse_float(item.get("Carbs/bolus u")),
                    }
                )
        if row and row[0] == "Metric":
            headers = row
            for data_row in rows[idx + 1 :]:
                if not data_row or not data_row[0]:
                    break
                item = dict(zip(headers, data_row))
                baseline.append(
                    {
                        "metric": item.get("Metric"),
                        "ilet_30_day": item.get("iLet 30-day"),
                        "twiist_avg": item.get("Twiist avg"),
                        "change": item.get("Change"),
                    }
                )

    return {"daily": daily, "baseline": baseline}


def query_all(conn: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(sql).fetchall()]


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)).fetchone()
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
            (daily_ranges.get(day) or {}).get("avg_glucose", 0) * (daily_ranges.get(day) or {}).get("readings", 0)
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
        if (
            clusters
            and (food_time - parse_dt(clusters[-1]["last"])).total_seconds() / 60.0 <= 75
            and meal_name(food_time) == clusters[-1]["meal"]
        ):
            clusters[-1]["carbs"] += food["carbs"]
            clusters[-1]["last"] = food["local_time"]
        else:
            clusters.append(
                {
                    "start": food["local_time"],
                    "last": food["local_time"],
                    "meal": meal_name(food_time),
                    "carbs": food["carbs"],
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
            # Twiist exports elevated exercise targets as mmol/L values even when event units say mg/dL.
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
    range_selects = ",\n".join(
        f"SUM(CASE WHEN {condition} THEN 1 ELSE 0 END) AS {key}_count"
        for key, _label, _bounds, condition in RANGES
    )
    range_pct_selects = ",\n".join(
        f"ROUND(100.0 * SUM(CASE WHEN {condition} THEN 1 ELSE 0 END) / COUNT(*), 1) AS {key}_pct"
        for key, _label, _bounds, condition in RANGES
    )
    daily_ranges = query_all(
        conn,
        f"""
        SELECT
            substr(local_time, 1, 10) AS day,
            COUNT(*) AS readings,
            ROUND(AVG(value), 1) AS avg_glucose,
            ROUND(MIN(value), 1) AS min_glucose,
            ROUND(MAX(value), 1) AS max_glucose,
            ROUND(
                SQRT(AVG(value * value) - AVG(value) * AVG(value)),
                1
            ) AS stddev_glucose,
            ROUND(
                100.0 * SQRT(AVG(value * value) - AVG(value) * AVG(value)) / AVG(value),
                1
            ) AS cv_pct,
            {range_selects},
            {range_pct_selects}
        FROM events
        WHERE type = 'cbg' AND value IS NOT NULL
        GROUP BY day
        ORDER BY day
        """,
    )

    daily_insulin = query_all(conn, "SELECT * FROM daily_insulin")
    food = query_all(
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
    totals = query_all(
        conn,
        """
        SELECT
            COUNT(*) AS readings,
            ROUND(AVG(value), 1) AS avg_glucose,
            ROUND(MIN(value), 1) AS min_glucose,
            ROUND(MAX(value), 1) AS max_glucose,
            ROUND(SQRT(AVG(value * value) - AVG(value) * AVG(value)), 1) AS stddev_glucose,
            ROUND(100.0 * SQRT(AVG(value * value) - AVG(value) * AVG(value)) / AVG(value), 1) AS cv_pct
        FROM events
        WHERE type = 'cbg' AND value IS NOT NULL
        """,
    )[0]

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
        "daily_events": build_daily_events(conn),
        "basal_deviation": basal_deviation,
        "totals": totals,
    }


def main() -> None:
    args = parse_args()
    conn = sqlite3.connect(args.db)
    try:
        log_data = parse_log(args.log)
        cronometer_data = build_cronometer_data(conn)
        tidepool_data = build_tidepool_data(conn)
        period_summaries = build_period_summaries(tidepool_data, log_data)
        payload = {
            "generated_from": {
                "db": str(args.db),
                "log": str(args.log),
                "cronometer": str(args.db),
            },
            "tidepool": tidepool_data,
            "log": log_data,
            "cronometer": cronometer_data,
            "period_summaries": period_summaries,
            "meal_analysis": build_meal_analysis(conn, tidepool_data, period_summaries),
        }
    finally:
        conn.close()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        "window.DASHBOARD_DATA = "
        + json.dumps(payload, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
