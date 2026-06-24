# Tidepool SQLite Analysis

This workspace keeps `TidepoolExport.json` as the source of truth and builds a
local SQLite database for analysis.

## Build

```sh
python3 scripts/import_tidepool.py
```

This rebuilds `analysis/tidepool.db` from scratch.

To add another export into the existing database and skip exact duplicate
records:

```sh
python3 scripts/import_tidepool.py AnotherTidepoolExport.json --append
```

Generated files:

- `analysis/tidepool.db` - SQLite database
- `analysis/tidepool_summary.md` - compact import and analysis summary

## Schema

Core tables:

- `events` - one row per Tidepool record with common fields and `raw_json`
- `event_attributes` - every original top-level field flattened by event
- `decoded_json` - embedded JSON strings parsed from fields like `payload`,
  `nutrition`, `basal`, `bolus`, and `manufacturers`

Duplicate detection uses a SHA-256 hash of each record's canonical JSON. That
means overlapping exports can be appended safely while still preserving distinct
records that share an `id` but differ in type or content.

Useful views:

- `cbg`
- `smbg`
- `basal`
- `bolus`
- `food`
- `device_events`
- `pump_settings`
- `daily_glucose`
- `daily_insulin`

## Query Without sqlite3 CLI

The machine may not have the `sqlite3` shell installed. Python can query the
database directly:

```sh
python3 -c 'import sqlite3; c=sqlite3.connect("analysis/tidepool.db"); print(c.execute("select * from daily_glucose limit 5").fetchall())'
```

## Dashboard

Build the dashboard data after rebuilding or appending Tidepool data:

```sh
python3 scripts/build_dashboard_data.py
```

Then open:

```text
dashboard/index.html
```

The dashboard combines:

- Tidepool CGM data from `analysis/tidepool.db`
- Daily summary and baseline comparison from `log.csv`
- Delivered-vs-scheduled basal analysis from Tidepool basal records
- Day-by-day time in range split into:
  - Very Low: `<54 mg/dL`
  - Low: `54-69 mg/dL`
  - In Range: `70-180 mg/dL`
  - High: `181-250 mg/dL`
  - Very High: `>250 mg/dL`

The dashboard has two primary tabs:

- `Summary` - uses the summary period dropdown (`1 week`, `2 weeks`,
  `1 month`, `3 months`, `6 months`) and filters the summary charts to that
  lookback window ending on the latest available day.
- `Day Detail` - uses the day dropdown and shows the selected day's metrics,
  hourly basal deviation heatmap, glucose buckets, and insulin/carb summary.

The Daily Log and Baseline tables are outside the tab group so they remain
visible as reference data.

`Meal Window Analysis` groups timezone-aligned food records that occur within
75 minutes of each other into one meal. It then evaluates the next 4 hours for
CGM peak, percent of readings above 180 mg/dL, and basal delivered above the
configured profile. Duplicate non-timezone-adjusted upload rows are excluded
from this meal analysis.

Basal Correction Load is computed as positive basal delivered above the active
scheduled basal profile:

```text
extra basal = max(0, delivered basal units - scheduled basal units)
```

The calculation uses `automated` and `scheduled` basal delivery records. It
excludes `temp` basal records because, in this export, they overlap the
automated records and would double count delivery. Basal intervals are split at
hour boundaries and basal schedule changes, then compared against the
time-weighted scheduled rate for that interval.

## Containerized App

The Vite/React + FastAPI app runs in Docker and serves the dashboard at:

```text
http://localhost:8000
```

Start it with:

```sh
docker compose up --build
```

The app includes an `Import Tidepool JSON` button. Uploading an export appends
it to `analysis/tidepool.db` with duplicate detection, then refreshes the
dashboard data.

Mounted paths:

- `analysis/` - persistent SQLite database
- `data/imports/` - uploaded Tidepool exports
- `log.csv` - read-only daily log input
