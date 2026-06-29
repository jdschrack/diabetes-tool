# SignalWell Diabetes Dashboard

SignalWell is a local-first dashboard for reviewing diabetes, insulin, glucose,
meal, journal, and nutrition data. Tidepool pump/CGM exports and Cronometer
nutrition CSVs are imported into a local SQLite database. The FastAPI backend
computes the dashboard payload directly from that database on every request and
serves a React frontend.

The goal is pattern review for personal insight and care-team conversations. It
is not a dosing calculator and does not make therapy recommendations.

## What It Does

- Imports Tidepool JSON exports into `analysis/tidepool.db`.
- Imports Cronometer CSV exports into the same SQLite database.
- Skips exact duplicate Tidepool records and Cronometer rows.
- Computes daily glucose, insulin, basal, meal, event, journal, and nutrition
  summaries directly from the database at request time — there is no
  precomputed file cache.
- Shows Daily, Summary, Journal, Imports, and Help views in the web app.
- Exports Daily, Summary, and Journal views to generated PDF reports.

## Dashboard Views

### Daily

The Daily page focuses on one selected date.

- Glucose trend for the selected day, with carb, exercise, and note markers.
  CGM is drawn as the trend line; fingerstick (SMBG) readings overlay as red
  diamond markers. The time axis always spans the full 24 hours.
- Day Summary Stack with Time in Range, Total Carbs, Average Glucose, basal
  correction load, insulin split, and confidence-style signals.
- Basal rate profile compared with programmed basal.
- Meal recovery and selected-day meal impact analysis.
- Daily Macro Calories from Cronometer.

### Summary

The Summary page reviews a selectable date range.

- Time in Range and glucose summaries.
- Basal Profile, Correction Load, and Pattern Board summaries.
- Meal impact trend and recovery metrics.
- Nutrition Macro Calories for the selected range.

### Journal

The Journal page uses the same date selector as Summary.

- Journal Review metrics derived from the SQLite database (insulin from
  `daily_insulin`, carbs from `food`, average BG from `daily_glucose` which
  includes both CGM and fingerstick readings).
- Journal Summary table.
- Food Log table from imported Cronometer rows.

### Imports

The Imports page supports:

- Tidepool JSON upload.
- Cronometer CSV upload.
- Import job status with upload, import, and refresh steps.

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

- `analysis/` - persistent SQLite database
- `data/` - uploaded imports

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

Duplicate detection uses a SHA-256 hash of each record's canonical JSON.

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

## Dashboard Payload

The React app reads the entire payload through one endpoint:

```text
GET /api/dashboard
```

There is no precomputed dashboard data file. The endpoint opens
`analysis/tidepool.db` on every request, runs `server/dashboard.build_payload`,
and returns JSON.

## API

FastAPI endpoints:

- `GET /api/health`
- `GET /api/dashboard`
- `POST /api/import` - Tidepool JSON import
- `POST /api/import/cronometer` - Cronometer CSV import
- `GET /api/import/{job_id}` - import status

Import jobs run in the background. After the import script returns, the next
`/api/dashboard` request reflects the new data automatically.

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

Both CGM (`cbg`) and fingerstick (`smbg`) readings count toward the daily
average and time-in-range distribution, so days with no CGM coverage still get
a meaningful summary.

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

Meal analysis uses CGM (`cbg`) only because it depends on dense time-series
data; sparse fingerstick readings would distort the area-over-threshold and
recovery calculations.

### Basal Correction Load

Basal correction load is computed from positive basal delivered above the
active scheduled basal profile:

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

- `analysis/tidepool.db` - SQLite database (source of truth at runtime)
- `analysis/tidepool_summary.md` - import summary written by the Tidepool importer
- `data/imports/*` - uploaded Tidepool/Cronometer exports
- `mockups/*` - design references

Be intentional before committing personal health exports.
