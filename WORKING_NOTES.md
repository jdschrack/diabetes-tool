# Working Notes

Last updated: 2026-06-24

## Current App State

- Local Dockerized Tidepool/Twiist dashboard is running at `http://localhost:8000`.
- Backend imports Tidepool JSON into SQLite and rebuilds dashboard data.
- Tidepool import supports append/de-duplication through record hashes.
- Frontend is a Vite/React/ECharts app served by FastAPI.
- Main tabs:
  - Summary
  - Day Detail
  - Journal

## Recent Dashboard Additions

- Summary periods: 1 week, 2 weeks, 1 month, 3 months, 6 months.
- Meal Window Analysis now includes approximate grouping windows:
  - Breakfast: 5:00a-10:30a
  - Lunch: 10:30a-3:30p
  - Dinner: 3:30p-10:30p
  - Overnight/Other: 10:30p-5:00a
- Day Detail has:
  - selected-day glucose trend
  - selected-day basal rate profile
  - delivered basal vs programmed basal
  - delivered-minus-programmed delta
  - selected-day meal impact table
- Journal tab has:
  - period-aware averages
  - iLet 30-day baseline vs Twiist comparison
  - visual increase/decrease indicators
- Bottom of app includes definitions for custom metrics.

## Custom Metrics Added

- Extra Basal: delivered basal above programmed basal.
- Net Basal: delivered basal minus programmed basal.
- Correction Load: extra basal as percent of estimated total insulin.
- Area >180: glucose exposure above 180 mg/dL during meal window.
- Avg Recovery: time from meal start until CGM returns to 70-180 after first crossing above 180.
- Correction Efficiency: extra basal units per 100 mg/dL-hours above 180.
- Low Risk: meal windows that went high and later dropped below 70.
- Meal Burden: area over 180 + recovery minutes / 10 + extra basal units * 20.
- Burden Variability: standard deviation of burden score.
- Observed ISF: observed post-peak glucose drop per unit of extra basal correction. This is a proxy, not configured pump ISF.

## Important Interpretation Notes

- `Carbs/U` in Meal Window Analysis is observed from matched meal boluses, not a configured pump setting.
- Extra basal is being used as the main proxy for pump-driven correction.
- Meal metrics are for pattern finding and therapy-team discussion, not direct dosing decisions.
- The user wants to monitor grouped meal windows over multiple weeks to make better therapy-team recommendations.

## Roadmap Items Captured

See `ROADMAP.md` for:

- local nutrition module
- trusted foods table
- manual meal logger
- public nutrition dataset strategy
- Apple Health / Apple Watch import
- workout and heart-rate telemetry
- data quality/trust improvements
- live API vs generated data decisions

## Nutrition Direction

- Cronometer was tested but at least one name-brand bread entry was badly inaccurate.
- Current preferred direction is not to trust app food databases blindly.
- Proposed approach:
  - public lookup as draft only
  - local trusted foods as source of truth
  - verified/unverified flag
  - manual correction and repeatable trusted entries
- Likely public sources:
  - USDA FoodData Central for generic/reference foods
  - Open Food Facts for barcode lookup

## Apple Health Direction

- Add Apple Health/Fitness import later.
- First likely implementation:
  - upload Apple Health export ZIP
  - parse `export.xml`
  - store workouts, heart rate samples, daily activity
- Alternative:
  - HealthFit export for cleaner workout files
- Long-term:
  - HealthKit companion app if ongoing sync becomes important

## Good Next Steps

1. Decide whether the next build should focus on nutrition logging or Apple Health import.
2. If nutrition first:
   - design SQLite tables for `foods`, `meal_entries`, and `meal_logs`
   - add manual trusted-food entry UI
   - add CSV import/export for trusted foods
3. If Apple Health first:
   - get a sample Apple Health export ZIP
   - build parser for workouts and heart-rate samples
   - overlay exercise blocks on Day Detail glucose chart
4. Consider adding a `Notes/Interventions` feature so therapy changes can be marked and compared before/after.

## Useful Verification Commands

```sh
python3 scripts/build_dashboard_data.py
npm run build --prefix app
docker compose build
docker compose up -d --force-recreate
curl -sS http://127.0.0.1:8000/api/health
```
