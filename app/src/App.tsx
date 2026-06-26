import type { EChartsOption } from "echarts";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { fetchDashboard, fetchImportJob, startCronometerImport, startTidepoolImport } from "./api/client";
import type { BasalHourly, DashboardData, DailyRange, ImportJob, MealSummary, PeriodSummary } from "./api/types";
import { EChart } from "./charts/EChart";
import { generateReportPdf } from "./reportPdf";

const format = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value) ? "--" : value.toFixed(digits).replace(/\.0$/, "");

type JournalRow = DashboardData["log"]["daily"][number];
type ActiveTab = "today" | "summary" | "journal" | "imports" | "help";

function parseRoute(): { tab: ActiveTab; period: string | null; day: string | null; start: string | null; end: string | null } {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  const tab: ActiveTab = path === "summary" || path === "journal" || path === "imports" || path === "help" ? path : "today";
  const params = new URLSearchParams(window.location.search);
  return {
    tab,
    period: params.get("period"),
    day: params.get("day"),
    start: params.get("start"),
    end: params.get("end")
  };
}

function routePath(tab: ActiveTab) {
  return `/${tab}`;
}

function periodDays(period: PeriodSummary | undefined, rows: DailyRange[]) {
  if (!period) return rows.map((row) => row.day);
  return rows.filter((row) => row.day >= period.start && row.day <= period.end).map((row) => row.day);
}

function formatLongDate(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function formatDateRange(start: string, end: string) {
  if (!start && !end) return "";
  if (start && end) return `${formatLongDate(start)} to ${formatLongDate(end)}`;
  return start ? `From ${formatLongDate(start)}` : `Through ${formatLongDate(end)}`;
}

function sumField(rows: JournalRow[], key: keyof JournalRow) {
  return rows.reduce((total, row) => total + (typeof row[key] === "number" ? row[key] : 0), 0);
}

function averageNumeric<T>(rows: T[], getter: (row: T) => number | null | undefined) {
  const values = rows.map(getter).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function avgField(rows: JournalRow[], key: keyof JournalRow) {
  const values = rows.map((row) => row[key]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function gmiFromAverageGlucose(avgGlucose: number | null) {
  return avgGlucose === null ? null : 3.31 + 0.02392 * avgGlucose;
}

function journalAverages(rows: JournalRow[]) {
  const carbs = sumField(rows, "carbs");
  const total = sumField(rows, "total");
  const basal = sumField(rows, "basal");
  const bolus = sumField(rows, "bolus");
  const avgBg = avgField(rows, "avg_bg");
  return {
    days: rows.length,
    carbs: rows.length ? carbs / rows.length : null,
    total: rows.length ? total / rows.length : null,
    basal: rows.length ? basal / rows.length : null,
    bolus: rows.length ? bolus / rows.length : null,
    avgBg,
    basalPct: total ? (100 * basal) / total : null,
    bolusPct: total ? (100 * bolus) / total : null,
    bolusPerCarb: carbs ? bolus / carbs : null,
    carbsPerBolus: bolus ? carbs / bolus : null,
    gmi: gmiFromAverageGlucose(avgBg)
  };
}

function minutesLabel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  const minutes = Math.round(value);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function yesNo(value: boolean | null | undefined) {
  if (value === null || value === undefined) return "--";
  return value ? "Yes" : "No";
}

const mealMeta: Record<string, { label: string; window: string; color: string; soft: string }> = {
  breakfast: { label: "Breakfast", window: "6:30a-10:30a", color: "#f59e0b", soft: "#fff7e6" },
  lunch: { label: "Lunch", window: "10:30a-3:30p", color: "#0e9f8f", soft: "#ecfdf7" },
  dinner: { label: "Dinner", window: "3:30p-8:00p", color: "#7c5ce7", soft: "#f3f0ff" },
  "overnight/other": { label: "Overnight", window: "8:00p-6:30a", color: "#2f80ed", soft: "#edf5ff" }
};

function mealLabel(meal: string) {
  return mealMeta[meal]?.label || meal;
}

function Sparkline({
  values,
  color,
  height = 34,
  label,
  unit = ""
}: {
  values: Array<number | null | undefined>;
  color: string;
  height?: number;
  label: string;
  unit?: string;
}) {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const width = 96;
  if (nums.length < 2) {
    return <span className="sparkline empty" title={`${label}: not enough data`} style={{ "--spark-color": color } as CSSProperties} />;
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const spread = max - min || 1;
  const coords = nums.map((value, index) => {
    const x = (index / (nums.length - 1)) * width;
    const y = height - ((value - min) / spread) * (height - 8) - 4;
    return { x, y, value };
  });
  const points = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const latest = coords[coords.length - 1];
  const title = `${label}. Latest ${format(latest.value, 1)}${unit}; range ${format(min, 1)}-${format(max, 1)}${unit}.`;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      <line x1="0" x2={width} y1={height - 4} y2={height - 4} stroke="#e8edf3" strokeWidth="1" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={latest.x} cy={latest.y} r="3.4" fill="#fff" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function deltaValue(current: number | null | undefined, previous: number | null | undefined) {
  if (typeof current !== "number" || typeof previous !== "number" || Number.isNaN(current) || Number.isNaN(previous)) return null;
  return current - previous;
}

function DeltaBadge({
  current,
  previous,
  digits = 0,
  suffix = "",
  lowerIsBetter = true,
  hideWhenMissing = false
}: {
  current: number | null | undefined;
  previous: number | null | undefined;
  digits?: number;
  suffix?: string;
  lowerIsBetter?: boolean;
  hideWhenMissing?: boolean;
}) {
  const delta = deltaValue(current, previous);
  if (delta === null) return hideWhenMissing ? null : <span className="metric-delta neutral">No prior</span>;
  const helpful = lowerIsBetter ? delta <= 0 : delta >= 0;
  const sign = delta > 0 ? "+" : "";
  return <span className={`metric-delta ${helpful ? "good" : "bad"}`}>{sign}{format(delta, digits)}{suffix}</span>;
}

function summarizeMealEvents(events: DashboardData["meal_analysis"]["events"]): MealSummary[] {
  return Object.keys(mealMeta).map((meal) => {
    const rows = events.filter((event) => event.meal === meal);
    return {
      meal,
      meals: rows.length,
      carbs_per_bolus: averageNumeric(rows, (row) => (row.bolus ? row.carbs / row.bolus : null)),
      pre_bg: averageNumeric(rows, (row) => row.pre_bg),
      peak_4h: averageNumeric(rows, (row) => row.peak_4h),
      pct_high_4h: averageNumeric(rows, (row) => row.pct_high_4h),
      recovery_minutes_4h: averageNumeric(rows, (row) => row.recovery_minutes_4h),
      area_over_180_4h: averageNumeric(rows, (row) => row.area_over_180_4h),
      extra_basal_4h: averageNumeric(rows, (row) => row.extra_basal_4h),
      net_basal_4h: averageNumeric(rows, (row) => row.net_basal_4h),
      correction_efficiency: averageNumeric(rows, (row) => row.correction_efficiency),
      observed_sensitivity: averageNumeric(rows, (row) => row.observed_sensitivity),
      low_after_correction_pct: rows.length ? (100 * rows.filter((row) => row.low_after_correction).length) / rows.length : null,
      burden_score: averageNumeric(rows, (row) => row.burden_score),
      burden_variability: null
    };
  });
}

function rangeOption(rows: DailyRange[]): EChartsOption {
  const days = rows.map((row) => row.day.slice(5));
  const buckets: Array<[string, keyof DailyRange, string, number[]]> = [
    ["Very Low", "very_low_pct", "#d64f4f", [0, 0, 0, 0]],
    ["Low", "low_pct", "#f28a74", [0, 0, 0, 0]],
    ["In Range", "in_range_pct", "#65c99a", [0, 0, 0, 0]],
    ["High", "high_pct", "#f59e0b", [0, 0, 0, 0]],
    ["Very High", "very_high_pct", "#d97706", [5, 5, 0, 0]]
  ];
  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "#dfe6ef",
      textStyle: { color: "#172033" },
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(47,128,237,0.06)" } }
    },
    legend: { top: 0, right: 12, icon: "roundRect", textStyle: { color: "#657186" } },
    grid: { left: 46, right: 18, top: 46, bottom: 34 },
    xAxis: {
      type: "category",
      data: days,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#dfe6ef" } },
      axisLabel: { color: "#657186" }
    },
    yAxis: {
      type: "value",
      max: 100,
      axisLabel: { formatter: "{value}%", color: "#657186" },
      splitLine: { lineStyle: { color: "#eef2f6" } }
    },
    series: buckets.map(([name, key, color, radius]) => ({
      name,
      type: "bar",
      stack: "range",
      data: rows.map((row) => row[key] as number),
      barWidth: "58%",
      itemStyle: { color, borderRadius: radius }
    }))
  };
}

function basalCorrectionOption(rows: DashboardData["tidepool"]["basal_deviation"]["daily"]): EChartsOption {
  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "#dfe6ef",
      textStyle: { color: "#172033" }
    },
    grid: { left: 50, right: 20, top: 28, bottom: 34 },
    xAxis: {
      type: "category",
      data: rows.map((row) => row.day.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#dfe6ef" } },
      axisLabel: { color: "#657186" }
    },
    yAxis: {
      type: "value",
      axisLabel: { formatter: "{value}U", color: "#657186" },
      splitLine: { lineStyle: { color: "#eef2f6" } }
    },
    series: [
      {
        name: "Trend",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        data: rows.map((row) => row.extra_basal_units),
        lineStyle: { color: "#7c5ce7", width: 2.5 },
        itemStyle: { color: "#7c5ce7" },
        z: 3
      },
      {
        name: "Extra Basal",
        type: "bar",
        data: rows.map((row) => row.extra_basal_units),
        barWidth: "52%",
        itemStyle: { color: "rgba(124,92,231,0.24)", borderRadius: [6, 6, 0, 0] }
      }
    ]
  };
}

function glucoseAverageOption(rows: DailyRange[]): EChartsOption {
  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "#dfe6ef",
      textStyle: { color: "#172033" }
    },
    grid: { left: 46, right: 20, top: 28, bottom: 34 },
    xAxis: {
      type: "category",
      data: rows.map((row) => row.day.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#dfe6ef" } },
      axisLabel: { color: "#657186" }
    },
    yAxis: {
      type: "value",
      min: 50,
      axisLabel: { color: "#657186" },
      splitLine: { lineStyle: { color: "#eef2f6" } }
    },
    series: [
      {
        name: "Avg CGM",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        data: rows.map((row) => row.avg_glucose),
        markArea: { itemStyle: { color: "rgba(101,201,154,0.14)" }, data: [[{ yAxis: 70 }, { yAxis: 180 }]] },
        markLine: {
          symbol: "none",
          lineStyle: { color: "#9aa7b8", type: "dashed", width: 1 },
          label: { color: "#657186" },
          data: [{ yAxis: 70 }, { yAxis: 180 }]
        },
        areaStyle: { color: "rgba(20,144,93,0.08)" },
        lineStyle: { color: "#14905d", width: 3 },
        itemStyle: { color: "#14905d", borderColor: "#fff", borderWidth: 2 }
      }
    ]
  };
}

function hourlyRateOption(hourly: BasalHourly[], days: string[]): EChartsOption {
  const daySet = new Set(days);
  const byHour = Array.from({ length: 24 }, (_unused, hour) => {
    const rows = hourly.filter((row) => daySet.has(row.day) && row.hour_of_day === hour && row.observed_minutes);
    const deliveredRates = rows.map((row) => row.delivered_units / (row.observed_minutes / 60));
    const configuredRates = rows.map((row) => row.scheduled_units / (row.observed_minutes / 60));
    const avg = deliveredRates.length ? deliveredRates.reduce((a, b) => a + b, 0) / deliveredRates.length : null;
    const configured = configuredRates.length ? configuredRates.reduce((a, b) => a + b, 0) / configuredRates.length : null;
    return {
      hour,
      avg,
      configured,
      min: deliveredRates.length ? Math.min(...deliveredRates) : null,
      max: deliveredRates.length ? Math.max(...deliveredRates) : null,
      delta: avg !== null && configured !== null ? avg - configured : null
    };
  });
  return {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: [
      { left: 48, right: 16, top: 44, height: 160 },
      { left: 48, right: 16, top: 250, height: 90 }
    ],
    xAxis: [
      { type: "category", data: byHour.map((row) => row.hour), gridIndex: 0 },
      { type: "category", data: byHour.map((row) => row.hour), gridIndex: 1 }
    ],
    yAxis: [
      { type: "value", name: "U/hr", gridIndex: 0 },
      { type: "value", name: "Delta", gridIndex: 1 }
    ],
    series: [
      {
        name: "Delivered range",
        type: "line",
        data: byHour.map((row) => row.max),
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(35,153,200,0.14)" },
        stack: "range",
        xAxisIndex: 0,
        yAxisIndex: 0
      },
      {
        name: "Avg delivered",
        type: "line",
        smooth: true,
        data: byHour.map((row) => row.avg),
        lineStyle: { color: "#2399c8", width: 4 },
        itemStyle: { color: "#2399c8" },
        xAxisIndex: 0,
        yAxisIndex: 0
      },
      {
        name: "Configured",
        type: "line",
        data: byHour.map((row) => row.configured),
        lineStyle: { color: "#1f2937", width: 3 },
        itemStyle: { color: "#1f2937" },
        xAxisIndex: 0,
        yAxisIndex: 0
      },
      {
        name: "Delivered - configured",
        type: "bar",
        data: byHour.map((row) =>
          row.delta === null
            ? null
            : { value: row.delta, itemStyle: { color: row.delta >= 0 ? "#2399c8" : "#d64f4f" } }
        ),
        xAxisIndex: 1,
        yAxisIndex: 1
      }
    ]
  };
}

function dayGlucoseOption(
  data: DashboardData,
  day: string,
  meals: DashboardData["meal_analysis"]["events"],
  events: DashboardData["tidepool"]["daily_events"]
): EChartsOption {
  const rows = data.tidepool.glucose_points.filter((row) => row.day === day);
  const nearestGlucose = (time: string, fallback: number | null | undefined = 90) => {
    const eventTime = new Date(time).getTime();
    const nearest = rows.reduce(
      (best, row) => {
        const diff = Math.abs(new Date(row.local_time).getTime() - eventTime);
        return !best || diff < best.diff ? { diff, value: row.value } : best;
      },
      null as { diff: number; value: number } | null
    );
    return nearest?.value ?? fallback ?? 90;
  };
  const mealMarkers = meals.map((meal) => {
    return {
      value: [meal.start, nearestGlucose(meal.start, meal.pre_bg), meal.carbs, meal.meal],
      itemStyle: { color: "#1f4f8f" }
    };
  });
  const eventMarkers = events.map((event) => ({
    value: [event.local_time, nearestGlucose(event.local_time), event.label, event.kind, event.detail],
    symbol: event.kind === "exercise" ? "triangle" : "diamond",
    itemStyle: { color: event.kind === "exercise" ? "#14905d" : "#f59e0b" }
  }));
  return {
    color: ["#14905d", "#1f4f8f", "#f59e0b"],
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "#dfe6ef",
      textStyle: { color: "#172033" },
      formatter: (params) => {
        const items = Array.isArray(params) ? params : [params];
        return items
          .map((item) => {
            const typed = item as unknown as { seriesName: string; value: [string, number, number?, string?] };
            if (typed.seriesName === "Carbs") {
              return `Carbs: ${format(typed.value[2], 0)}g (${typed.value[3]})`;
            }
            if (typed.seriesName === "Events") {
              const event = item as unknown as { value: [string, number, string, string, string | null] };
              return `${event.value[2]}: ${event.value[4] || event.value[3]}`;
            }
            return `CGM: ${format(typed.value[1], 0)} mg/dL`;
          })
          .join("<br/>");
      }
    },
    grid: { left: 48, right: 22, top: 18, bottom: 34 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "#dfe6ef" } },
      axisTick: { show: false },
      axisLabel: { color: "#657186" },
      splitLine: { show: false }
    },
    yAxis: {
      type: "value",
      min: 40,
      axisLabel: { color: "#657186" },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: "#eef2f6" } }
    },
    visualMap: {
      show: false,
      seriesIndex: 0,
      dimension: 1,
      pieces: [
        { lt: 70, color: "#d64f4f" },
        { gt: 180, color: "#f59e0b" },
        { gte: 70, lte: 180, color: "#278f68" }
      ]
    },
    series: [
      {
        name: "CGM",
        type: "line",
        smooth: true,
        data: rows.map((row) => [row.local_time, row.value]),
        markArea: { itemStyle: { color: "rgba(101,201,154,0.18)" }, data: [[{ yAxis: 70 }, { yAxis: 180 }]] },
        markLine: {
          symbol: "none",
          lineStyle: { color: "#9aa7b8", type: "dashed", width: 1 },
          label: { color: "#657186" },
          data: [{ yAxis: 70 }, { yAxis: 180 }, { yAxis: 250 }]
        },
        lineStyle: { width: 3.2, cap: "round", join: "round" },
        showSymbol: false
      },
      {
        name: "Carbs",
        type: "scatter",
        data: mealMarkers,
        z: 10,
        zlevel: 1,
        symbol: "circle",
        symbolSize: 38,
        label: {
          show: true,
          position: "inside",
          color: "#fff",
          fontWeight: 800,
          fontSize: 11,
          formatter: (params) => `${format((params as unknown as { value: [string, number, number] }).value[2], 0)}g`
        },
        tooltip: { trigger: "item" }
      },
      {
        name: "Events",
        type: "scatter",
        data: eventMarkers,
        z: 12,
        symbolSize: 18,
        label: {
          show: true,
          position: "top",
          color: "#172033",
          fontWeight: 800,
          fontSize: 11,
          formatter: (params) => (params as unknown as { value: [string, number, string] }).value[2]
        },
        tooltip: { trigger: "item" }
      }
    ]
  };
}

function mealRecoveryOption(data: DashboardData, day: string, meals: DashboardData["meal_analysis"]["events"]): EChartsOption {
  const points = data.tidepool.glucose_points
    .filter((row) => row.day === day)
    .map((row) => ({ time: new Date(row.local_time).getTime(), value: row.value }));
  const buckets = Array.from({ length: 17 }, (_unused, index) => index * 15);
  const series = Object.entries(mealMeta).map(([meal, meta]) => {
    const mealEvents = meals.filter((event) => event.meal === meal);
    const values = buckets.map((minute) => {
      const samples = mealEvents.flatMap((event) => {
        const target = new Date(event.start).getTime() + minute * 60 * 1000;
        const nearest = points.reduce(
          (best, point) => {
            const diff = Math.abs(point.time - target);
            return !best || diff < best.diff ? { diff, value: point.value } : best;
          },
          null as { diff: number; value: number } | null
        );
        return nearest && nearest.diff <= 12 * 60 * 1000 ? [nearest.value] : [];
      });
      return samples.length ? samples.reduce((total, value) => total + value, 0) / samples.length : null;
    });
    return {
      name: meta.label,
      type: "line" as const,
      smooth: true,
      showSymbol: false,
      data: values,
      lineStyle: { color: meta.color, width: 3 },
      itemStyle: { color: meta.color }
    };
  });
  return {
    tooltip: { trigger: "axis", backgroundColor: "rgba(255,255,255,0.96)", borderColor: "#dfe6ef" },
    legend: { top: 0, right: 12, icon: "circle", textStyle: { color: "#657186" } },
    grid: { left: 46, right: 18, top: 42, bottom: 34 },
    xAxis: {
      type: "category",
      data: buckets.map((minute) => (minute === 0 ? "Meal" : `${minute / 60}h`)),
      axisLine: { lineStyle: { color: "#dfe6ef" } },
      axisTick: { show: false },
      axisLabel: { color: "#657186" }
    },
    yAxis: {
      type: "value",
      min: 50,
      axisLabel: { color: "#657186" },
      splitLine: { lineStyle: { color: "#eef2f6" } }
    },
    series: [
      {
        name: "Above range",
        type: "line" as const,
        data: buckets.map(() => 180),
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(245,158,11,0.12)", origin: "end" },
        silent: true
      },
      ...series
    ]
  };
}

function dayRangeOption(row: DailyRange | undefined): EChartsOption {
  const buckets: Array<[string, number, string]> = [
    ["Very Low", row?.very_low_pct ?? 0, "#d64f4f"],
    ["Low", row?.low_pct ?? 0, "#f28a74"],
    ["In Range", row?.in_range_pct ?? 0, "#65c99a"],
    ["High", row?.high_pct ?? 0, "#f59e0b"],
    ["Very High", row?.very_high_pct ?? 0, "#d97706"]
  ];
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 84, right: 24, top: 18, bottom: 24 },
    xAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" } },
    yAxis: { type: "category", data: buckets.map(([name]) => name).reverse() },
    series: [
      {
        type: "bar",
        data: buckets.map(([_name, value, color]) => ({ value, itemStyle: { color } })).reverse(),
        label: { show: true, formatter: "{c}%" }
      }
    ]
  };
}

function macroPieOption(row: DashboardData["cronometer"]["daily"][number] | undefined): EChartsOption {
  const totalCalories = row?.energy_kcal || row?.macro_calories || 0;
  const items = [
    { name: "Carbs", grams: row?.carbs_g, calories: row?.carb_calories || 0, color: "#f59e0b" },
    { name: "Fat", grams: row?.fat_g, calories: row?.fat_calories || 0, color: "#7c5ce7" },
    { name: "Protein", grams: row?.protein_g, calories: row?.protein_calories || 0, color: "#14905d" }
  ];
  return {
    color: items.map((item) => item.color),
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const typed = params as { name: string; value: number };
        const item = items.find((entry) => entry.name === typed.name);
        const percent = totalCalories ? (100 * Number(typed.value || 0)) / totalCalories : 0;
        return `${typed.name}: ${format(percent, 0)}% · ${format(item?.grams, 1)}g · ${format(Number(typed.value), 0)} kcal`;
      }
    },
    graphic: [
      {
        type: "text",
        left: "center",
        top: "45%",
        style: {
          text: format(totalCalories, 0),
          fill: "#172033",
          fontSize: 24,
          fontWeight: 800,
          align: "center"
        }
      },
      {
        type: "text",
        left: "center",
        top: "56%",
        style: {
          text: "kcal",
          fill: "#657186",
          fontSize: 11,
          fontWeight: 700,
          align: "center"
        }
      }
    ],
    series: [
      {
        name: "Macro calories",
        type: "pie",
        radius: ["56%", "82%"],
        center: ["50%", "50%"],
        minAngle: 3,
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        data: items.map((item) => ({
          name: item.name,
          value: item.calories,
          itemStyle: { color: item.color }
        }))
      }
    ]
  };
}

function macroSummaryOption(rows: DashboardData["cronometer"]["daily"]): EChartsOption {
  const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "#dfe6ef",
      textStyle: { color: "#172033" }
    },
    legend: { top: 0, right: 12, icon: "roundRect", textStyle: { color: "#657186" } },
    grid: { left: 52, right: 24, top: 42, bottom: 36 },
    xAxis: {
      type: "category",
      data: sorted.map((row) => row.date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#dfe6ef" } },
      axisLabel: { color: "#657186" }
    },
    yAxis: {
      type: "value",
      axisLabel: { formatter: "{value}", color: "#657186" },
      splitLine: { lineStyle: { color: "#eef2f6" } }
    },
    series: [
      {
        name: "Carbs kcal",
        type: "bar",
        stack: "macro",
        data: sorted.map((row) => row.carb_calories),
        itemStyle: { color: "#f59e0b" }
      },
      {
        name: "Fat kcal",
        type: "bar",
        stack: "macro",
        data: sorted.map((row) => row.fat_calories),
        itemStyle: { color: "#7c5ce7" }
      },
      {
        name: "Protein kcal",
        type: "bar",
        stack: "macro",
        data: sorted.map((row) => row.protein_calories),
        itemStyle: { color: "#14905d" }
      },
      {
        name: "Total kcal",
        type: "line",
        smooth: true,
        data: sorted.map((row) => row.energy_kcal),
        lineStyle: { color: "#1f4f8f", width: 2.5 },
        itemStyle: { color: "#1f4f8f" }
      }
    ]
  };
}

function insulinCarbOption(insulin: DashboardData["tidepool"]["daily_insulin"][number] | undefined, food: DashboardData["tidepool"]["daily_food"][number] | undefined): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 70, right: 24, top: 18, bottom: 24 },
    xAxis: { type: "value" },
    yAxis: { type: "category", data: ["Carbs", "Bolus", "Basal"].reverse() },
    series: [
      {
        type: "bar",
        data: [
          { value: food?.carbs ?? 0, itemStyle: { color: "#e7b759" } },
          { value: insulin?.bolus_units ?? 0, itemStyle: { color: "#67c3df" } },
          { value: insulin?.basal_units ?? 0, itemStyle: { color: "#2399c8" } }
        ].reverse(),
        label: { show: true, formatter: "{c}" }
      }
    ]
  };
}

function hourlyDeviationHeatmapOption(rows: BasalHourly[], day: string): EChartsOption {
  const selected = rows.filter((row) => row.day === day);
  const byHour = new Map(selected.map((row) => [row.hour_of_day, row]));
  const values: Array<[number, number, number]> = Array.from({ length: 24 }, (_unused, hour) => {
    const row = byHour.get(hour);
    return [hour, 0, row?.net_deviation_units ?? 0];
  });
  const maxAbs = Math.max(1, ...values.map((row) => Math.abs(row[2] as number)));
  return {
    tooltip: {
      formatter: (params) => {
        const value = (params as unknown as { value: [number, number, number] }).value;
        return `${value[0]}:00<br/>Net: ${format(value[2], 2)}U`;
      }
    },
    grid: { left: 32, right: 24, top: 22, bottom: 38 },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_unused, hour) => hour) },
    yAxis: { type: "category", data: ["Net"] },
    visualMap: {
      min: -maxAbs,
      max: maxAbs,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: ["#d64f4f", "#f3f5f8", "#2399c8"] }
    },
    series: [
      {
        type: "heatmap",
        data: values,
        label: {
          show: true,
          formatter: (p) => format((p as unknown as { value: [number, number, number] }).value[2], 1)
        }
      }
    ]
  };
}

function dayBasalRateOption(rows: BasalHourly[], day: string): EChartsOption {
  const selected = rows.filter((row) => row.day === day && row.observed_minutes);
  const byHour = new Map(selected.map((row) => [row.hour_of_day, row]));
  const hourly = Array.from({ length: 24 }, (_unused, hour) => {
    const row = byHour.get(hour);
    const observedHours = row ? row.observed_minutes / 60 : null;
    return {
      hour,
      delivered: row && observedHours ? row.delivered_units / observedHours : null,
      programmed: row && observedHours ? row.scheduled_units / observedHours : null,
      delta: row && observedHours ? (row.delivered_units - row.scheduled_units) / observedHours : null
    };
  });
  return {
    tooltip: { trigger: "axis", backgroundColor: "rgba(255,255,255,0.96)", borderColor: "#dfe6ef" },
    legend: { top: 0, right: 12, icon: "roundRect", textStyle: { color: "#657186" } },
    grid: [
      { left: 48, right: 18, top: 42, height: 170 },
      { left: 48, right: 18, top: 260, height: 88 }
    ],
    xAxis: [
      {
        type: "category",
        data: hourly.map((row) => row.hour),
        gridIndex: 0,
        axisLine: { lineStyle: { color: "#dfe6ef" } },
        axisTick: { show: false },
        axisLabel: { color: "#657186" },
        splitLine: { show: true, lineStyle: { color: "#f1f4f8" } }
      },
      {
        type: "category",
        data: hourly.map((row) => row.hour),
        gridIndex: 1,
        axisLine: { lineStyle: { color: "#dfe6ef" } },
        axisTick: { show: false },
        axisLabel: { color: "#657186" }
      }
    ],
    yAxis: [
      {
        type: "value",
        name: "U/hr",
        gridIndex: 0,
        axisLabel: { color: "#657186" },
        splitLine: { lineStyle: { color: "#eef2f6" } }
      },
      {
        type: "value",
        name: "Delta",
        gridIndex: 1,
        axisLabel: { color: "#657186" },
        splitLine: { lineStyle: { color: "#eef2f6" } }
      }
    ],
    series: [
      {
        name: "Delivered",
        type: "line",
        step: "middle",
        data: hourly.map((row) => row.delivered),
        areaStyle: { color: "rgba(35,153,200,0.13)" },
        lineStyle: { color: "#2f80ed", width: 3 },
        itemStyle: { color: "#2399c8" },
        xAxisIndex: 0,
        yAxisIndex: 0
      },
      {
        name: "Programmed",
        type: "line",
        step: "middle",
        data: hourly.map((row) => row.programmed),
        lineStyle: { color: "#172033", width: 3 },
        itemStyle: { color: "#1f2937" },
        xAxisIndex: 0,
        yAxisIndex: 0
      },
      {
        name: "Delivered - programmed",
        type: "bar",
        data: hourly.map((row) =>
          row.delta === null
            ? null
            : { value: row.delta, itemStyle: { color: row.delta >= 0 ? "#2399c8" : "#d64f4f" } }
        ),
        barWidth: "58%",
        xAxisIndex: 1,
        yAxisIndex: 1
      }
    ]
  };
}

function MealTable({ rows }: { rows: MealSummary[] }) {
  const windows: Record<string, string> = {
    breakfast: "6:30a-10:30a",
    lunch: "10:30a-3:30p",
    dinner: "3:30p-8:00p",
    "overnight/other": "8:00p-6:30a"
  };
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Meal</th>
            <th>Window</th>
            <th>Meals</th>
            <th>Carbs/U</th>
            <th>Pre BG</th>
            <th>4h Peak</th>
            <th>% &gt;180</th>
            <th>Avg Recovery</th>
            <th>Area &gt;180</th>
            <th>Extra Basal 4h</th>
            <th>Net Basal 4h</th>
            <th>Efficiency</th>
            <th>Observed ISF</th>
            <th>Low Risk</th>
            <th>Burden</th>
            <th>Variability</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.meal}>
              <td>{row.meal}</td>
              <td>{windows[row.meal] || "--"}</td>
              <td>{row.meals}</td>
              <td>{format(row.carbs_per_bolus, 1)}</td>
              <td>{format(row.pre_bg, 0)}</td>
              <td>{format(row.peak_4h, 0)}</td>
              <td>{format(row.pct_high_4h, 0)}%</td>
              <td>{minutesLabel(row.recovery_minutes_4h)}</td>
              <td>{format(row.area_over_180_4h, 1)}</td>
              <td>{format(row.extra_basal_4h, 2)}</td>
              <td>{format(row.net_basal_4h, 2)}</td>
              <td>{format(row.correction_efficiency, 2)}</td>
              <td>{format(row.observed_sensitivity, 1)}</td>
              <td>{format(row.low_after_correction_pct, 0)}%</td>
              <td>{format(row.burden_score, 1)}</td>
              <td>{format(row.burden_variability, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MealEventTable({ rows }: { rows: DashboardData["meal_analysis"]["events"] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Meal</th>
            <th>Carbs</th>
            <th>Bolus</th>
            <th>Carbs/U</th>
            <th>&gt;250 Time</th>
            <th>Review g/U</th>
            <th>Carb Gap</th>
            <th>Pre BG</th>
            <th>4h Peak</th>
            <th>% &gt;180</th>
            <th>Recovery</th>
            <th>Area &gt;180</th>
            <th>Extra Basal</th>
            <th>Net Basal</th>
            <th>Efficiency</th>
            <th>Observed ISF</th>
            <th>Low After High</th>
            <th>Burden</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.start}-${row.meal}`}>
              <td>{row.start.slice(11, 16)}</td>
              <td>{row.meal}</td>
              <td>{format(row.carbs, 0)}</td>
              <td>{format(row.bolus, 2)}</td>
              <td>{row.bolus ? format(row.carbs / row.bolus, 1) : "--"}</td>
              <td>{row.sustained_over_250_2h ? minutesLabel(row.minutes_over_250_4h) : "No"}</td>
              <td>{row.sustained_over_250_2h ? format(row.review_carbs_per_unit, 1) : "--"}</td>
              <td>{row.sustained_over_250_2h ? `${format(row.estimated_missing_carbs, 0)}g` : "--"}</td>
              <td>{format(row.pre_bg, 0)}</td>
              <td>{format(row.peak_4h, 0)}</td>
              <td>{format(row.pct_high_4h, 0)}%</td>
              <td>{minutesLabel(row.recovery_minutes_4h)}</td>
              <td>{format(row.area_over_180_4h, 1)}</td>
              <td>{format(row.extra_basal_4h, 2)}</td>
              <td>{format(row.net_basal_4h, 2)}</td>
              <td>{format(row.correction_efficiency, 2)}</td>
              <td>{format(row.observed_sensitivity, 1)}</td>
              <td>{yesNo(row.low_after_correction)}</td>
              <td>{format(row.burden_score, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JournalTable({ rows }: { rows: DashboardData["log"]["daily"] }) {
  return (
    <div className="table-scroll journal-table">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Carbs</th>
            <th>Total U</th>
            <th>Basal U</th>
            <th>Bolus U</th>
            <th>Avg BG</th>
            <th>Basal %</th>
            <th>Bolus %</th>
            <th>Bolus/g</th>
            <th>Carbs/U</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date}>
              <td><strong>{row.date}</strong></td>
              <td>{format(row.carbs, 0)}</td>
              <td>{format(row.total, 1)}</td>
              <td>{format(row.basal, 1)}</td>
              <td>{format(row.bolus, 1)}</td>
              <td>{format(row.avg_bg, 0)}</td>
              <td>{format(row.basal_pct, 0)}%</td>
              <td>{format(row.bolus_pct, 0)}%</td>
              <td>{format(row.bolus_per_carb, 3)}</td>
              <td>{format(row.carbs_per_bolus, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CronometerTable({ rows }: { rows: DashboardData["cronometer"]["groups"] }) {
  const displayRows = rows.slice(0, 18);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Group</th>
            <th>Calories</th>
            <th>Net Carbs</th>
            <th>Carbs</th>
            <th>Fiber</th>
            <th>Protein</th>
            <th>Fat</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row) => (
            <tr key={`${row.date}-${row.group}-${row.row_hash}`}>
              <td><strong>{row.date}</strong></td>
              <td>{foodGroupLabel(row.group)}</td>
              <td>{format(row.energy_kcal, 0)}</td>
              <td>{format(row.net_carbs_g, 1)}g</td>
              <td>{format(row.carbs_g, 1)}g</td>
              <td>{format(row.fiber_g, 1)}g</td>
              <td>{format(row.protein_g, 1)}g</td>
              <td>{format(row.fat_g, 1)}g</td>
              <td>{row.completed === null ? "--" : row.completed ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function foodGroupLabel(group: string) {
  return group.toLowerCase() === "uncategorized" ? "Snacks" : group;
}

function foodGroupMeta(group: string) {
  const label = foodGroupLabel(group).toLowerCase();
  if (label.includes("breakfast")) return { color: "#14905d", soft: "rgba(20,144,93,0.08)" };
  if (label.includes("lunch")) return { color: "#2f80ed", soft: "rgba(47,128,237,0.08)" };
  if (label.includes("dinner")) return { color: "#f59e0b", soft: "rgba(245,158,11,0.1)" };
  if (label.includes("snack")) return { color: "#7c5ce7", soft: "rgba(124,92,231,0.08)" };
  return { color: "#1f4f8f", soft: "rgba(31,79,143,0.07)" };
}

const foodGroupSlots = ["Breakfast", "Lunch", "Dinner", "Snacks"];

function zeroFoodGroupRow(group: string): DashboardData["cronometer"]["groups"][number] {
  return {
    date: "",
    group,
    energy_kcal: 0,
    net_carbs_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sugars_g: 0,
    added_sugars_g: 0,
    fat_g: 0,
    saturated_fat_g: 0,
    protein_g: 0,
    sodium_mg: 0,
    water_g: 0,
    completed: null,
    row_hash: `empty-${group}`,
    source_file: null,
    imported_at: null,
    carb_calories: 0,
    fat_calories: 0,
    protein_calories: 0,
    macro_calories: 0,
    carb_calorie_pct: null,
    fat_calorie_pct: null,
    protein_calorie_pct: null
  };
}

function foodRowsBySlot(rows: DashboardData["cronometer"]["groups"]) {
  return foodGroupSlots.map((slot) => {
    const match = rows.find((row) => foodGroupLabel(row.group).toLowerCase() === slot.toLowerCase());
    return match || zeroFoodGroupRow(slot);
  });
}

function macroItems(row: DashboardData["cronometer"]["daily"][number]) {
  const totalCalories = row.energy_kcal || row.macro_calories || 0;
  return [
    { name: "Carbs", grams: row.carbs_g, calories: row.carb_calories, color: "#f59e0b" },
    { name: "Fat", grams: row.fat_g, calories: row.fat_calories, color: "#7c5ce7" },
    { name: "Protein", grams: row.protein_g, calories: row.protein_calories, color: "#14905d" }
  ].map((item) => ({
    ...item,
    percent: totalCalories ? (100 * item.calories) / totalCalories : 0
  }));
}

function MacroBreakdown({ row }: { row: DashboardData["cronometer"]["daily"][number] }) {
  return (
    <div className="macro-breakdown" aria-label="Macronutrient calorie breakdown">
      {macroItems(row).map((item) => (
        <div className="macro-row" key={item.name}>
          <div className="macro-row-head">
            <span><i style={{ background: item.color }} />{item.name}</span>
            <strong>{format(item.percent, 0)}%</strong>
          </div>
          <div className="macro-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(100, item.percent))}%`, background: item.color }} />
          </div>
          <p>{format(item.grams, 1)}g · {format(item.calories, 0)} kcal</p>
        </div>
      ))}
    </div>
  );
}

function MacroSplitBar({ row }: { row: DashboardData["cronometer"]["groups"][number] }) {
  const items = macroItems(row);
  return (
    <span className="food-macro-bar" aria-hidden="true">
      {items.map((item) => (
        <i key={item.name} style={{ width: `${Math.max(0, Math.min(100, item.percent))}%`, background: item.color }} />
      ))}
    </span>
  );
}

function FoodLogMacroCards({ rows }: { rows: DashboardData["cronometer"]["groups"] }) {
  const displayRows = foodRowsBySlot(rows);
  return (
    <div className="macro-food-log">
      <div className="macro-subheading">
        <strong>Food log detail</strong>
      </div>
      <div className="food-log-card-grid">
        {displayRows.map((row) => {
          const meta = foodGroupMeta(row.group);
          const items = macroItems(row);
          const hasData = (row.energy_kcal || 0) > 0 || (row.carbs_g || 0) > 0 || (row.fat_g || 0) > 0 || (row.protein_g || 0) > 0;
          return (
            <section className="food-log-card" style={{ "--meal-color": meta.color, "--meal-soft": meta.soft } as CSSProperties} key={`${row.date}-${row.group}-${row.row_hash}`}>
              <header>
                <div>
                  <h3>{foodGroupLabel(row.group)}</h3>
                  <small>{hasData ? `${format(row.energy_kcal, 0)} kcal · ${row.completed === null ? "completion unknown" : row.completed ? "completed" : "in progress"}` : "0 kcal · no data"}</small>
                </div>
                <i className="meal-dot" />
              </header>
              <dl>
                {items.map((item) => (
                  <div key={item.name}>
                    <dt>{item.name}</dt>
                    <dd>{format(item.grams, 1)}g · {format(item.calories, 0)} kcal</dd>
                  </div>
                ))}
                <div>
                  <dt>Macro split</dt>
                  <dd>{items.map((item) => format(item.percent, 0)).join(" / ")}%</dd>
                  <MacroSplitBar row={row} />
                </div>
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function MacroCaloriesPanel({
  title,
  subtitle,
  row,
  groupRows = [],
  trendRows = [],
  emptyMessage,
  mode
}: {
  title: string;
  subtitle: string;
  row: DashboardData["cronometer"]["daily"][number] | undefined;
  groupRows?: DashboardData["cronometer"]["groups"];
  trendRows?: DashboardData["cronometer"]["daily"];
  emptyMessage: string;
  mode: "day" | "summary";
}) {
  const completedRows = groupRows.filter((item) => item.completed).length;
  return (
    <article className="panel full chart-panel macro-panel">
      <div className="section-heading macro-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {row ? (
        <div className="macro-layout">
          <section className="macro-hero" aria-label="Macro calorie overview">
            <div className="macro-donut">
              <EChart option={macroPieOption(row)} height={260} />
            </div>
            <div className="macro-total">
              <span>Total intake</span>
              <strong>{format(row.energy_kcal, 0)}<small> kcal</small></strong>
              <p>{format(row.net_carbs_g, 1)}g net carbs · {format(row.fiber_g, 1)}g fiber</p>
            </div>
            <div className="macro-kpis">
              <span><strong>{format(row.sodium_mg, 0)}</strong>Sodium mg</span>
              <span><strong>{format(row.water_g, 0)}</strong>Water g</span>
              <span><strong>{mode === "day" ? groupRows.length : trendRows.length}</strong>{mode === "day" ? "Food rows" : "Days"}</span>
              {mode === "day" && <span><strong>{completedRows}</strong>Completed</span>}
            </div>
          </section>
          {mode === "day" ? (
            <section className="macro-day-detail" aria-label="Daily food detail">
              <MacroBreakdown row={row} />
              <FoodLogMacroCards rows={groupRows} />
            </section>
          ) : (
            <section className="macro-support" aria-label="Summary macro trend">
              <MacroBreakdown row={row} />
              <div className="macro-trend">
                <div className="macro-subheading">
                  <strong>Daily calorie trend</strong>
                  <span>{trendRows.length} imported days</span>
                </div>
                <EChart option={macroSummaryOption(trendRows)} height={260} />
              </div>
            </section>
          )}
        </div>
      ) : (
        <p>{emptyMessage}</p>
      )}
    </article>
  );
}

function parseBaselineValue(value: string) {
  const parsed = Number(value.replace("%", "").replace(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function twiistMetricValue(metric: string, averages: ReturnType<typeof journalAverages>) {
  if (metric.startsWith("Total daily insulin")) return averages.total;
  if (metric.startsWith("Basal (u)")) return averages.basal;
  if (metric.startsWith("Bolus (u)")) return averages.bolus;
  if (metric.startsWith("Avg glucose")) return averages.avgBg;
  if (metric.startsWith("Basal %")) return averages.basalPct;
  if (metric.startsWith("GMI")) return averages.gmi;
  return null;
}

function formatComparisonMetric(metric: string, value: number | null) {
  if (value === null) return "--";
  if (metric.startsWith("Avg glucose")) return format(value, 0);
  if (metric.startsWith("Basal %") || metric.startsWith("GMI")) return `${format(value, metric.startsWith("GMI") ? 2 : 0)}%`;
  return format(value, 1);
}

function BaselineComparisonTable({
  rows,
  averages
}: {
  rows: DashboardData["log"]["baseline"];
  averages: ReturnType<typeof journalAverages>;
}) {
  return (
    <div className="baseline-grid">
      {rows.map((row) => {
        const iletValue = parseBaselineValue(row.ilet_30_day);
        const twiistValue = twiistMetricValue(row.metric, averages);
        const change = iletValue && twiistValue !== null ? ((twiistValue - iletValue) / iletValue) * 100 : null;
        const direction = change === null ? "flat" : change > 0 ? "increase" : change < 0 ? "decrease" : "flat";
        const max = Math.max(Math.abs(iletValue || 0), Math.abs(twiistValue || 0), 1);
        return (
          <section className="baseline-card" key={row.metric}>
            <div className="baseline-card-header">
              <strong>{row.metric}</strong>
              <span className={`trend ${direction}`} aria-label={direction}>
                {direction === "increase" ? "▲" : direction === "decrease" ? "▼" : "•"}
              </span>
            </div>
            <div className="baseline-bars">
              <div>
                <span>iLet 30-day</span>
                <strong>{row.ilet_30_day}</strong>
                <i style={{ width: `${Math.max(6, ((iletValue || 0) / max) * 100)}%` }} />
              </div>
              <div>
                <span>Twiist avg</span>
                <strong>{formatComparisonMetric(row.metric, twiistValue)}</strong>
                <i style={{ width: `${Math.max(6, ((twiistValue || 0) / max) * 100)}%` }} />
              </div>
            </div>
            <div className="baseline-change">
              <span>Change</span>
              <strong>{change === null ? "--" : `${format(change, 0)}%`}</strong>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function MetricDefinitions() {
  return (
    <section className="metric-definitions">
      <h2>Metric Definitions</h2>
      <div className="definition-grid">
        <div>
          <h3>Extra Basal</h3>
          <p>Delivered basal above the configured basal profile. This is used as a proxy for pump-driven correction insulin.</p>
        </div>
        <div>
          <h3>Net Basal</h3>
          <p>Delivered basal minus configured basal. Positive means the pump delivered more than scheduled; negative means it backed off.</p>
        </div>
        <div>
          <h3>Correction Load</h3>
          <p>Extra basal as a percentage of estimated total insulin for the period. Higher values mean more insulin came through automated basal correction.</p>
        </div>
        <div>
          <h3>Meal</h3>
          <p>Meal window label assigned from the event time, such as breakfast, lunch, dinner, or overnight/other.</p>
        </div>
        <div>
          <h3>Carbs</h3>
          <p>Announced carbohydrates in grams for that meal event.</p>
        </div>
        <div>
          <h3>Bolus</h3>
          <p>Bolus insulin associated with the meal event, measured in units.</p>
        </div>
        <div>
          <h3>Carbs/U</h3>
          <p>Announced carbs divided by associated bolus units. This is the observed event ratio, not necessarily the programmed pump ratio.</p>
        </div>
        <div>
          <h3>&gt;250 Time</h3>
          <p>Time spent above 250 mg/dL during the 4-hour post-meal window. The table only displays this duration when it stays above 250 for at least 2 hours.</p>
        </div>
        <div>
          <h3>Review g/U</h3>
          <p>Back-calculated carbs per unit to review when the meal has sustained glucose above 250. It estimates what ratio the event looked like based on announced carbs plus the carb gap.</p>
        </div>
        <div>
          <h3>Carb Gap</h3>
          <p>Estimated missing carbohydrates for sustained above-250 events. It is intended as a review signal for missed or undercounted carbs, not a dosing instruction.</p>
        </div>
        <div>
          <h3>Pre BG</h3>
          <p>Nearest CGM value before or at the meal start used as the pre-meal glucose reference.</p>
        </div>
        <div>
          <h3>4h Peak</h3>
          <p>Highest CGM value observed during the 4-hour window after the meal start.</p>
        </div>
        <div>
          <h3>% &gt;180</h3>
          <p>Percent of CGM readings above 180 mg/dL during the 4-hour post-meal window.</p>
        </div>
        <div>
          <h3>Area &gt;180</h3>
          <p>Estimated glucose exposure above 180 mg/dL during a meal window. It combines how high glucose went and how long it stayed elevated.</p>
        </div>
        <div>
          <h3>Avg Recovery</h3>
          <p>Time from meal start until CGM returns to 70-180 mg/dL after first crossing above 180. Meals that never cross above 180 do not count.</p>
        </div>
        <div>
          <h3>Correction Efficiency</h3>
          <p>Extra basal units per 100 mg/dL-hours above 180. This helps compare how much correction insulin was used relative to above-range exposure.</p>
        </div>
        <div>
          <h3>Observed ISF</h3>
          <p>Estimated post-peak glucose drop per unit of extra basal in a meal window. This is an observed proxy, not the configured pump sensitivity factor.</p>
        </div>
        <div>
          <h3>Low Risk</h3>
          <p>Percent of meal windows that went above 180 and later dropped below 70 within the extended post-meal window.</p>
        </div>
        <div>
          <h3>Low After High</h3>
          <p>Whether a selected-day meal window crossed above 180 and later dropped below 70 in the extended post-meal review window.</p>
        </div>
        <div>
          <h3>Meal Burden</h3>
          <p>Ranking score: area over 180 + recovery minutes / 10 + extra basal units * 20. Higher means more post-meal glucose and insulin cleanup.</p>
        </div>
        <div>
          <h3>Burden Variability</h3>
          <p>Standard deviation of meal burden within that meal group. Higher variability means the same meal period is less predictable.</p>
        </div>
      </div>
    </section>
  );
}

function ImportWorkflow({ job }: { job: ImportJob | null }) {
  if (!job) return null;
  return (
    <section className={`import-workflow ${job.status}`}>
      <div className="import-workflow-header">
        <div>
          <h2>Import Workflow</h2>
          <p>{job.filename} · {job.message}</p>
        </div>
        <strong>{job.status}</strong>
      </div>
      <ol className="import-steps">
        {job.steps.map((step) => (
          <li key={step.key} className={step.status}>
            <span className="step-indicator" />
            <div>
              <strong>{step.label}</strong>
              <p>{step.message || step.status}</p>
            </div>
          </li>
        ))}
      </ol>
      {job.summary && (
        <div className="import-summary">
          <span>{job.summary.days} days</span>
          {job.source === "cronometer" ? (
            <>
              <span>{job.summary.imported ?? 0} imported</span>
              <span>{job.summary.duplicates ?? 0} duplicates skipped</span>
              <span>{job.summary.total_rows ?? job.summary.readings} nutrition rows</span>
            </>
          ) : (
            <span>{job.summary.readings} CGM readings</span>
          )}
          <span>latest {job.summary.latest_day || "--"}</span>
        </div>
      )}
      {job.status === "failed" && (
        <details className="import-error">
          <summary>Error details</summary>
          {job.stderr && <pre>{job.stderr}</pre>}
          {job.stdout && <pre>{job.stdout}</pre>}
        </details>
      )}
    </section>
  );
}

function TodayStack({
  range,
  insulin,
  food,
  basal,
  recovery,
  dataConfidence,
  periodRanges,
  periodBasal,
  periodInsulin,
  periodFood,
  periodRecovery
}: {
  range: DailyRange | undefined;
  insulin: DashboardData["tidepool"]["daily_insulin"][number] | undefined;
  food: DashboardData["tidepool"]["daily_food"][number] | undefined;
  basal: DashboardData["tidepool"]["basal_deviation"]["daily"][number] | undefined;
  recovery: number | null;
  dataConfidence: number;
  periodRanges: DailyRange[];
  periodBasal: DashboardData["tidepool"]["basal_deviation"]["daily"];
  periodInsulin: DashboardData["tidepool"]["daily_insulin"];
  periodFood: DashboardData["tidepool"]["daily_food"];
  periodRecovery: Array<number | null>;
}) {
  const basalPct = insulin?.total_units ? (100 * insulin.basal_units) / insulin.total_units : null;
  const bolusPct = insulin?.total_units ? (100 * insulin.bolus_units) / insulin.total_units : null;
  const correctionLoad = insulin?.total_units && basal ? (100 * basal.extra_basal_units) / insulin.total_units : null;
  const insulinByDay = new Map(periodInsulin.map((row) => [row.day, row]));
  const basalByDay = new Map(periodBasal.map((row) => [row.day, row]));
  const foodByDay = new Map(periodFood.map((row) => [row.day, row]));
  return (
    <aside className="today-stack panel">
      <div className="section-heading">
        <div>
          <h2>Day Summary Stack</h2>
          <p>Current day signals</p>
        </div>
      </div>
      <div className="stack-list">
        <div className="stack-row green" title="Time in range trend for the selected summary period.">
          <div>
            <span>Time In Range</span>
            <small>70-180 mg/dL</small>
          </div>
          <strong>{format(range?.in_range_pct, 0)}%</strong>
          <div className="stack-trend">
            <Sparkline values={periodRanges.map((row) => row.in_range_pct)} color="#14905d" label="Time in range trend" unit="%" />
            <em>{periodRanges.length}-day trend</em>
          </div>
        </div>
        <div className="stack-row amber" title="Total carbs logged for the selected day.">
          <div>
            <span>Total Carbs</span>
            <small>{food?.meals || 0} meal entries</small>
          </div>
          <strong>{format(food?.carbs, 0)}<small> g</small></strong>
          <div className="stack-trend">
            <Sparkline values={periodRanges.map((row) => foodByDay.get(row.day)?.carbs)} color="#f59e0b" label="Total carbs trend" unit=" g" />
            <em>{periodRanges.length}-day trend</em>
          </div>
        </div>
        <div className="stack-row blue" title="Average CGM glucose trend for the selected summary period.">
          <div>
            <span>Average Glucose</span>
            <small>CV {format(range?.cv_pct, 0)}%</small>
          </div>
          <strong>{format(range?.avg_glucose, 0)}<small> mg/dL</small></strong>
          <div className="stack-trend">
            <Sparkline values={periodRanges.map((row) => row.avg_glucose)} color="#2f80ed" label="Average glucose trend" unit=" mg/dL" />
            <em>{periodRanges.length}-day trend</em>
          </div>
        </div>
        <div className="stack-row violet" title="Basal correction load is extra basal as a percent of total daily insulin.">
          <div>
            <span>Basal Correction Load</span>
            <small>{format(basal?.extra_basal_units, 1)}U extra basal</small>
          </div>
          <strong>{format(correctionLoad, 0)}%</strong>
          <div className="stack-trend">
            <Sparkline
              values={periodRanges.map((row) => {
                const basalRow = basalByDay.get(row.day);
                const insulinRow = insulinByDay.get(row.day);
                return basalRow && insulinRow?.total_units ? (100 * basalRow.extra_basal_units) / insulinRow.total_units : null;
              })}
              color="#7c5ce7"
              label="Basal correction load trend"
              unit="%"
            />
            <em>{periodRanges.length}-day trend</em>
          </div>
        </div>
        <div className="stack-row insulin" title="Total daily insulin trend for the selected summary period.">
          <div>
            <span>Total Insulin</span>
            <small>Basal {format(basalPct, 0)}% · Bolus {format(bolusPct, 0)}%</small>
          </div>
          <strong>{format(insulin?.total_units, 1)}<small> U</small></strong>
          <div className="stack-trend">
            <Sparkline values={periodRanges.map((row) => insulinByDay.get(row.day)?.total_units)} color="#1f4f8f" label="Total insulin trend" unit=" U" />
            <div className="insulin-split" aria-hidden="true">
              <span style={{ width: `${format(basalPct || 0, 0)}%` }} />
              <span style={{ width: `${format(bolusPct || 0, 0)}%` }} />
            </div>
          </div>
        </div>
        <div className="stack-row amber" title="Average post-meal recovery time trend for the selected summary period.">
          <div>
            <span>Meal Recovery</span>
            <small>{format(food?.carbs, 0)}g carbs logged</small>
          </div>
          <strong>{minutesLabel(recovery)}</strong>
          <div className="stack-trend">
            <Sparkline values={periodRecovery} color="#f59e0b" label="Meal recovery trend" unit=" min" />
            <em>{periodRanges.length}-day trend</em>
          </div>
        </div>
        <div className="stack-row green" title="Activity will be populated after Apple Health import is implemented.">
          <div>
            <span>Activity</span>
            <small>Apple Health import planned</small>
          </div>
          <strong>Pending</strong>
          <div className="activity-bars" aria-label="Activity import is pending">
            {Array.from({ length: 18 }, (_unused, index) => <span key={index} style={{ height: `${18 + ((index * 13) % 38)}%` }} />)}
          </div>
        </div>
        <div className="stack-row confidence" title="Data confidence is estimated from CGM reading coverage.">
          <div>
            <span>Data Confidence</span>
            <small>{range?.readings || 0} CGM readings</small>
          </div>
          <strong>{format(dataConfidence, 0)}%</strong>
          <div className="stack-trend">
            <Sparkline values={periodRanges.map((row) => Math.min(100, (row.readings / 288) * 100))} color="#1f4f8f" label="Data confidence trend" unit="%" />
            <em>coverage</em>
          </div>
        </div>
      </div>
    </aside>
  );
}

function PatternBoard({
  rows,
  previousRows,
  events,
  periodLabel
}: {
  rows: MealSummary[];
  previousRows: MealSummary[];
  events: DashboardData["meal_analysis"]["events"];
  periodLabel: string;
}) {
  const byMeal = new Map(rows.map((row) => [row.meal, row]));
  const previousByMeal = new Map(previousRows.map((row) => [row.meal, row]));
  return (
    <article className="panel full">
      <div className="section-heading">
        <div>
          <h2>Pattern Board</h2>
          <p>Meal-window signals for pump settings, food choices, and exercise timing.</p>
        </div>
      </div>
      <div className="pattern-board">
        {Object.entries(mealMeta).map(([meal, meta]) => {
          const row = byMeal.get(meal);
          const previous = previousByMeal.get(meal);
          const mealEvents = events.filter((event) => event.meal === meal);
          const avgCarbs = averageNumeric(mealEvents, (event) => event.carbs);
          const avgBolus = averageNumeric(mealEvents, (event) => event.bolus);
          return (
            <div className="pattern-card" style={{ "--meal-color": meta.color, "--meal-soft": meta.soft } as CSSProperties} key={meal}>
              <div className="pattern-card-header">
                <div>
                  <strong>{meta.label}</strong>
                  <span>{meta.window}</span>
                </div>
                <span className="meal-dot" />
              </div>
              <div className="pattern-spark">
                <Sparkline
                  values={mealEvents.map((event) => event.burden_score)}
                  color={meta.color}
                  height={42}
                  label={`${meta.label} burden trend`}
                />
              </div>
              <dl>
                <div>
                  <dt><span>Meal count</span><small>announced in window</small></dt>
                  <dd><strong>{mealEvents.length}</strong></dd>
                </div>
                <div>
                  <dt><span>Avg carbs</span><small>per meal event</small></dt>
                  <dd><strong>{format(avgCarbs, 0)}g</strong></dd>
                </div>
                <div>
                  <dt><span>Avg bolus</span><small>per meal event</small></dt>
                  <dd><strong>{format(avgBolus, 1)}U</strong></dd>
                </div>
                <div>
                  <dt><span>Recovery avg</span><small>vs prev {periodLabel}</small></dt>
                  <dd><strong>{minutesLabel(row?.recovery_minutes_4h)}</strong><DeltaBadge current={row?.recovery_minutes_4h} previous={previous?.recovery_minutes_4h} digits={0} suffix="m" /></dd>
                </div>
                <div>
                  <dt><span>Extra basal avg</span><small>vs prev {periodLabel}</small></dt>
                  <dd><strong>{format(row?.extra_basal_4h, 2)}U</strong><DeltaBadge current={row?.extra_basal_4h} previous={previous?.extra_basal_4h} digits={2} suffix="U" /></dd>
                </div>
                <div>
                  <dt><span>Observed sensitivity</span><small>vs prev {periodLabel}</small></dt>
                  <dd><strong>{format(row?.observed_sensitivity, 0)} mg/dL/U</strong><DeltaBadge current={row?.observed_sensitivity} previous={previous?.observed_sensitivity} digits={0} lowerIsBetter={false} /></dd>
                </div>
                <div>
                  <dt><span>Burden Score</span><small>vs prev {periodLabel}</small></dt>
                  <dd><strong>{format(row?.burden_score, 0)}</strong><DeltaBadge current={row?.burden_score} previous={previous?.burden_score} digits={0} /></dd>
                </div>
                <div>
                  <dt><span>Low-after-high risk</span><small>vs prev {periodLabel}</small></dt>
                  <dd><strong>{format(row?.low_after_correction_pct, 0)}%</strong><DeltaBadge current={row?.low_after_correction_pct} previous={previous?.low_after_correction_pct} digits={0} suffix="%" /></dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function MealRecoveryTable({ rows }: { rows: MealSummary[] }) {
  const byMeal = new Map(rows.map((row) => [row.meal, row]));
  return (
    <div className="recovery-table">
      {Object.entries(mealMeta).map(([meal, meta]) => {
        const row = byMeal.get(meal);
        return (
          <section key={meal} style={{ "--meal-color": meta.color, "--meal-soft": meta.soft } as CSSProperties}>
            <div className="recovery-table-head">
              <span className="meal-dot" />
              <div>
                <strong>{meta.label}</strong>
                <small>{meta.window}</small>
              </div>
            </div>
            <dl>
              <div>
                <dt>Recovery</dt>
                <dd>{minutesLabel(row?.recovery_minutes_4h)}</dd>
              </div>
              <div>
                <dt>Peak</dt>
                <dd>{format(row?.peak_4h, 0)} mg/dL</dd>
              </div>
              <div>
                <dt>Area &gt;180</dt>
                <dd>{format(row?.area_over_180_4h, 1)}</dd>
              </div>
              <div>
                <dt>% &gt;180</dt>
                <dd>{format(row?.pct_high_4h, 0)}%</dd>
              </div>
              <div>
                <dt>Extra Basal</dt>
                <dd>{format(row?.extra_basal_4h, 2)}U</dd>
              </div>
              <div>
                <dt>Observed ISF</dt>
                <dd>{format(row?.observed_sensitivity, 0)}</dd>
              </div>
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function SummaryMetricCard({
  label,
  value,
  context,
  values,
  current,
  previous,
  color,
  lowerIsBetter = true,
  deltaDigits = 0,
  deltaSuffix = "",
  hideDeltaWhenMissing = false
}: {
  label: string;
  value: string;
  context: string;
  values: Array<number | null | undefined>;
  current: number | null | undefined;
  previous: number | null | undefined;
  color: string;
  lowerIsBetter?: boolean;
  deltaDigits?: number;
  deltaSuffix?: string;
  hideDeltaWhenMissing?: boolean;
}) {
  return (
    <div className="summary-metric-card" title={`${label}. ${context}`}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{context}</small>
      </div>
      <div className="summary-metric-trend">
        <Sparkline values={values} color={color} label={`${label} summary trend`} />
        <DeltaBadge current={current} previous={previous} digits={deltaDigits} suffix={deltaSuffix} lowerIsBetter={lowerIsBetter} hideWhenMissing={hideDeltaWhenMissing} />
      </div>
    </div>
  );
}

function AppShell({
  activeTab,
  setActiveTab,
  children
}: {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  children: ReactNode;
}) {
  const items: Array<[ActiveTab, string]> = [
    ["today", "Daily"],
    ["summary", "Summary"],
    ["journal", "Journal"],
    ["imports", "Imports"],
    ["help", "Help"]
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>SignalWell</strong>
            <span>Diabetes signals</span>
          </div>
        </div>
        <nav className="side-nav">
          {items.map(([tab, label]) => (
            <button key={tab} className={activeTab === tab ? "active" : ""} type="button" onClick={() => setActiveTab(tab)}>
              {label}
            </button>
          ))}
        </nav>
      </aside>
      {children}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => parseRoute().tab);
  const [periodLabel, setPeriodLabel] = useState(() => parseRoute().period || "1 week");
  const [summaryStart, setSummaryStart] = useState(() => parseRoute().start || "");
  const [summaryEnd, setSummaryEnd] = useState(() => parseRoute().end || "");
  const [day, setDay] = useState(() => parseRoute().day || "");
  const [status, setStatus] = useState("");
  const [importJob, setImportJob] = useState<ImportJob | null>(null);

  useEffect(() => {
    fetchDashboard().then((payload) => {
      const route = parseRoute();
      const defaultPeriod = payload.period_summaries[0]?.label || "1 week";
      const routePeriod = payload.period_summaries.some((item) => item.label === route.period) ? route.period : defaultPeriod;
      const selectedPeriod = payload.period_summaries.find((item) => item.label === (routePeriod || defaultPeriod));
      const latestDay = payload.tidepool.daily_ranges[payload.tidepool.daily_ranges.length - 1]?.day || "";
      const routeDay = payload.tidepool.daily_ranges.some((row) => row.day === route.day) ? route.day : latestDay;
      const routeStart = payload.tidepool.daily_ranges.some((row) => row.day === route.start) ? route.start : selectedPeriod?.start || "";
      const routeEnd = payload.tidepool.daily_ranges.some((row) => row.day === route.end) ? route.end : selectedPeriod?.end || "";
      setData(payload);
      setActiveTab(route.tab);
      setPeriodLabel(routePeriod || defaultPeriod);
      setSummaryStart(routeStart || "");
      setSummaryEnd(routeEnd || "");
      setDay(routeDay || latestDay);
    }).catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const route = parseRoute();
      setActiveTab(route.tab);
      if (route.period) setPeriodLabel(route.period);
      if (route.day) setDay(route.day);
      if (route.start) setSummaryStart(route.start);
      if (route.end) setSummaryEnd(route.end);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams();
    if (activeTab === "today" && day) {
      params.set("day", day);
    }
    if (activeTab === "summary" || activeTab === "journal") {
      params.set("period", periodLabel);
    }
    if ((activeTab === "summary" || activeTab === "journal") && summaryStart && summaryEnd) {
      params.set("start", summaryStart);
      params.set("end", summaryEnd);
    }
    const nextUrl = `${routePath(activeTab)}${params.toString() ? `?${params.toString()}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [activeTab, data, day, periodLabel, summaryEnd, summaryStart]);

  useEffect(() => {
    if (!importJob || importJob.status === "completed" || importJob.status === "failed") return;
    const timer = window.setInterval(async () => {
      try {
        const job = await fetchImportJob(importJob.id);
        setImportJob(job);
        if (job.status === "completed") {
          const payload = await fetchDashboard();
          setData(payload);
          const duplicateLabel = job.summary?.duplicates !== undefined ? ` · ${job.summary.duplicates} duplicates skipped` : "";
          setStatus(`Imported ${job.filename}${duplicateLabel}`);
          if (job.source !== "cronometer") {
            setDay(payload.tidepool.daily_ranges[payload.tidepool.daily_ranges.length - 1]?.day || "");
          }
        }
        if (job.status === "failed") {
          setStatus(`Import failed: ${job.message}`);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [importJob]);

  const period = data?.period_summaries.find((item) => item.label === periodLabel);
  const availableDays = data?.tidepool.daily_ranges.map((row) => row.day) || [];
  const dayIndex = availableDays.indexOf(day);
  const previousDay = dayIndex > 0 ? availableDays[dayIndex - 1] : null;
  const nextDay = dayIndex >= 0 && dayIndex < availableDays.length - 1 ? availableDays[dayIndex + 1] : null;
  const firstAvailableDay = availableDays[0] || "";
  const lastAvailableDay = availableDays[availableDays.length - 1] || "";
  const days = data && period ? periodDays(period, data.tidepool.daily_ranges) : [];
  const summaryDays = data?.tidepool.daily_ranges
    .filter((row) => (!summaryStart || row.day >= summaryStart) && (!summaryEnd || row.day <= summaryEnd))
    .map((row) => row.day) || [];
  const dailyRanges = data?.tidepool.daily_ranges.filter((row) => days.includes(row.day)) || [];
  const dailyBasal = data?.tidepool.basal_deviation.daily.filter((row) => days.includes(row.day)) || [];
  const dailyInsulin = data?.tidepool.daily_insulin.filter((row) => days.includes(row.day)) || [];
  const dailyFood = data?.tidepool.daily_food.filter((row) => days.includes(row.day)) || [];
  const summaryDailyRanges = data?.tidepool.daily_ranges.filter((row) => summaryDays.includes(row.day)) || [];
  const summaryDailyBasal = data?.tidepool.basal_deviation.daily.filter((row) => summaryDays.includes(row.day)) || [];
  const summaryDailyInsulin = data?.tidepool.daily_insulin.filter((row) => summaryDays.includes(row.day)) || [];
  const summaryDailyFood = data?.tidepool.daily_food.filter((row) => summaryDays.includes(row.day)) || [];
  const selectedDayRange = data?.tidepool.daily_ranges.find((row) => row.day === day);
  const selectedDayBasal = data?.tidepool.basal_deviation.daily.find((row) => row.day === day);
  const selectedDayInsulin = data?.tidepool.daily_insulin.find((row) => row.day === day);
  const selectedDayFood = data?.tidepool.daily_food.find((row) => row.day === day);
  const selectedDayNutrition = data?.cronometer.daily.find((row) => row.date === day);
  const selectedDayNutritionGroups = data?.cronometer.groups.filter((row) => row.date === day) || [];
  const summaryNutrition = data?.cronometer.daily.filter((row) => summaryDays.includes(row.date)) || [];
  const summaryNutritionTotal = summaryNutrition.length
    ? {
        date: `${summaryStart || summaryNutrition[0]?.date || ""}..${summaryEnd || summaryNutrition[summaryNutrition.length - 1]?.date || ""}`,
        group: "Total",
        energy_kcal: summaryNutrition.reduce((total, row) => total + (row.energy_kcal || 0), 0),
        net_carbs_g: summaryNutrition.reduce((total, row) => total + (row.net_carbs_g || 0), 0),
        carbs_g: summaryNutrition.reduce((total, row) => total + (row.carbs_g || 0), 0),
        fiber_g: summaryNutrition.reduce((total, row) => total + (row.fiber_g || 0), 0),
        sugars_g: summaryNutrition.reduce((total, row) => total + (row.sugars_g || 0), 0),
        added_sugars_g: summaryNutrition.reduce((total, row) => total + (row.added_sugars_g || 0), 0),
        fat_g: summaryNutrition.reduce((total, row) => total + (row.fat_g || 0), 0),
        saturated_fat_g: summaryNutrition.reduce((total, row) => total + (row.saturated_fat_g || 0), 0),
        protein_g: summaryNutrition.reduce((total, row) => total + (row.protein_g || 0), 0),
        sodium_mg: summaryNutrition.reduce((total, row) => total + (row.sodium_mg || 0), 0),
        water_g: summaryNutrition.reduce((total, row) => total + (row.water_g || 0), 0),
        completed: null,
        row_hash: null,
        source_file: null,
        imported_at: null,
        carb_calories: summaryNutrition.reduce((total, row) => total + row.carb_calories, 0),
        fat_calories: summaryNutrition.reduce((total, row) => total + row.fat_calories, 0),
        protein_calories: summaryNutrition.reduce((total, row) => total + row.protein_calories, 0),
        macro_calories: summaryNutrition.reduce((total, row) => total + row.macro_calories, 0),
        carb_calorie_pct: null,
        fat_calorie_pct: null,
        protein_calorie_pct: null
      }
    : undefined;
  const selectedDayEvents = data?.tidepool.daily_events.filter((row) => row.day === day) || [];
  const mealRows = data?.meal_analysis.periods[periodLabel] || [];
  const selectedDayMeals = data?.meal_analysis.events.filter((row) => row.date === day) || [];
  const selectedDayMealRows = summarizeMealEvents(selectedDayMeals);
  const periodMealEvents = data?.meal_analysis.events.filter((row) => days.includes(row.date)) || [];
  const summaryMealEvents = data?.meal_analysis.events.filter((row) => summaryDays.includes(row.date)) || [];
  const summaryMealRows = summarizeMealEvents(summaryMealEvents);
  const previousDays = (() => {
    if (!data || !summaryDays.length) return [];
    const available = data.tidepool.daily_ranges.map((row) => row.day);
    const startIndex = available.indexOf(summaryDays[0]);
    if (startIndex <= 0) return [];
    return available.slice(Math.max(0, startIndex - summaryDays.length), startIndex);
  })();
  const previousMealRows = summarizeMealEvents(data?.meal_analysis.events.filter((row) => previousDays.includes(row.date)) || []);
  const previousDailyRanges = data?.tidepool.daily_ranges.filter((row) => previousDays.includes(row.day)) || [];
  const previousDailyBasal = data?.tidepool.basal_deviation.daily.filter((row) => previousDays.includes(row.day)) || [];
  const previousDailyInsulin = data?.tidepool.daily_insulin.filter((row) => previousDays.includes(row.day)) || [];
  const summaryAvgGlucose = averageNumeric(summaryDailyRanges, (row) => row.avg_glucose);
  const summaryTimeInRange = averageNumeric(summaryDailyRanges, (row) => row.in_range_pct);
  const summaryExtraBasal = summaryDailyBasal.reduce((total, row) => total + row.extra_basal_units, 0);
  const summaryExtraBasalPerDay = summaryDailyBasal.length ? summaryExtraBasal / summaryDailyBasal.length : null;
  const summaryTotalInsulin = summaryDailyInsulin.reduce((total, row) => total + row.total_units, 0);
  const summaryCorrectionLoad = summaryTotalInsulin ? (100 * summaryExtraBasal) / summaryTotalInsulin : null;
  const summaryBolusUnits = summaryDailyInsulin.reduce((total, row) => total + row.bolus_units, 0);
  const summaryCarbs = summaryDailyFood.reduce((total, row) => total + row.carbs, 0);
  const summaryBolusPerCarb = summaryCarbs ? summaryBolusUnits / summaryCarbs : null;
  const isCustomSummaryRange = Boolean(period && (summaryStart !== period.start || summaryEnd !== period.end));
  const summaryRangeLabel = isCustomSummaryRange ? "Custom Range" : period?.label || "Summary";
  const recoveryByDay = days.map((periodDay) =>
    averageNumeric(
      data?.meal_analysis.events.filter((row) => row.date === periodDay) || [],
      (row) => row.recovery_minutes_4h
    )
  );
  const periodMealBurden = averageNumeric(summaryMealRows, (row) => row.burden_score);
  const periodRecovery = averageNumeric(summaryMealRows, (row) => row.recovery_minutes_4h);
  const periodAreaOver180 = averageNumeric(summaryMealRows, (row) => row.area_over_180_4h);
  const periodLowRisk = averageNumeric(summaryMealRows, (row) => row.low_after_correction_pct);
  const previousAvgGlucose = averageNumeric(previousDailyRanges, (row) => row.avg_glucose);
  const previousTimeInRange = averageNumeric(previousDailyRanges, (row) => row.in_range_pct);
  const previousExtraBasal = previousDailyBasal.reduce((total, row) => total + row.extra_basal_units, 0);
  const previousExtraBasalPerDay = previousDailyBasal.length ? previousExtraBasal / previousDailyBasal.length : null;
  const previousTotalInsulin = previousDailyInsulin.reduce((total, row) => total + row.total_units, 0);
  const previousCorrectionLoad = previousTotalInsulin ? (100 * previousExtraBasal) / previousTotalInsulin : null;
  const previousBolusUnits = previousDailyInsulin.reduce((total, row) => total + row.bolus_units, 0);
  const previousCarbs = (data?.tidepool.daily_food.filter((row) => previousDays.includes(row.day)) || []).reduce((total, row) => total + row.carbs, 0);
  const previousBolusPerCarb = previousCarbs ? previousBolusUnits / previousCarbs : null;
  const previousMealBurden = averageNumeric(previousMealRows, (row) => row.burden_score);
  const previousRecovery = averageNumeric(previousMealRows, (row) => row.recovery_minutes_4h);
  const previousAreaOver180 = averageNumeric(previousMealRows, (row) => row.area_over_180_4h);
  const previousLowRisk = averageNumeric(previousMealRows, (row) => row.low_after_correction_pct);
  const dayMealBurden = averageNumeric(selectedDayMeals, (row) => row.burden_score);
  const dayAreaOver180 = averageNumeric(selectedDayMeals, (row) => row.area_over_180_4h);
  const dayRecovery = averageNumeric(selectedDayMeals, (row) => row.recovery_minutes_4h);
  const dayLowAfterCorrection = selectedDayMeals.filter((row) => row.low_after_correction).length;
  const journalRangeLabel = formatDateRange(summaryStart, summaryEnd);
  const journalRows = useMemo(() => {
    if (!data) return [];
    const rows = [...data.log.daily].sort((a, b) => b.date.localeCompare(a.date));
    if (!summaryStart || !summaryEnd) return rows.slice(0, 200);
    return rows.filter((row) => row.date >= summaryStart && row.date <= summaryEnd);
  }, [data, summaryEnd, summaryStart]);
  const foodLogRows = useMemo(() => {
    if (!data) return [];
    const rows = [...data.cronometer.groups].sort((a, b) => b.date.localeCompare(a.date) || b.group.localeCompare(a.group));
    if (!summaryStart || !summaryEnd) return rows.slice(0, 200);
    return rows.filter((row) => row.date >= summaryStart && row.date <= summaryEnd);
  }, [data, summaryEnd, summaryStart]);
  const journalStats = useMemo(() => journalAverages(journalRows), [journalRows]);
  const previousJournalRows = useMemo(() => {
    if (!data || !summaryStart) return [];
    const sortedAsc = [...data.log.daily].sort((a, b) => a.date.localeCompare(b.date));
    const startIndex = sortedAsc.findIndex((row) => row.date >= summaryStart);
    if (startIndex <= 0) return [];
    return sortedAsc.slice(Math.max(0, startIndex - journalStats.days), startIndex);
  }, [data, journalStats.days, summaryStart]);
  const previousJournalStats = useMemo(() => journalAverages(previousJournalRows), [previousJournalRows]);
  const reportTitle =
    activeTab === "today"
      ? `Daily Dashboard - ${formatLongDate(day)}`
      : activeTab === "summary"
        ? `${summaryRangeLabel} Signal Summary`
        : activeTab === "journal"
          ? "Journal Review"
          : `${activeTab[0].toUpperCase()}${activeTab.slice(1)}`;
  const reportSubtitle =
    activeTab === "today"
      ? `${day} · Tidepool pump, CGM, meals, and event markers`
      : activeTab === "summary"
        ? `${formatDateRange(summaryStart, summaryEnd)} · ${summaryDays.length} days available`
        : activeTab === "journal"
          ? `${journalRangeLabel || "Latest journal days"} · ${journalStats.days} days`
          : `${data?.tidepool.daily_ranges.length || 0} days · local data`;

  function reportFilename() {
    const scope =
      activeTab === "today"
        ? day
        : summaryStart && summaryEnd
          ? `${summaryStart}-to-${summaryEnd}`
          : "current";
    return `signalwell-${activeTab}-${scope}.pdf`;
  }

  function exportActiveTabPdf() {
    const dashboard = data;
    if (!dashboard) return;

    if (activeTab === "today") {
      generateReportPdf({
        tab: "today",
        title: reportTitle,
        subtitle: reportSubtitle,
        filename: reportFilename(),
        today: {
          range: selectedDayRange,
          insulin: selectedDayInsulin,
          food: selectedDayFood,
          basal: selectedDayBasal,
          glucose: dashboard.tidepool.glucose_points.filter((row) => row.day === day),
          meals: selectedDayMeals,
          mealRows: selectedDayMealRows,
          events: selectedDayEvents
        }
      });
      return;
    }
    if (activeTab === "summary") {
      generateReportPdf({
        tab: "summary",
        title: reportTitle,
        subtitle: reportSubtitle,
        filename: reportFilename(),
        summary: {
          days: summaryDays,
          ranges: summaryDailyRanges,
          basal: summaryDailyBasal,
          basalHourly: dashboard.tidepool.basal_deviation.hourly,
          insulin: summaryDailyInsulin,
          food: summaryDailyFood,
          mealRows: summaryMealRows,
          mealEvents: summaryMealEvents,
          metrics: [
            ["Avg CGM", `${format(summaryAvgGlucose, 0)} mg/dL`, "Daily average glucose", "#2f80ed"],
            ["Time In Range", `${format(summaryTimeInRange, 0)}%`, "70-180 mg/dL", "#14905d"],
            ["Extra Basal", `${format(summaryExtraBasal, 1)}U`, "Above programmed basal", "#7c5ce7"],
            ["Correction Load", `${format(summaryCorrectionLoad, 0)}%`, "Extra basal / total insulin", "#7c5ce7"],
            ["Bolus/g", format(summaryBolusPerCarb, 3), "Observed bolus density", "#1f4f8f"],
            ["Meal Burden", format(periodMealBurden, 1), "Post-meal cleanup score", "#f59e0b"],
            ["Avg Recovery", minutesLabel(periodRecovery), "After crossing >180", "#f59e0b"],
            ["Area >180", format(periodAreaOver180, 1), "Above-range exposure", "#d64f4f"]
          ]
        }
      });
      return;
    }
    if (activeTab === "journal") {
      generateReportPdf({
        tab: "journal",
        title: reportTitle,
        subtitle: reportSubtitle,
        filename: reportFilename(),
        journal: {
          rows: journalRows,
          stats: journalStats,
          previousStats: previousJournalStats,
          baseline: dashboard.log.baseline
        }
      });
    }
  }

  async function onImport(file: File | null) {
    if (!file) return;
    setStatus("Uploading Tidepool export...");
    try {
      const job = await startTidepoolImport(file);
      setImportJob(job);
      setStatus(`Started import for ${file.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function onCronometerImport(file: File | null) {
    if (!file) return;
    setStatus("Uploading Cronometer CSV...");
    try {
      const job = await startCronometerImport(file);
      setImportJob(job);
      setStatus(`Started Cronometer import for ${file.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  if (!data) {
    return <main className="loading">Loading dashboard... {status}</main>;
  }

  return (
    <AppShell activeTab={activeTab} setActiveTab={setActiveTab}>
      <main className="app-main">
        <header className="topbar">
          <div>
            <h1>{activeTab === "today" ? "Daily Dashboard" : activeTab[0].toUpperCase() + activeTab.slice(1)}</h1>
            <p>{data.tidepool.daily_ranges.length} days · {data.tidepool.totals.readings} CGM readings · local data</p>
          </div>
          <div className="header-actions">
            {activeTab === "today" && (
              <div className="day-nav">
                <button type="button" disabled={!previousDay} onClick={() => previousDay && setDay(previousDay)} aria-label="Previous day">
                  &lt;
                </button>
                <input
                  type="date"
                  value={day}
                  min={firstAvailableDay}
                  max={lastAvailableDay}
                  onChange={(event) => {
                    const requested = event.target.value;
                    if (availableDays.includes(requested)) {
                      setDay(requested);
                      return;
                    }
                    const fallback = [...availableDays].reverse().find((availableDay) => availableDay <= requested) || firstAvailableDay;
                    setDay(fallback);
                  }}
                  aria-label="Select day"
                />
                <button type="button" disabled={!nextDay} onClick={() => nextDay && setDay(nextDay)} aria-label="Next day">
                  &gt;
                </button>
              </div>
            )}
            {(activeTab === "summary" || activeTab === "journal") && (
              <select
                value={periodLabel}
                onChange={(event) => {
                  const nextLabel = event.target.value;
                  setPeriodLabel(nextLabel);
                  if (activeTab === "summary" || activeTab === "journal") {
                    const selected = data.period_summaries.find((item) => item.label === nextLabel);
                    if (selected) {
                      setSummaryStart(selected.start);
                      setSummaryEnd(selected.end);
                    }
                  }
                }}
              >
                {data.period_summaries.map((item) => <option key={item.label}>{item.label}</option>)}
              </select>
            )}
            {(activeTab === "summary" || activeTab === "journal") && (
              <div className="range-picker">
                <label>
                  <span>Start</span>
                  <input
                    type="date"
                    value={summaryStart}
                    min={firstAvailableDay}
                    max={lastAvailableDay}
                    onChange={(event) => {
                      const nextStart = event.target.value;
                      setSummaryStart(nextStart);
                      if (summaryEnd && nextStart > summaryEnd) setSummaryEnd(nextStart);
                    }}
                  />
                </label>
                <label>
                  <span>End</span>
                  <input
                    type="date"
                    value={summaryEnd}
                    min={firstAvailableDay}
                    max={lastAvailableDay}
                    onChange={(event) => {
                      const nextEnd = event.target.value;
                      setSummaryEnd(nextEnd);
                      if (summaryStart && nextEnd < summaryStart) setSummaryStart(nextEnd);
                    }}
                  />
                </label>
              </div>
            )}
            {(activeTab === "today" || activeTab === "summary" || activeTab === "journal") && (
              <button type="button" className="ghost-button export-button" onClick={exportActiveTabPdf}>
                Download PDF
              </button>
            )}
          </div>
        </header>

        {(activeTab === "today" || activeTab === "summary" || activeTab === "journal") && (
          <section className="print-report-header" aria-hidden="true">
            <h1>{reportTitle}</h1>
            <p>{reportSubtitle}</p>
            <small>Generated from local SignalWell data on {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</small>
          </section>
        )}

        {status && <div className="status">{status}</div>}
        {activeTab !== "imports" && <ImportWorkflow job={importJob} />}

        {activeTab === "today" && (
          <section className="today-layout">
            <div className="today-main">
              <article className="panel full chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Glucose trend for {formatLongDate(day)}</h2>
                    <p>{day} · carb, exercise, and note markers use Tidepool entries</p>
                  </div>
                  <div className="legend-row">
                    <span className="legend-dot green">In Range</span>
                    <span className="legend-dot amber">High</span>
                    <span className="legend-dot red">Low</span>
                  </div>
                </div>
                <EChart option={dayGlucoseOption(data, day, selectedDayMeals, selectedDayEvents)} height={340} />
              </article>

              <article className="panel full chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Selected Day Basal Rate Profile</h2>
                    <p>Delivered basal rate by hour compared with programmed basal, plus delivered-minus-programmed delta.</p>
                  </div>
                </div>
                <EChart option={dayBasalRateOption(data.tidepool.basal_deviation.hourly, day)} height={390} />
              </article>

              <PatternBoard rows={selectedDayMealRows} previousRows={previousMealRows} events={selectedDayMeals} periodLabel={periodLabel} />

              <article className="panel full chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Meal Recovery</h2>
                    <p>Four-hour post-meal glucose paths with above-range exposure visible against the 180 mg/dL threshold.</p>
                  </div>
                </div>
                <EChart option={mealRecoveryOption(data, day, selectedDayMeals)} height={300} />
                <div className="recovery-metrics">
                  <span><strong>Avg recovery</strong>{minutesLabel(dayRecovery)}</span>
                  <span><strong>Area &gt;180</strong>{format(dayAreaOver180, 1)}</span>
                  <span><strong>Extra basal</strong>{format(averageNumeric(selectedDayMeals, (row) => row.extra_basal_4h), 2)}U</span>
                  <span><strong>Burden</strong>{format(dayMealBurden, 1)}</span>
                </div>
                <MealRecoveryTable rows={selectedDayMealRows} />
              </article>

              <MacroCaloriesPanel
                title="Daily Macro Calories"
                subtitle={
                  selectedDayNutrition
                    ? `${formatLongDate(day)} · Cronometer total row with meal-group detail`
                    : "Import Cronometer nutrition to show macro calorie distribution for this day."
                }
                row={selectedDayNutrition}
                groupRows={selectedDayNutritionGroups}
                emptyMessage={`No Cronometer total row is available for ${day}.`}
                mode="day"
              />

              <article className="panel full">
                <div className="section-heading">
                  <div>
                    <h2>Selected Day Meal Impact</h2>
                    <p>All current meal-impact metrics, shown directly for review without hidden detail links.</p>
                  </div>
                </div>
                <MealEventTable rows={selectedDayMeals} />
              </article>
            </div>
            <TodayStack
              range={selectedDayRange}
              insulin={selectedDayInsulin}
              food={selectedDayFood}
              basal={selectedDayBasal}
              recovery={dayRecovery}
              dataConfidence={selectedDayRange ? Math.min(100, (selectedDayRange.readings / 288) * 100) : 0}
              periodRanges={dailyRanges}
              periodBasal={dailyBasal}
              periodInsulin={dailyInsulin}
              periodFood={dailyFood}
              periodRecovery={recoveryByDay}
            />
          </section>
        )}

        {activeTab === "summary" && period && (
          <section className="summary-page">
            <article className="panel full summary-hero">
              <div>
                <h2>{summaryRangeLabel} Signal Summary</h2>
                <p>{summaryStart} to {summaryEnd} · {summaryDays.length} days available · compared with the prior {summaryDays.length}-day window when data exists</p>
              </div>
              <div className="summary-hero-stat">
                <span>Time In Range</span>
                <strong>{format(summaryTimeInRange, 0)}%</strong>
                <small>Avg CGM {format(summaryAvgGlucose, 0)} mg/dL</small>
              </div>
            </article>

            <section className="summary-metric-grid">
              <SummaryMetricCard label="Avg CGM" value={`${format(summaryAvgGlucose, 0)} mg/dL`} context="daily average glucose" values={summaryDailyRanges.map((row) => row.avg_glucose)} current={summaryAvgGlucose} previous={previousAvgGlucose} color="#2f80ed" />
              <SummaryMetricCard label="Time In Range" value={`${format(summaryTimeInRange, 0)}%`} context="70-180 mg/dL" values={summaryDailyRanges.map((row) => row.in_range_pct)} current={summaryTimeInRange} previous={previousTimeInRange} color="#14905d" lowerIsBetter={false} deltaSuffix="%" />
              <SummaryMetricCard label="Extra Basal" value={`${format(summaryExtraBasal, 1)}U`} context="above programmed basal" values={summaryDailyBasal.map((row) => row.extra_basal_units)} current={summaryExtraBasal} previous={previousDailyBasal.length ? previousExtraBasal : null} color="#7c5ce7" deltaDigits={1} deltaSuffix="U" />
              <SummaryMetricCard label="Extra / Day" value={`${format(summaryExtraBasalPerDay, 1)}U`} context="avg correction basal" values={summaryDailyBasal.map((row) => row.extra_basal_units)} current={summaryExtraBasalPerDay} previous={previousExtraBasalPerDay} color="#7c5ce7" deltaDigits={1} deltaSuffix="U" />
              <SummaryMetricCard label="Correction Load" value={`${format(summaryCorrectionLoad, 0)}%`} context="extra basal / total insulin" values={summaryDailyRanges.map((row) => {
                const basalRow = summaryDailyBasal.find((item) => item.day === row.day);
                const insulinRow = summaryDailyInsulin.find((item) => item.day === row.day);
                return basalRow && insulinRow?.total_units ? (100 * basalRow.extra_basal_units) / insulinRow.total_units : null;
              })} current={summaryCorrectionLoad} previous={previousCorrectionLoad} color="#7c5ce7" deltaSuffix="%" />
              <SummaryMetricCard label="Bolus/g" value={format(summaryBolusPerCarb, 3)} context="observed bolus density" values={summaryDailyRanges.map((row) => {
                const foodRow = data.tidepool.daily_food.find((item) => item.day === row.day);
                const insulinRow = summaryDailyInsulin.find((item) => item.day === row.day);
                return foodRow?.carbs && insulinRow ? insulinRow.bolus_units / foodRow.carbs : null;
              })} current={summaryBolusPerCarb} previous={previousBolusPerCarb} color="#1f4f8f" deltaDigits={3} />
              <SummaryMetricCard label="Meal Burden" value={format(periodMealBurden, 1)} context="post-meal cleanup score" values={summaryMealRows.map((row) => row.burden_score)} current={periodMealBurden} previous={previousMealBurden} color="#f59e0b" />
              <SummaryMetricCard label="Avg Recovery" value={minutesLabel(periodRecovery)} context="after crossing >180" values={summaryMealRows.map((row) => row.recovery_minutes_4h)} current={periodRecovery} previous={previousRecovery} color="#f59e0b" deltaSuffix="m" />
              <SummaryMetricCard label="Area >180" value={format(periodAreaOver180, 1)} context="above-range exposure" values={summaryMealRows.map((row) => row.area_over_180_4h)} current={periodAreaOver180} previous={previousAreaOver180} color="#d64f4f" deltaDigits={1} />
              <SummaryMetricCard label="Low Risk" value={`${format(periodLowRisk, 0)}%`} context="low after high correction" values={summaryMealRows.map((row) => row.low_after_correction_pct)} current={periodLowRisk} previous={previousLowRisk} color="#d64f4f" deltaSuffix="%" />
            </section>

            <MacroCaloriesPanel
              title="Daily Macro Calories"
              subtitle={
                summaryNutrition.length
                  ? `${summaryNutrition.length} Cronometer days · selected-range total and daily macro trend`
                  : "Import Cronometer nutrition to track calorie and macro distribution across the selected range."
              }
              row={summaryNutritionTotal}
              trendRows={summaryNutrition}
              emptyMessage="No Cronometer totals are available for this summary range."
              mode="summary"
            />

            <article className="panel full chart-panel">
              <div className="section-heading">
                <div>
                  <h2>Hourly Basal Rate Profile</h2>
                  <p>Average delivered basal vs configured profile, plus delivered-minus-configured by hour.</p>
                </div>
              </div>
              <EChart option={hourlyRateOption(data.tidepool.basal_deviation.hourly, summaryDays)} height={380} />
            </article>

            <section className="summary-chart-grid">
              <article className="panel chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Basal Correction Load</h2>
                    <p>Daily extra basal across the selected period.</p>
                  </div>
                </div>
                <EChart option={basalCorrectionOption(summaryDailyBasal)} height={280} />
              </article>
              <article className="panel chart-panel">
                <div className="section-heading">
                  <div>
                    <h2>Glucose Trend</h2>
                    <p>Average CGM by day with range reference lines.</p>
                  </div>
                </div>
                <EChart option={glucoseAverageOption(summaryDailyRanges)} height={280} />
              </article>
            </section>

            <article className="panel full chart-panel">
              <div className="section-heading">
                <div>
                  <h2>Daily Time In Range</h2>
                  <p>Tidepool-style glucose buckets for every day in the selected period.</p>
                </div>
              </div>
              <EChart option={rangeOption(summaryDailyRanges)} height={320} />
            </article>

            <PatternBoard rows={summaryMealRows} previousRows={previousMealRows} events={summaryMealEvents} periodLabel={periodLabel} />

            <article className="panel full">
              <div className="section-heading">
                <div>
                  <h2>Meal Window Analysis</h2>
                  <p>Clustered meals, 4-hour glucose response, recovery after crossing above 180 mg/dL, and post-meal basal correction load.</p>
                </div>
              </div>
              <MealTable rows={summaryMealRows} />
            </article>
          </section>
        )}

        {activeTab === "journal" && (
          <section className="journal-page">
            <article className="panel full journal-hero">
              <div>
                <h2>Journal Review</h2>
                <p>
                  {summaryStart && summaryEnd
                    ? `${summaryStart} to ${summaryEnd} · ${journalStats.days} days`
                    : `Latest ${journalStats.days} journal days`}
                </p>
              </div>
              <div className="journal-hero-stat">
                <span>Avg Daily Insulin</span>
                <strong>{format(journalStats.total, 1)}U</strong>
                <small>Basal {format(journalStats.basalPct, 0)}% · Bolus {format(journalStats.bolusPct, 0)}%</small>
              </div>
            </article>

            <section className="journal-metric-grid">
              <SummaryMetricCard label="Avg Daily Insulin" value={`${format(journalStats.total, 1)}U`} context="journal total insulin" values={journalRows.slice().reverse().map((row) => row.total)} current={journalStats.total} previous={previousJournalStats.total} color="#1f4f8f" deltaDigits={1} deltaSuffix="U" />
              <SummaryMetricCard label="Avg Basal" value={`${format(journalStats.basal, 1)}U`} context={`${format(journalStats.basalPct, 0)}% of TDD`} values={journalRows.slice().reverse().map((row) => row.basal)} current={journalStats.basal} previous={previousJournalStats.basal} color="#2f80ed" deltaDigits={1} deltaSuffix="U" />
              <SummaryMetricCard label="Avg Bolus" value={`${format(journalStats.bolus, 1)}U`} context={`${format(journalStats.bolusPct, 0)}% of TDD`} values={journalRows.slice().reverse().map((row) => row.bolus)} current={journalStats.bolus} previous={previousJournalStats.bolus} color="#7c5ce7" deltaDigits={1} deltaSuffix="U" />
              <SummaryMetricCard label="Avg Carbs" value={`${format(journalStats.carbs, 0)}g`} context="daily journal carbs" values={journalRows.slice().reverse().map((row) => row.carbs)} current={journalStats.carbs} previous={previousJournalStats.carbs} color="#0e9f8f" deltaDigits={0} deltaSuffix="g" />
              <SummaryMetricCard label="Avg BG" value={format(journalStats.avgBg, 0)} context="journal average BG" values={journalRows.slice().reverse().map((row) => row.avg_bg)} current={journalStats.avgBg} previous={previousJournalStats.avgBg} color="#14905d" />
              <SummaryMetricCard label="Bolus/g" value={format(journalStats.bolusPerCarb, 3)} context="insulin per carb gram" values={journalRows.slice().reverse().map((row) => row.bolus_per_carb)} current={journalStats.bolusPerCarb} previous={previousJournalStats.bolusPerCarb} color="#f59e0b" deltaDigits={3} />
              <SummaryMetricCard label="Carbs/U" value={format(journalStats.carbsPerBolus, 1)} context="carbs per bolus unit" values={journalRows.slice().reverse().map((row) => row.carbs_per_bolus)} current={journalStats.carbsPerBolus} previous={previousJournalStats.carbsPerBolus} color="#f59e0b" lowerIsBetter={false} deltaDigits={1} />
              <SummaryMetricCard label="GMI" value={`${format(journalStats.gmi, 2)}%`} context="from avg glucose" values={journalRows.slice().reverse().map((row) => gmiFromAverageGlucose(row.avg_bg))} current={journalStats.gmi} previous={previousJournalStats.gmi} color="#d64f4f" deltaDigits={2} deltaSuffix="%" />
            </section>

            <article className="panel full">
              <div className="section-heading">
                <div>
                  <h2>iLet 30-Day Baseline vs Twiist</h2>
                  <p>Twiist averages are calculated from the selected Journal grouping and compared against the CSV iLet baseline.</p>
                </div>
              </div>
              <BaselineComparisonTable rows={data.log.baseline} averages={journalStats} />
            </article>

            <article className="panel full">
              <div className="section-heading">
                <div>
                  <h2>Journal Summary</h2>
                  <p>
                    {summaryStart && summaryEnd
                      ? `${summaryStart} to ${summaryEnd}`
                      : "Latest 200 days from the CSV journal"}
                  </p>
                </div>
              </div>
              <JournalTable rows={journalRows} />
            </article>

            <article className="panel full">
              <div className="section-heading">
                <div>
                  <h2>Food Log</h2>
                  <p>
                    {foodLogRows.length
                      ? `${foodLogRows.length} Cronometer meal-group rows · ${summaryStart && summaryEnd ? `${summaryStart} to ${summaryEnd}` : "latest imported rows"}`
                      : "No Cronometer food log rows in this Journal range."}
                  </p>
                </div>
              </div>
              {foodLogRows.length ? <CronometerTable rows={foodLogRows} /> : <p>Import a Cronometer CSV to review food log rows here.</p>}
            </article>
          </section>
        )}

        {activeTab === "imports" && (
          <section className="grid">
            <article className="panel full import-dropzone">
              <div>
                <h2>Import Tidepool</h2>
                <p>Load a Tidepool JSON export. Records are appended into SQLite with duplicate detection before dashboard data is rebuilt.</p>
              </div>
              <label className="import-button primary">
                Import Tidepool JSON
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    onImport(event.target.files?.[0] || null);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </article>
            <article className="panel full import-dropzone">
              <div>
                <h2>Import Cronometer</h2>
                <p>Load a Cronometer nutrition CSV. Rows are normalized by date, group, and nutrition values; exact duplicates are skipped.</p>
              </div>
              <label className="import-button primary nutrition">
                Import Cronometer CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    onCronometerImport(event.target.files?.[0] || null);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </article>
            <article className="panel full">
              <ImportWorkflow job={importJob} />
              {!importJob && <p>No import is currently running.</p>}
            </article>
          </section>
        )}

        {activeTab === "help" && (
          <section className="help-page">
            <article className="panel full help-intro">
              <div>
                <h2>Help & Metric Definitions</h2>
                <p>Reference for the non-standard metrics used throughout SignalWell. These are pattern-review aids, not therapy recommendations.</p>
              </div>
            </article>
            <MetricDefinitions />
          </section>
        )}
      </main>
    </AppShell>
  );
}
