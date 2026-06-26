#!/usr/bin/env python3
"""Import Cronometer nutrition CSV rows into SQLite with duplicate detection."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REQUIRED_COLUMNS = ["Date", "Group", "Energy (kcal)", "Net Carbs (g)", "Carbs (g)", "Protein (g)", "Fat (g)"]
NUTRIENT_COLUMNS = [
    ("energy_kcal", "Energy (kcal)"),
    ("alcohol_g", "Alcohol (g)"),
    ("caffeine_mg", "Caffeine (mg)"),
    ("water_g", "Water (g)"),
    ("net_carbs_g", "Net Carbs (g)"),
    ("carbs_g", "Carbs (g)"),
    ("fiber_g", "Fiber (g)"),
    ("sugars_g", "Sugars (g)"),
    ("added_sugars_g", "Added Sugars (g)"),
    ("fat_g", "Fat (g)"),
    ("saturated_fat_g", "Saturated (g)"),
    ("protein_g", "Protein (g)"),
    ("cholesterol_mg", "Cholesterol (mg)"),
    ("sodium_mg", "Sodium (mg)"),
    ("potassium_mg", "Potassium (mg)"),
    ("magnesium_mg", "Magnesium (mg)"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--db", default=Path("analysis/tidepool.db"), type=Path)
    return parser.parse_args()


def clean(value: str | None) -> str:
    return "" if value is None else value.strip()


def parse_float(value: str | None) -> float | None:
    cleaned = clean(value).replace(",", "")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_bool(value: str | None) -> int | None:
    cleaned = clean(value).lower()
    if cleaned in {"true", "yes", "1"}:
        return 1
    if cleaned in {"false", "no", "0"}:
        return 0
    return None


def row_hash(row: dict[str, str], headers: list[str]) -> str:
    payload = {header: clean(row.get(header)) for header in headers}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError("CSV has no header row")
        headers = [clean(header) for header in reader.fieldnames]
        rows = []
        for row in reader:
            if not any(clean(value) for value in row.values()):
                continue
            rows.append({clean(key): clean(value) for key, value in row.items() if key is not None})
    return headers, rows


def validate_headers(headers: list[str]) -> None:
    missing = [column for column in REQUIRED_COLUMNS if column not in headers]
    if missing:
        raise ValueError(f"Cronometer CSV is missing required columns: {', '.join(missing)}")


def create_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cronometer_nutrition (
            row_hash TEXT PRIMARY KEY,
            source_file TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            date TEXT NOT NULL,
            meal_group TEXT NOT NULL,
            energy_kcal REAL,
            alcohol_g REAL,
            caffeine_mg REAL,
            water_g REAL,
            net_carbs_g REAL,
            carbs_g REAL,
            fiber_g REAL,
            sugars_g REAL,
            added_sugars_g REAL,
            fat_g REAL,
            saturated_fat_g REAL,
            protein_g REAL,
            cholesterol_mg REAL,
            sodium_mg REAL,
            potassium_mg REAL,
            magnesium_mg REAL,
            completed INTEGER,
            raw_json TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cronometer_date_group ON cronometer_nutrition(date, meal_group)")


def insert_rows(conn: sqlite3.Connection, rows: list[dict[str, str]], headers: list[str], source_file: str) -> tuple[int, int]:
    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    imported = 0
    duplicates = 0
    for row in rows:
        digest = row_hash(row, headers)
        if conn.execute("SELECT 1 FROM cronometer_nutrition WHERE row_hash = ?", (digest,)).fetchone():
            duplicates += 1
            continue
        values: dict[str, Any] = {
            "row_hash": digest,
            "source_file": source_file,
            "imported_at": imported_at,
            "date": clean(row.get("Date")),
            "meal_group": clean(row.get("Group")),
            "completed": parse_bool(row.get("Completed")),
            "raw_json": json.dumps(row, ensure_ascii=False, sort_keys=True),
        }
        for column, source in NUTRIENT_COLUMNS:
            values[column] = parse_float(row.get(source))
        conn.execute(
            """
            INSERT INTO cronometer_nutrition (
                row_hash, source_file, imported_at, date, meal_group, energy_kcal,
                alcohol_g, caffeine_mg, water_g, net_carbs_g, carbs_g, fiber_g,
                sugars_g, added_sugars_g, fat_g, saturated_fat_g, protein_g,
                cholesterol_mg, sodium_mg, potassium_mg, magnesium_mg,
                completed, raw_json
            )
            VALUES (
                :row_hash, :source_file, :imported_at, :date, :meal_group, :energy_kcal,
                :alcohol_g, :caffeine_mg, :water_g, :net_carbs_g, :carbs_g, :fiber_g,
                :sugars_g, :added_sugars_g, :fat_g, :saturated_fat_g, :protein_g,
                :cholesterol_mg, :sodium_mg, :potassium_mg, :magnesium_mg,
                :completed, :raw_json
            )
            """,
            values,
        )
        imported += 1
    return imported, duplicates


def totals(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT COUNT(*) AS rows, COUNT(DISTINCT date) AS days, MAX(date) AS latest_day
        FROM cronometer_nutrition
        """
    ).fetchone()
    return {"rows": row[0], "days": row[1], "latest_day": row[2]}


def main() -> None:
    args = parse_args()
    headers, rows = read_rows(args.csv_path)
    validate_headers(headers)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.db)
    try:
        create_schema(conn)
        imported, duplicates = insert_rows(conn, rows, headers, args.csv_path.name)
        conn.commit()
        summary = totals(conn)
    finally:
        conn.close()
    print(
        json.dumps(
            {
                "imported": imported,
                "duplicates": duplicates,
                "total_rows": summary["rows"],
                "days": summary["days"],
                "latest_day": summary["latest_day"],
                "db": str(args.db),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - command line error should be visible to import jobs.
        print(str(exc))
        raise SystemExit(1) from exc
