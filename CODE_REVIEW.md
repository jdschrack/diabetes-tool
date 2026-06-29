# SignalWell Diabetes Dashboard — Code Review & Recommendations

**Date:** 2026-06-29
**Scope:** Full codebase (`server/`, `scripts/`, `app/src/`, container & repo config)
**Method:** Two independent review passes — a correctness-focused `/code-review`
(bug hunt across 6 finder angles) and an `/adversarial-reviewer` pass
(architecture, security, reliability, clinical-safety red-team). Duplicate and
overlapping findings from both passes have been merged into the single list
below. Every action item was spot-checked against the actual source before
inclusion; three originally-reported items were dropped or corrected as noted in
the appendix.

Findings are grouped by severity. Each item lists the evidence, why it matters,
and a concrete recommendation.

---

## Critical

### C1. Personal health data (PHI) is committed to git history
- **Where:** `analysis/tidepool.db` (25 MB) and `analysis/tidepool_summary.md` are tracked; `.gitignore` covers `data/imports/` but **not** `analysis/`.
- **Why it matters:** The full CGM/insulin/pump/nutrition history is embedded across ~10+ commits (`"Adding yesterday's data"`, `"Update 6/27"`, …). This is a public GitHub repo with merged PRs. Deleting the file now does **not** remove it from history; every clone still carries the PHI. The README even warns "Be intentional before committing personal health exports" — which the repo violates.
- **Recommendation:**
  1. `git rm --cached analysis/tidepool.db analysis/tidepool_summary.md`.
  2. Add `analysis/` (or `analysis/*.db`, `analysis/*.md`) to `.gitignore`. The DB is a runtime artifact already volume-mounted by `docker-compose.yml`.
  3. Scrub history with `git filter-repo` or BFG and force-push. Treat the exposed data as compromised (rotate/aware as appropriate).

### C2. Clinical glucose metrics blend CGM and fingerstick (SMBG) readings
- **Where:** `server/dashboard.py` `build_tidepool_data` — `daily_ranges` and `totals` use `WHERE type IN ('cbg','smbg')` for `avg_glucose`, `stddev_glucose`, `cv_pct`, and all time-in-range buckets.
- **Why it matters:** Time-in-Range, GMI, CV, and SD are defined by clinical consensus (ADA/international) as **CGM-only** metrics. CGM produces ~288 readings/day; fingersticks are sparse and behaviorally biased (people test when they feel high/low). Pooling them unweighted skews every headline number the dashboard presents to a care team, and `readings` (the weighting denominator in `build_period_summaries`) is distorted too. *(This was an intentional product choice earlier in the session, but it conflicts with standard metric definitions and should at minimum be labeled.)*
- **Recommendation:** Compute TIR/GMI/CV/SD from `cbg` only; surface SMBG separately as supplemental spot-checks (the chart already plots them as distinct markers). If mixed-source days must show a number, label it "mixed" and/or suppress CGM metrics on days below a coverage threshold (e.g. <70% of expected CGM readings).

### C3. No automated tests and no CI
- **Where:** No `tests/` directory, no `.github/workflows`.
- **Why it matters:** Substantial patient-facing analytic logic (time-in-range bucketing, basal-deviation roll-ups, meal clustering, area-over-threshold, GMI) lives in ~930 lines of `dashboard.py` with thresholds duplicated in the frontend. Any refactor — including the fixes in this document — can silently change the numbers a care team relies on, with nothing to catch the regression.
- **Recommendation:** Add `pytest` golden tests over a small fixture SQLite DB asserting exact `build_payload` outputs (TIR/CV/GMI/basal-deviation/meal attribution) plus an empty-DB smoke test. Add a GitHub Actions workflow running `ruff`/`mypy`, `pytest`, and `npm run build` (tsc) on every PR.

---

## High

### H1. No authentication, with `CORS allow_origins=["*"]`
- **Where:** `server/main.py` — all endpoints unauthenticated; CORS wildcard; dev/preview servers bind `0.0.0.0`.
- **Why it matters:** Acceptable for strictly-localhost single-user use, but if the host is ever reachable on a LAN/VPN/exposed port, anyone can `GET /api/dashboard` to read all PHI or `POST /api/import` to overwrite/append the database — no credentials. The `*` CORS additionally lets any website the user visits read the localhost dashboard JSON.
- **Recommendation:** Restrict CORS to the actual frontend origin; add a minimal auth guard (even a local token) on the import endpoints; document the localhost-only assumption explicitly. Flagged by both security and architecture passes.

### H2. Stored XSS in the daily-glucose chart tooltip
- **Where:** `app/src/App.tsx` `dayGlucoseOption` tooltip `formatter` (~line 461) returns an HTML string built by concatenating user note/event text: `` `${event.value[2]}: ${event.value[4] || event.value[3]}` `` where the values originate from Tidepool note/`name` fields (`dashboard.py` `event_text`). ECharts renders formatter output as HTML by default.
- **Why it matters:** A Tidepool note containing `<img src=x onerror=...>` is stored in SQLite, served via `/api/dashboard`, and executes when the user hovers that marker — in an origin that can drive the unauthenticated import endpoints and read all displayed PHI.
- **Recommendation:** HTML-escape all interpolated user text in the formatter (or return a DOM structure / use a sanitizer). Audit the Carbs/Events markers and the jsPDF report for the same raw-text pattern.

### H3. Imports are not crash-safe or read-safe against the live database
- **Where:** `scripts/import_tidepool.py` runs in `--append` mode and `create_schema()` unconditionally `DROP VIEW`s (basal/bolus/food/daily_insulin) then recreates them, committing once at the end; meanwhile `server/main.py` answers `/api/dashboard` against the same file. `server/dashboard.py` is gated only by `table_exists(conn,'events')`, not by the views it then queries.
- **Why it matters:** During an import, a concurrent dashboard request can hit `sqlite3.OperationalError: database is locked`, or observe views mid-drop → `no such table: daily_insulin` → 500. A crash/kill mid-import (e.g. OOM from a huge upload) leaves the only datastore partially written and possibly with views dropped, and there is no backup or rollback.
- **Recommendation:** Import into a staging copy and atomically swap on success (or wrap in a single transaction); snapshot the DB before each import; enable WAL mode + `busy_timeout` to reduce read/write contention; serialize imports. Have `build_payload` degrade gracefully if expected views are missing.

### H4. Full payload recomputed from all history on every request, with no caching
- **Where:** `server/dashboard.py` `build_payload` recomputes everything per `/api/dashboard` call; `build_basal_deviation` steps through every basal record (minute→hour/schedule-boundary) across all history each time; `glucose_points` + `smbg_points` for all history are serialized into the response.
- **Why it matters:** Cost grows with dataset size; meal analysis is O(meals × boluses). At ~288 readings/day, one year ≈ 105K glucose rows plus tens of thousands of basal segments; at 2–5 years this becomes hundreds of thousands of rows re-aggregated and a large Python loop on **every** page load and every 1.2 s import-status poll, against a single blocking SQLite connection. Latency degrades from snappy to multi-second and the JSON payload balloons unbounded.
- **Recommendation:** Cache the payload keyed on DB mtime/last-import; add a date-range/window parameter so the dashboard fetches a bounded period instead of all history; materialize daily/hourly rollups into tables incrementally at import time and read precomputed aggregates at request time.

---

## Medium

### M1. `stddev`/`cv_pct` use a numerically unstable formula that can NULL out — and depends on SQLite `SQRT`
- **Where:** `server/dashboard.py` — `SQRT(AVG(value*value) - AVG(value)*AVG(value))` in `daily_ranges` and `totals`.
- **Why it matters:** For near-constant glucose days, `E[x²]−E[x]²` can be a tiny negative float; SQLite's `SQRT` returns NULL for a negative argument, silently blanking `stddev_glucose`/`cv_pct` instead of showing ~0. Worse, `SQRT` only exists when SQLite is built with `SQLITE_ENABLE_MATH_FUNCTIONS`; on a Python whose bundled SQLite lacks it, every dashboard request 500s with `no such function: SQRT`.
- **Recommendation:** Compute SD in Python from the fetched values (or guard with `MAX(0, …)` before `SQRT` and avoid the math-extension dependency). Add a test for a flat-glucose day.

### M2. `build_meal_analysis` crashes on a NULL `carbs` food row
- **Where:** `server/dashboard.py` meal clustering — `clusters[-1]["carbs"] += food["carbs"]` and initial `"carbs": food["carbs"]` with no None guard (unlike the SQL `daily_food` which uses `SUM`, ignoring NULLs).
- **Why it matters:** A single food record with NULL `carbs` raises `TypeError: unsupported operand … NoneType`, which propagates out and turns the whole `/api/dashboard` request (and the import-job reload step) into a 500. Nothing enforces non-null carbs at import.
- **Recommendation:** Coerce `food["carbs"] or 0.0` at read time, or filter NULL carbs in the query.

### M3. SMBG-only days render an empty glucose trend line
- **Where:** `app/src/App.tsx` `dayGlucoseOption` — the `"CGM"` line series is `data: rows.map(...)` (cbg-only) even though `fallbackRows`/`smbgRows` were introduced for the nearest-glucose lookup (confirmed at ~line 504).
- **Why it matters:** On a day with fingersticks but no CGM (sensor warmup/failure — exactly the gap this session set out to handle), the trend line is empty; the user sees only floating red diamonds and the in-range band against an empty series, making a day that *has* data look broken.
- **Recommendation:** Build the line/visualMap series from `fallbackRows` (or render an explicit "fingerstick-only" presentation) when `rows` is empty.

### M4. PDF fingerstick dots misalign with the CGM curve on partial-coverage days
- **Where:** `app/src/reportPdf.ts` `drawLineChart` plots the CGM polyline by **array index** (`index/(points.length-1)`), but SMBG dots by **time-of-day fraction** (`minuteOfDay/1440`).
- **Why it matters:** If CGM covers only 06:00–12:00, the polyline still stretches across the full width while an 18:00 fingerstick lands at 75% width — markers don't line up with the curve at the same clock time in a clinical report.
- **Recommendation:** Position both series on the same x-scale — either index both by time-of-day fraction, or pass the CGM points with explicit time positions.

### M5. No schema versioning or migrations
- **Where:** `scripts/import_tidepool.py` `create_schema` uses `CREATE TABLE IF NOT EXISTS` + `DROP VIEW`; no `schema_version` recorded.
- **Why it matters:** When columns/views change in a future version, an existing user DB silently diverges — `IF NOT EXISTS` skips altering pre-existing tables, so new columns never appear while `dashboard.py` assumes the new shape → runtime errors or silently wrong results, with no way to detect the mismatch and no upgrade path short of a destructive re-import.
- **Recommendation:** Store a `schema_version` in `import_metadata`; add an idempotent, ordered migration runner; have the server assert a minimum version on startup.

### M6. Duplicate-detection by full-record hash is fragile
- **Where:** `scripts/import_tidepool.py` (`record_hash` = SHA-256 of the whole canonical record) and `scripts/import_cronometer.py` (hash over all columns).
- **Why it matters:** Tidepool re-serializes records with volatile fields (payload/annotations/modifiedTime); a re-export of an overlapping range hashes differently and the same physiological reading is inserted twice, double-counting `COUNT(*)` and skewing every aggregate. For Cronometer, editing a logged food produces a second `(date, Total)` row — the import summary's `total_rows` then disagrees with what the dashboard's `ROW_NUMBER` dedup actually shows.
- **Recommendation:** Dedup on a stable natural key (e.g. Tidepool record `id` + `type`, or a hash over only physiologically-meaningful fields). Reconcile the import-summary count with the dashboard's effective dedup.

### M7. Import job state is in-memory and single-process
- **Where:** `server/main.py` `IMPORT_JOBS` dict + `threading.Lock`; FastAPI `BackgroundTasks`.
- **Why it matters:** Under multiple workers (`uvicorn --workers N`, the normal production setup) each worker has its own dict, so `POST /api/import` on worker A then `GET /api/import/{id}` on worker B → 404 "job not found" even though the import succeeded. A restart loses all job status; a killed import subprocess leaves a job stuck "running" forever.
- **Recommendation:** Persist job state (a small table) or document/enforce single-worker; mark in-flight jobs failed on startup; add a job timeout/heartbeat.

### M8. No upload size limit / resource-exhaustion guard
- **Where:** `server/main.py` upload handlers stream to disk with `shutil.copyfileobj` (no size cap); `import_tidepool.py` does `json.loads(source.read_text())` (whole file into memory).
- **Why it matters:** A multi-GB upload fills the disk and is then loaded entirely into RAM, OOM-killing the worker; the job is left stuck "running". Combined with no auth/`*` CORS, this is a remote DoS if exposed.
- **Recommendation:** Enforce a max body size (middleware or explicit check), validate file size before processing, and prefer a streaming/iterative parse for large exports.

### M9. No logging or observability
- **Where:** Backend has no `logging`; errors surface only via job objects or `print()`; `/api/dashboard` has no error wrapper.
- **Why it matters:** Failures are near-undiagnosable — a transient DB error yields an opaque 500 with nothing recorded; failed imports leave only truncated `stdout[-8000:]`.
- **Recommendation:** Add the stdlib `logging` module with structured handlers, a FastAPI exception handler, and import-job lifecycle logging.

### M10. Internal error detail leaked to clients
- **Where:** `server/main.py` import jobs store subprocess `stdout`/`stderr` (last 8000 bytes) and raw exception strings, returned verbatim via `GET /api/import/{job_id}`.
- **Why it matters:** Tracebacks and absolute filesystem paths (`ROOT`, `DB_PATH`, filenames) are sent to any caller, aiding reconnaissance — compounded by the missing auth.
- **Recommendation:** Log full detail server-side; return a sanitized user-facing message.

### M11. Timezone / DST / travel assumptions are baked in at import
- **Where:** `scripts/import_tidepool.py` freezes `local_time` via `iso_to_local(time, timezoneOffset)`; all bucketing/meal-window/basal-schedule math keys off naive `local_time`.
- **Why it matters:** Travel and DST are routine. A wrong/stale device offset, multiple devices with different offsets, or the 23/25-hour DST days cause records to land on the wrong calendar day, mis-assign meals, and produce spurious basal "delivered vs programmed" deviation. Fixing requires a full re-import since `local_time` is frozen.
- **Recommendation:** Store UTC as canonical and derive local presentation at query time from an explicit timezone policy; detect/surface offset changes; at minimum document the single-timezone assumption and flag days where device offsets disagree.

### M12. Clinical disclaimer vs. dosing-adjacent numbers
- **Where:** `server/dashboard.py` meal analysis surfaces `estimated_missing_carbs`, `review_carbs_per_unit`, and `observed_sensitivity` (mg/dL/U) from coarse heuristics; the product states it is "not a dosing calculator."
- **Why it matters:** These are exactly the quantities used for insulin dosing. Presenting them as concrete numbers invites the user to treat them as carb-correction/ISF guidance. The derivation conflates correlation (extra basal ran during a high) with causation (the high was caused by under-bolusing), so the figures can be confidently wrong in a dangerous direction.
- **Recommendation:** Reframe as qualitative pattern flags (not numeric estimates), or gate behind explicit "not a dosing recommendation — confirm with your care team" context at the point of display; document the heuristic assumptions.

### M13. EChart wrapper disposes and re-initializes on every render
- **Where:** `app/src/charts/EChart.tsx` calls `echarts.init` inside a `useEffect` keyed on `[option]`, and option objects are rebuilt inline in JSX every render (never memoized).
- **Why it matters:** Every parent render tears down and recreates each chart (init + setOption + listener churn), discarding zoom/hover state, re-animating, and adding GC pressure — visible jank on data-heavy days and on each keystroke in the date field.
- **Recommendation:** Keep one chart instance per mount and call `setOption` on updates; memoize the option builders (`useMemo`) and/or the `EChart` component.

---

## Low

### L1. "Previous period" comparison can use a mismatched window
- **Where:** `app/src/App.tsx` `previousDays` = `available.slice(startIndex - summaryDays.length, startIndex)`, mixing a data-day count with a calendar-position index.
- **Why it matters:** With gaps in available days, the prior window covers a different number of real days than the current period, so every "vs prior window" delta is computed against a mismatched baseline.
- **Recommendation:** Define the previous window by date arithmetic (same calendar span), not by slicing the available-days array.

### L2. `nearestGlucose` renders a phantom 90 mg/dL on data-less days
- **Where:** `app/src/App.tsx` `nearestGlucose` returns hardcoded `90` when `fallbackRows` is empty.
- **Why it matters:** On a day with no CGM **and** no SMBG, meal/event markers render at 90 mg/dL as if real, with no indication it's a placeholder.
- **Recommendation:** Suppress markers (or render them on a neutral baseline clearly flagged as "no glucose data") when there are no readings.

### L3. CSV formula injection on re-export
- **Where:** `scripts/import_cronometer.py` stores cell values unmodified; values starting with `= + - @` are surfaced in the dashboard/PDF.
- **Why it matters:** If any view re-exports to CSV/Excel, a crafted cell like `=HYPERLINK(...)` executes as a formula in the victim's spreadsheet app.
- **Recommendation:** Prefix risky leading characters with `'` on any CSV export path (no export exists today, so this is forward-looking).

### L4. God-files hurt navigability and review
- **Where:** `app/src/App.tsx` (~2,569 lines, entire UI in one component file), `server/dashboard.py` (~927 lines), `app/src/reportPdf.ts` (~703 lines).
- **Why it matters:** Almost any change touches these files; merges conflict heavily and review is harder.
- **Recommendation:** Split `App.tsx` into per-view components plus shared chart-option/table modules; split `dashboard.py` into cohesive modules (sql/views, basal, meals, payload).

### L5. Clinical thresholds and constants are duplicated as magic numbers
- **Where:** Range bounds `70/180/250/54`, the 75-minute meal-cluster window, the 4-hour post-meal window, and the `288` readings/day denominator appear as inline literals in `dashboard.py`, `App.tsx`, and `reportPdf.ts`.
- **Why it matters:** A threshold change must be edited in 3–4 places; a miss produces inconsistent numbers between the live dashboard and the exported PDF a care team reads. *(Note: with `build_dashboard_data.py` removed, the backend now has a single source of truth — `dashboard.py` — so the remaining drift risk is dashboard ↔ PDF ↔ frontend.)*
- **Recommendation:** Define these once in a shared backend constants module and expose them in the payload (or a small `/api/config`) so the frontend and PDF consume the same values.

### L6. Broad exception handling and duplicated job runners
- **Where:** `server/main.py` `run_import_job`/`run_cronometer_import_job` are near-duplicate ~40-line functions with `except Exception: # noqa: BLE001`; `import_cronometer.py` wraps all of `main()` in `except Exception`.
- **Why it matters:** Swallowing broad exceptions loses tracebacks/types (only a stringified message survives); the duplicate runners are a maintenance smell.
- **Recommendation:** Catch specific exceptions, log full tracebacks before storing a user-facing message, and factor the two runners into one parameterized helper.

### L7. Dockerfile runs as root, no healthcheck, fragile `COPY . ./`
- **Where:** `Dockerfile`.
- **Why it matters:** Running uvicorn as root is unnecessary privilege; there's no `HEALTHCHECK` despite a `/api/health` endpoint. *(Note: `.dockerignore` already excludes `analysis/`, `data/`, so PHI is **not** baked into the image — but `COPY . ./` is fragile and will silently include anything new that isn't ignored.)*
- **Recommendation:** Add a non-root user; add a `HEALTHCHECK` on `/api/health`; replace `COPY . ./` with explicit `COPY server/ scripts/ …`.

### L8. Hardcoded config / no settings layer
- **Where:** `DB_PATH`, `IMPORT_DIR`, `STATIC_DIR`, port, CORS are baked into `server/main.py`; import scripts default `--db` to a relative path that only works from repo root.
- **Why it matters:** Can't relocate the DB or set origins without code edits; running an import script from another directory writes a DB in the wrong place.
- **Recommendation:** Add a small settings module (env vars / `pydantic-settings`) and share the DB-path constant between server and scripts.

### L9. Dead `.baseline-*` CSS remains after the iLet feature removal
- **Where:** `app/src/styles.css` — ~16 `.baseline-grid` / `.baseline-card` / `.baseline-bars` / `.baseline-change` selectors (lines 491–551 plus responsive blocks at 1493/1555/1675); zero references in any `.tsx`/`.ts` (confirmed).
- **Why it matters:** Dead code misleads maintainers about what UI exists.
- **Recommendation:** Remove the unused `.baseline-*` rules.

### L10. Meal-clustering heuristics are fragile for common patterns
- **Where:** `server/dashboard.py` `build_meal_analysis` — 75-min gap + same-window clustering, greedy nearest-bolus matching (`used_bolus`), fixed 4h/6h windows, hardcoded meal taxonomy.
- **Why it matters:** Greedy matching mis-attributes a bolus equidistant from two meals; grazing, split/extended boluses, corrections-without-food, and meals straddling window edges all break clustering; overlapping 4h windows double-count excursions — exactly the patterns a user most wants to investigate.
- **Recommendation:** Make windows/gaps configurable and documented; handle extended/dual boluses and unmatched corrections explicitly; flag ambiguous matches as low-confidence rather than forcing an assignment.

### L11. Dependency hygiene
- **Where:** `requirements.txt` pins are not recent (`fastapi==0.115.6`, `uvicorn==0.34.0`, `python-multipart==0.0.20`); frontend uses caret ranges (`echarts ^5.6.0`, `jspdf ^4.2.1`); no dependency scanning.
- **Why it matters:** Pinned-but-stale backend packages won't pick up security fixes (notably `python-multipart`, which parses the upload attack surface); caret ranges allow a compromised minor to be pulled on a fresh install.
- **Recommendation:** Enable Dependabot/`pip-audit`/`npm audit` in CI and review current advisories before bumping.

### L12. `.dockerignore` references a deleted directory
- **Where:** `.dockerignore` lists `dashboard`, which was removed earlier (static viewer retired).
- **Why it matters:** Minor staleness; harmless but confusing.
- **Recommendation:** Drop the `dashboard` entry.

---

## Appendix — items checked and dropped/corrected during review

These were raised by a reviewer but did **not** survive verification against the
current tree, and are recorded here for transparency:

- **`data.json` untracked in repo root** — already deleted this session; working tree is clean. No action.
- **Logic drift between `dashboard.py` and `scripts/build_dashboard_data.py`** — the old build script was deleted; the backend now has a single source of truth. Reframed as the narrower dashboard ↔ PDF ↔ frontend duplication in **L5**.
- **PHI baked into the Docker image via `COPY . ./`** — `.dockerignore` excludes `analysis/` and `data/`, so PHI is not included. The non-root/healthcheck concerns remain (**L7**).
- **`run_import_job` references `result.stdout` out of scope** — `result` is still in scope from the import step; not a bug.
- **Daily chart `xAxis` string `min`/`max` causing a timezone day-shift** — `local_time` is stored without an offset and the bare `${day}T..` strings parse on the same local clock, so points and axis align. Only a benign one-second clip at `23:59:59`; downgraded to negligible.

---

## Suggested order of attack

1. **C1** (purge PHI from git) — do this first; it's the only irreversible-exposure item.
2. **C3** (tests + CI) — establishes the safety net for everything below.
3. **C2 / M1 / M2 / M3 / M4** — correctness of the numbers and charts the tool exists to show.
4. **H1 / H2 / M8 / M10** — security hardening (cheap, high value if the host is ever exposed).
5. **H3 / M5 / M6 / M7** — data-integrity and import robustness.
6. **H4 / M13** — performance, before the dataset grows.
7. **M9 / M11 / M12** — observability, timezone correctness, clinical-safety framing.
8. **Low items** — cleanup and hygiene as capacity allows.
