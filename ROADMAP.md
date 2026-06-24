# Tidepool Dashboard Roadmap

This document tracks proposed improvements for the local Tidepool/Twiist dashboard. It is intentionally decision-oriented: items can move from "open decision" to "planned" as we agree on the right approach.

## Current Goal

Build a local dashboard that combines Tidepool pump/CGM data, journal data, and eventually nutrition data to understand:

- Whether the pump is compensating for weak or mistimed meal boluses through elevated basal delivery.
- Which meal windows create the most post-meal glucose burden and insulin cleanup.
- How changes to meal strategy affect glucose recovery, basal correction load, and total insulin use over time.

This dashboard is for pattern analysis and personal review. It is not a dosing engine.

## Current Capabilities

- Import Tidepool JSON into SQLite with append/de-duplication support.
- Build a local React dashboard served from a Docker container.
- Show summary periods: 1 week, 2 weeks, 1 month, 3 months, 6 months.
- Show selected-day detail with glucose trend, time in range, insulin/carbs, and basal deviation.
- Compare delivered basal against programmed basal by hour.
- Analyze meal windows by breakfast, lunch, dinner, and overnight/other.
- Show journal CSV summaries and iLet vs Twiist baseline comparisons.
- Explain custom metrics in-app.

## Key Metrics We Track

- Time in range by glucose bucket.
- Avg glucose, standard deviation, and CV.
- Total insulin, basal insulin, bolus insulin, and basal/bolus percentages.
- Extra basal: delivered basal above programmed basal.
- Net basal: delivered basal minus programmed basal.
- Correction load: extra basal as a percentage of estimated total insulin.
- Post-meal peak glucose.
- Post-meal percent of readings above 180 mg/dL.
- Time to recovery after crossing above 180 mg/dL.
- Area over 180: estimated glucose exposure above range.
- Correction efficiency: extra basal relative to above-range glucose exposure.
- Low-after-correction risk.
- Meal burden score.
- Meal burden variability.

## Planned Improvements

### 1. Nutrition Data Module

Add a local nutrition module so meal analysis can include carbs, protein, fat, fiber, and calories.

Proposed model:

- `foods`
  - name
  - brand
  - barcode
  - source
  - serving size
  - calories
  - carbs
  - protein
  - fat
  - fiber
  - sugar
  - verified flag
  - last verified date
  - notes
- `meal_entries`
  - date/time
  - meal type
  - food id
  - serving multiplier
  - calculated macros
- `meal_logs`
  - grouped meal event
  - total macros
  - linked Tidepool meal window if available

Initial approach:

- Use public datasets only as lookup aids.
- Store verified local values as the source of truth.
- Let the user manually correct and verify recurring foods.
- Default analysis should use verified foods only, with an option to include unverified entries.

Candidate public sources:

- USDA FoodData Central for generic foods and some branded foods.
- Open Food Facts for barcode lookup.
- Manual entry for package labels and custom foods.

Open decisions:

- Should barcode lookup be online-only, cached locally, or both?
- Should unverified foods appear in analysis by default?
- Should we support CSV import/export before building a full meal logger UI?
- What exact nutrient fields matter first: carbs/protein/fat/fiber/calories only, or also sugar/sodium?

### 2. Local Food and Meal Logger

Add a simple in-dashboard workflow for meal logging.

Proposed workflow:

1. Search or scan a food.
2. Choose public lookup result or local trusted food.
3. Verify/correct nutrition values.
4. Add serving amount to a meal.
5. Save meal with timestamp and meal type.
6. Dashboard links that meal to glucose and insulin response.

Open decisions:

- Should barcode scanning happen through phone camera in the web app, or should we start with manual barcode entry?
- Should meal logging be optimized for desktop, mobile, or both?
- Should the app allow quick-repeat meals from prior entries?

### 3. Better Meal Analysis

Improve meal-window logic once nutrition data exists.

Planned metrics:

- Carbs, protein, fat, fiber, and calories per meal window.
- Protein/fat delayed-impact markers.
- Macro-adjusted recovery time.
- Macro-adjusted insulin response.
- Similar-meal comparisons.
- Recurring food impact: same food, multiple days, different outcomes.

Open decisions:

- Should meal windows stay fixed at 4 hours, or should high-fat/high-protein meals use longer windows?
- Should breakfast/lunch/dinner time boundaries be configurable?
- Should meals be linked by logged nutrition entries instead of Tidepool food entries when both exist?

### 4. Analysis and Recommendation Views

Add views that make patterns easier to act on.

Potential views:

- Meal ranking by burden score.
- Meal ranking by extra basal.
- Meal ranking by time to recovery.
- Day ranking by correction load.
- Heatmap of correction load by hour and meal type.
- Similar meal comparison table.
- Trend view before/after a behavior change.

Open decisions:

- Should we add a "notes/intervention" feature to mark changes like breakfast bolus adjustment?
- Should reports compare two selected periods, such as "before" and "after"?
- Which charts are most useful versus just adding noise?

### 5. Data Quality and Trust

Make data quality visible.

Planned ideas:

- Flag foods as verified/unverified.
- Show source for nutrition data.
- Show missing macro fields.
- Show duplicated or suspicious Tidepool records.
- Show incomplete days.
- Separate full days from partial days in summaries.

Open decisions:

- What threshold makes a day "complete" for CGM readings?
- Should partial days be excluded by default from summary periods?
- Should foods imported from public datasets expire or require re-verification?

### 6. Container and Import Workflow

Improve local operation.

Potential improvements:

- Add import history.
- Add import status and error details in the UI.
- Support importing nutrition CSV files.
- Support downloading dashboard-derived CSV exports.
- Persist application data in SQLite instead of generated JavaScript payloads.

Open decisions:

- Keep generated dashboard JSON as a simple data boundary, or move the app to live API queries?
- Should nutrition data live in the same SQLite database as Tidepool data or a separate database?

### 7. Apple Health and Fitness Import

Add Apple Watch / Apple Health data so the dashboard can correlate exercise, heart rate, and other telemetry with glucose, insulin, basal reduction, and meal recovery.

Potential import paths:

- Apple Health export ZIP
  - User exports from the iPhone Health app.
  - Dashboard imports and parses `export.xml`.
  - Best first step because it is free and broad.
- HealthFit export
  - Can export workouts in cleaner formats such as CSV, FIT, GPX, Google Sheets, and Markdown.
  - Better for workout-specific files if Apple XML is too noisy.
- Native HealthKit companion app
  - Long-term option.
  - Would require building an iOS app that asks for HealthKit permissions and syncs selected data to the local dashboard.

Proposed model:

- `workouts`
  - start time
  - end time
  - workout type
  - duration
  - active calories
  - total calories
  - distance
  - source app/device
  - notes
- `heart_rate_samples`
  - timestamp
  - bpm
  - source
  - workout id if linked
- `daily_activity`
  - date
  - steps
  - exercise minutes
  - active energy
  - resting heart rate
  - HRV
  - VO2 max/cardio fitness if available
- `workout_summaries`
  - workout id
  - average heart rate
  - max heart rate
  - heart rate zone minutes if available or derivable
  - glucose before workout
  - glucose after workout
  - basal change after workout
  - lows after workout

Planned metrics:

- Workout count and minutes per day.
- Active calories per day.
- Avg and max heart rate during workouts.
- Time in heart rate zones.
- Glucose change during and after workouts.
- Extra basal or reduced basal after workouts.
- Lows within 2, 4, and 8 hours after workouts.
- Meal recovery on exercise days vs non-exercise days.
- Overnight glucose stability after workout days.
- Workout effect by type, duration, and intensity.

Potential views:

- Exercise overlay on Day Detail glucose chart.
- Workout table for selected day.
- Basal deviation before/during/after workouts.
- Glucose response by workout type.
- Exercise vs non-exercise summary comparison.
- Late-low risk report after workouts.

Open decisions:

- Start with Apple Health XML import or HealthFit export import?
- Which telemetry should be imported first: workouts only, or workouts plus heart rate samples?
- Should heart rate samples be stored at full resolution, downsampled, or both?
- How should workout intensity zones be calculated?
- Should exercise be treated as its own event layer, similar to meals?
- Should summary periods separate exercise days from rest days?

## Near-Term Next Steps

1. Decide whether to build the nutrition module around manual entry first or public lookup first.
2. Define the first version of the `foods` and `meal_entries` schema.
3. Add a trusted foods table and manual food entry UI.
4. Add meal logging UI with serving multipliers.
5. Add macro totals to meal window analysis.
6. Add CSV import/export for trusted foods and meal logs.
7. Decide whether Apple Health import should begin with native XML export or HealthFit workout export.

## Working Assumptions

- Tidepool remains the source of truth for CGM, insulin, basal, and bolus data.
- The local app should keep working offline once data is imported.
- Public nutrition data is treated as unverified until reviewed.
- Apple Health/Fitness data should be imported explicitly by the user unless we later build a companion iOS app.
- The dashboard should favor clear, inspectable metrics over opaque scoring.
- Custom scores should always include definitions in the UI.
