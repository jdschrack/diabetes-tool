export type DailyRange = {
  day: string;
  readings: number;
  avg_glucose: number;
  min_glucose: number;
  max_glucose: number;
  stddev_glucose: number;
  cv_pct: number;
  in_range_pct: number;
  very_low_pct: number;
  low_pct: number;
  high_pct: number;
  very_high_pct: number;
};

export type BasalDaily = {
  day: string;
  delivered_units: number;
  scheduled_units: number;
  net_deviation_units: number;
  extra_basal_units: number;
  reduced_basal_units: number;
};

export type BasalHourly = {
  hour: string;
  day: string;
  hour_of_day: number;
  delivered_units: number;
  scheduled_units: number;
  net_deviation_units: number;
  extra_basal_units: number;
  reduced_basal_units: number;
  observed_minutes: number;
};

export type DailyInsulin = {
  day: string;
  basal_units: number;
  bolus_units: number;
  total_units: number;
};

export type DailyFood = {
  day: string;
  meals: number;
  carbs: number;
};

export type PeriodSummary = {
  label: string;
  days_requested: number;
  days_available: number;
  start: string;
  end: string;
  avg_glucose: number;
  time_in_range_pct: number;
  delivered_basal_units: number;
  scheduled_basal_units: number;
  extra_basal_units: number;
  extra_basal_per_day: number;
  correction_load_pct_tdi: number | null;
  bolus_per_carb: number;
};

export type MealSummary = {
  meal: string;
  meals: number;
  carbs_per_bolus: number | null;
  pre_bg: number | null;
  peak_4h: number | null;
  pct_high_4h: number | null;
  recovery_minutes_4h: number | null;
  area_over_180_4h: number | null;
  extra_basal_4h: number | null;
  net_basal_4h: number | null;
  correction_efficiency: number | null;
  observed_sensitivity: number | null;
  low_after_correction_pct: number | null;
  burden_score: number | null;
  burden_variability: number | null;
};

export type MealEvent = {
  date: string;
  start: string;
  meal: string;
  carbs: number;
  bolus: number;
  pre_bg: number | null;
  peak_4h: number | null;
  pct_high_4h: number | null;
  minutes_over_250_4h: number | null;
  sustained_over_250_2h: boolean;
  review_carbs_per_unit: number | null;
  estimated_missing_carbs: number | null;
  recovery_minutes_4h: number | null;
  area_over_180_4h: number | null;
  crossed_high_4h: boolean;
  low_after_correction: boolean | null;
  extra_basal_4h: number;
  net_basal_4h: number;
  correction_efficiency: number | null;
  observed_sensitivity: number | null;
  burden_score: number | null;
};

export type GlucosePoint = {
  day: string;
  local_time: string;
  value: number;
};

export type DailyEvent = {
  id: string;
  day: string;
  local_time: string;
  kind: "exercise" | "note";
  label: string;
  detail: string | null;
  duration_minutes: number | null;
};

export type CronometerNutritionRow = {
  date: string;
  group: string;
  energy_kcal: number | null;
  net_carbs_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugars_g: number | null;
  added_sugars_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  protein_g: number | null;
  sodium_mg: number | null;
  water_g: number | null;
  completed: boolean | null;
  row_hash: string | null;
  source_file: string | null;
  imported_at: string | null;
  carb_calories: number;
  fat_calories: number;
  protein_calories: number;
  macro_calories: number;
  carb_calorie_pct: number | null;
  fat_calorie_pct: number | null;
  protein_calorie_pct: number | null;
};

export type DashboardData = {
  generated_from: { db: string; log: string; cronometer?: string };
  tidepool: {
    daily_ranges: DailyRange[];
    basal_deviation: {
      daily: BasalDaily[];
      hourly: BasalHourly[];
    };
    daily_insulin: DailyInsulin[];
    daily_food: DailyFood[];
    glucose_points: GlucosePoint[];
    daily_events: DailyEvent[];
    totals: { readings: number };
  };
  log: {
    daily: Array<{
      date: string;
      carbs: number | null;
      total: number | null;
      basal: number | null;
      bolus: number | null;
      avg_bg: number | null;
      basal_pct: number | null;
      bolus_pct: number | null;
      bolus_per_carb: number | null;
      carbs_per_bolus: number | null;
    }>;
    baseline: Array<{
      metric: string;
      ilet_30_day: string;
      twiist_avg: string;
      change: string;
    }>;
  };
  cronometer: {
    daily: CronometerNutritionRow[];
    groups: CronometerNutritionRow[];
    totals: {
      rows: number;
      days: number;
      latest_day: string | null;
    };
  };
  period_summaries: PeriodSummary[];
  meal_analysis: {
    all: MealSummary[];
    periods: Record<string, MealSummary[]>;
    events: MealEvent[];
  };
};

export type ImportStep = {
  key: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  message: string;
};

export type ImportJob = {
  id: string;
  filename: string;
  source?: string;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  message: string;
  steps: ImportStep[];
  stdout: string;
  stderr: string;
  summary: {
    days: number;
    readings: number;
    latest_day: string | null;
    imported?: number;
    duplicates?: number;
    total_rows?: number;
  } | null;
};
