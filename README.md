# SignalWell Diabetes Dashboard

SignalWell is a local-first dashboard for reviewing diabetes, insulin, glucose,
meal, journal, and nutrition data. It imports Tidepool pump/CGM exports and
Cronometer nutrition CSVs into a local SQLite database, builds derived analysis
data, and serves a React dashboard through FastAPI.

The goal is pattern review for personal insight and care-team conversations. It
is not a dosing calculator and does not make therapy recommendations.

## What It Does

- Imports Tidepool JSON exports into `analysis/tidepool.db`.
- Imports Cronometer CSV exports into the same SQLite database.
- Skips exact duplicate Tidepool records and Cronometer rows.
- Builds daily glucose, insulin, basal, meal, event, journal, and nutrition
  summaries.
- Shows Daily, Summary, Journal, Imports, and Help views in the web app.
- Exports Daily, Summary, and Journal views to generated PDF reports.
- Keeps all source data and generated analysis local to the repository.

## Dashboard Views

### Daily

The Daily page focuses on one selected date.

- Glucose trend for the selected day, with carb, exercise, and note markers.
- Day Summary Stack with Time in Range, Total Carbs, Average Glucose, basal
  correction load, insulin split, and confidence-style signals.
- Basal rate profile compared with programmed basal.
- Meal recovery and selected-day meal impact analysis.
- Daily Macro Calories from Cronometer, including:
  - total calories
  - macro calorie donut
  - macro breakdown for carbs, fat, and protein
  - fixed Breakfast, Lunch, Dinner, and Snacks cards
  - zero-filled meal cards when Cronometer has no row for that group

### Summary

The Summary page reviews a selectable date range.

- Time in Range and glucose summaries.
- Basal Profile, Correction Load, and Pattern Board summaries.
- Meal impact trend and recovery metrics.
- Nutrition Macro Calories for the selected range, including aggregate macro
  balance and daily macro calorie trends.

### Journal

The Journal page uses the same date selector as Summary.

- Journal Review metrics from `log.csv`.
- iLet baseline comparison.
- Journal Summary table.
- Food Log table from imported Cronometer rows.

### Imports

The Imports page supports:

- Tidepool JSON upload.
- Cronometer CSV upload.
- Import job status with upload, import, build, and reload steps.

### Help

The Help page documents the dashboard's non-standard metrics and analysis
fields.

## Running The App

The recommended way to run the dashboard is Docker Compose:

```sh
docker compose up --build
```

Then open:

```text
http://localhost:8000
```

Mounted paths:

- `analysis/` - persistent SQLite database and import summary
- `data/` - uploaded imports and local nutrition import artifacts
- `log.csv` - read-only daily journal input

## Local Development

Install frontend dependencies:

```sh
cd app
npm install
```

Build the frontend:

```sh
npm run build
```

Run the backend directly from the repo root:

```sh
uvicorn server.main:app --reload --host 0.0.0.0 --port 8000
```

The backend serves the built frontend from `app/dist`.

## Data Pipeline

### Tidepool Import

Rebuild the SQLite database from a Tidepool export:

```sh
python3 scripts/import_tidepool.py TidepoolExport.json
```

Append another Tidepool export and skip exact duplicate records:

```sh
python3 scripts/import_tidepool.py data/imports/TidepoolExport.json --append
```

Duplicate detection uses a SHA-256 hash of each record's canonical JSON. This
allows overlapping Tidepool exports to be appended while preserving distinct
records that share an `id` but differ by type or content.

### Cronometer Import

Import a Cronometer nutrition CSV:

```sh
python3 scripts/import_cronometer.py data/imports/cronometer.csv
```

The importer requires these columns:

- `Date`
- `Group`
- `Energy (kcal)`
- `Net Carbs (g)`
- `Carbs (g)`
- `Protein (g)`
- `Fat (g)`

It stores rows in `cronometer_nutrition`, hashes the canonical CSV row for
duplicate detection, and prints a JSON import summary.

### Build Dashboard Data

After importing data, rebuild the dashboard payload:

```sh
python3 scripts/build_dashboard_data.py
```

This writes:

```text
dashboard/dashboard-data.js
```

The React app reads the same payload through:

```text
GET /api/dashboard
```

## API

FastAPI endpoints:

- `GET /api/health`
- `GET /api/dashboard`
- `POST /api/import` - Tidepool JSON import
- `POST /api/import/cronometer` - Cronometer CSV import
- `GET /api/import/{job_id}` - import status

Import jobs run in the background and rebuild `dashboard/dashboard-data.js` when
the import completes.

## SQLite Contents

Core Tidepool tables:

- `events` - one row per Tidepool record with common fields and `raw_json`
- `event_attributes` - original top-level fields flattened by event
- `decoded_json` - embedded JSON parsed from fields such as `payload`,
  `nutrition`, `basal`, `bolus`, and `manufacturers`
- `import_metadata` - import source and record counts

Cronometer table:

- `cronometer_nutrition` - imported Cronometer nutrition rows keyed by row hash

Useful views created by the Tidepool importer:

- `cbg`
- `smbg`
- `basal`
- `bolus`
- `food`
- `device_events`
- `pump_settings`
- `daily_glucose`
- `daily_insulin`

## Analysis Notes

### Time In Range

Daily glucose is split into:

- Very Low: `<54 mg/dL`
- Low: `54-69 mg/dL`
- In Range: `70-180 mg/dL`
- High: `181-250 mg/dL`
- Very High: `>250 mg/dL`

### Meal Window Analysis

Meal analysis groups timezone-aligned food records that occur within 75 minutes
of each other into one meal window. It evaluates the next 4 hours for:

- pre-meal glucose
- peak glucose
- percent of readings above 180 mg/dL
- sustained time above 250 mg/dL
- estimated missing carb signal
- recovery time
- basal delivered above programmed basal
- low-after-high risk
- meal burden score

Duplicate non-timezone-adjusted upload rows are excluded from meal analysis.

### Basal Correction Load

Basal correction load is computed from positive basal delivered above the active
scheduled basal profile:

```text
extra basal = max(0, delivered basal units - scheduled basal units)
```

The calculation uses automated and scheduled basal records. It excludes temp
basal records when they overlap automated records to avoid double-counting
delivery. Basal intervals are split at hour boundaries and basal schedule
changes, then compared against the time-weighted scheduled rate.

### Macro Calories

Cronometer macro calories are derived with standard calorie factors:

```text
carb calories = carbs_g * 4
fat calories = fat_g * 9
protein calories = protein_g * 4
```

The Daily page reserves four food groups: Breakfast, Lunch, Dinner, and Snacks.
If a group is missing from Cronometer for the selected day, the card remains
visible and displays zero values. Cronometer `Uncategorized` rows are displayed
as `Snacks`.

## PDF Reports

The dashboard has a `Download PDF` action on Daily, Summary, and Journal pages.
PDFs are generated directly in the browser and are formatted for sharing a
compact, focused report with a care team. They do not call the browser print
dialog.

## Querying Without The sqlite3 CLI

If the `sqlite3` command-line tool is unavailable, use Python:

```sh
python3 -c 'import sqlite3; c=sqlite3.connect("analysis/tidepool.db"); print(c.execute("select * from daily_glucose limit 5").fetchall())'
```

## Generated And Local Files

Common generated/local files:

- `analysis/tidepool.db`
- `analysis/tidepool_summary.md`
- `dashboard/dashboard-data.js`
- `data/imports/*`
- `mockups/*`

These files are useful for local review, but be intentional before committing
personal health exports or generated data snapshots.
