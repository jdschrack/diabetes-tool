import type { EChartsOption } from "echarts";
import { useEffect, useMemo, useState } from "react";
import { fetchDashboard, importTidepoolExport } from "./api/client";
import type { BasalHourly, DashboardData, DailyRange, MealSummary, PeriodSummary } from "./api/types";
import { EChart } from "./charts/EChart";

const format = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value) ? "--" : value.toFixed(digits).replace(/\.0$/, "");

type JournalRow = DashboardData["log"]["daily"][number];

function periodDays(period: PeriodSummary | undefined, rows: DailyRange[]) {
  if (!period) return rows.map((row) => row.day);
  return rows.filter((row) => row.day >= period.start && row.day <= period.end).map((row) => row.day);
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

function rangeOption(rows: DailyRange[]): EChartsOption {
  const days = rows.map((row) => row.day.slice(5));
  return {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 44, right: 16, top: 44, bottom: 30 },
    xAxis: { type: "category", data: days },
    yAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" } },
    series: [
      ["Very Low", "very_low_pct", "#d64f4f"],
      ["Low", "low_pct", "#f28a74"],
      ["In Range", "in_range_pct", "#65c99a"],
      ["High", "high_pct", "#9f7ce0"],
      ["Very High", "very_high_pct", "#7858d9"]
    ].map(([name, key, color]) => ({
      name,
      type: "bar",
      stack: "range",
      data: rows.map((row) => row[key as keyof DailyRange] as number),
      itemStyle: { color }
    }))
  };
}

function basalCorrectionOption(rows: DashboardData["tidepool"]["basal_deviation"]["daily"]): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 50, right: 16, top: 24, bottom: 30 },
    xAxis: { type: "category", data: rows.map((row) => row.day.slice(5)) },
    yAxis: { type: "value", axisLabel: { formatter: "{value}U" } },
    series: [
      {
        name: "Extra Basal",
        type: "bar",
        data: rows.map((row) => row.extra_basal_units),
        itemStyle: { color: "#2399c8" }
      }
    ]
  };
}

function glucoseAverageOption(rows: DailyRange[]): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 44, right: 16, top: 24, bottom: 30 },
    xAxis: { type: "category", data: rows.map((row) => row.day.slice(5)) },
    yAxis: { type: "value" },
    series: [
      {
        name: "Avg CGM",
        type: "line",
        smooth: true,
        data: rows.map((row) => row.avg_glucose),
        markLine: { symbol: "none", data: [{ yAxis: 70 }, { yAxis: 180 }] },
        lineStyle: { color: "#278f68", width: 3 },
        itemStyle: { color: "#65c99a" }
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

function dayGlucoseOption(data: DashboardData, day: string): EChartsOption {
  const rows = data.tidepool.glucose_points.filter((row) => row.day === day);
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 44, right: 16, top: 24, bottom: 30 },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    visualMap: {
      show: false,
      dimension: 1,
      pieces: [
        { lt: 54, color: "#d64f4f" },
        { gt: 250, color: "#7858d9" },
        { gte: 54, lte: 250, color: "#278f68" }
      ]
    },
    series: [
      {
        name: "CGM",
        type: "line",
        data: rows.map((row) => [row.local_time, row.value]),
        markArea: { itemStyle: { color: "rgba(101,201,154,0.2)" }, data: [[{ yAxis: 70 }, { yAxis: 180 }]] },
        markLine: { symbol: "none", data: [{ yAxis: 70 }, { yAxis: 180 }] },
        lineStyle: { width: 3 },
        showSymbol: false
      }
    ]
  };
}

function dayRangeOption(row: DailyRange | undefined): EChartsOption {
  const buckets: Array<[string, number, string]> = [
    ["Very Low", row?.very_low_pct ?? 0, "#d64f4f"],
    ["Low", row?.low_pct ?? 0, "#f28a74"],
    ["In Range", row?.in_range_pct ?? 0, "#65c99a"],
    ["High", row?.high_pct ?? 0, "#9f7ce0"],
    ["Very High", row?.very_high_pct ?? 0, "#7858d9"]
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
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: [
      { left: 48, right: 16, top: 44, height: 160 },
      { left: 48, right: 16, top: 250, height: 90 }
    ],
    xAxis: [
      { type: "category", data: hourly.map((row) => row.hour), gridIndex: 0 },
      { type: "category", data: hourly.map((row) => row.hour), gridIndex: 1 }
    ],
    yAxis: [
      { type: "value", name: "U/hr", gridIndex: 0 },
      { type: "value", name: "Delta", gridIndex: 1 }
    ],
    series: [
      {
        name: "Delivered",
        type: "line",
        smooth: true,
        data: hourly.map((row) => row.delivered),
        lineStyle: { color: "#2399c8", width: 4 },
        itemStyle: { color: "#2399c8" },
        xAxisIndex: 0,
        yAxisIndex: 0
      },
      {
        name: "Programmed",
        type: "line",
        data: hourly.map((row) => row.programmed),
        lineStyle: { color: "#1f2937", width: 3 },
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
        xAxisIndex: 1,
        yAxisIndex: 1
      }
    ]
  };
}

function MealTable({ rows }: { rows: MealSummary[] }) {
  const windows: Record<string, string> = {
    breakfast: "5:00a-10:30a",
    lunch: "10:30a-3:30p",
    dinner: "3:30p-10:30p",
    "overnight/other": "10:30p-5:00a"
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
            <td>{row.date}</td>
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
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>iLet 30-day</th>
          <th>Twiist Avg</th>
          <th>Change</th>
          <th>Trend</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const iletValue = parseBaselineValue(row.ilet_30_day);
          const twiistValue = twiistMetricValue(row.metric, averages);
          const change = iletValue && twiistValue !== null ? ((twiistValue - iletValue) / iletValue) * 100 : null;
          const direction = change === null ? "flat" : change > 0 ? "increase" : change < 0 ? "decrease" : "flat";
          return (
            <tr key={row.metric}>
              <td>{row.metric}</td>
              <td>{row.ilet_30_day}</td>
              <td>{formatComparisonMetric(row.metric, twiistValue)}</td>
              <td>{change === null ? "--" : `${format(change, 0)}%`}</td>
              <td>
                <span className={`trend ${direction}`} aria-label={direction}>
                  {direction === "increase" ? "▲" : direction === "decrease" ? "▼" : "•"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeTab, setActiveTab] = useState<"summary" | "day" | "journal">("summary");
  const [periodLabel, setPeriodLabel] = useState("1 week");
  const [journalPeriodLabel, setJournalPeriodLabel] = useState("");
  const [day, setDay] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetchDashboard().then((payload) => {
      setData(payload);
      setPeriodLabel(payload.period_summaries[0]?.label || "1 week");
      setDay(payload.tidepool.daily_ranges[payload.tidepool.daily_ranges.length - 1]?.day || "");
    }).catch((error) => setStatus(error.message));
  }, []);

  const period = data?.period_summaries.find((item) => item.label === periodLabel);
  const days = data && period ? periodDays(period, data.tidepool.daily_ranges) : [];
  const dailyRanges = data?.tidepool.daily_ranges.filter((row) => days.includes(row.day)) || [];
  const dailyBasal = data?.tidepool.basal_deviation.daily.filter((row) => days.includes(row.day)) || [];
  const selectedDayRange = data?.tidepool.daily_ranges.find((row) => row.day === day);
  const selectedDayBasal = data?.tidepool.basal_deviation.daily.find((row) => row.day === day);
  const selectedDayInsulin = data?.tidepool.daily_insulin.find((row) => row.day === day);
  const selectedDayFood = data?.tidepool.daily_food.find((row) => row.day === day);
  const mealRows = data?.meal_analysis.periods[periodLabel] || [];
  const selectedDayMeals = data?.meal_analysis.events.filter((row) => row.date === day) || [];
  const periodMealBurden = averageNumeric(mealRows, (row) => row.burden_score);
  const periodRecovery = averageNumeric(mealRows, (row) => row.recovery_minutes_4h);
  const periodAreaOver180 = averageNumeric(mealRows, (row) => row.area_over_180_4h);
  const periodLowRisk = averageNumeric(mealRows, (row) => row.low_after_correction_pct);
  const dayMealBurden = averageNumeric(selectedDayMeals, (row) => row.burden_score);
  const dayAreaOver180 = averageNumeric(selectedDayMeals, (row) => row.area_over_180_4h);
  const dayRecovery = averageNumeric(selectedDayMeals, (row) => row.recovery_minutes_4h);
  const dayLowAfterCorrection = selectedDayMeals.filter((row) => row.low_after_correction).length;
  const journalPeriod = data?.period_summaries.find((item) => item.label === journalPeriodLabel);
  const journalRows = useMemo(() => {
    if (!data) return [];
    const rows = [...data.log.daily].sort((a, b) => b.date.localeCompare(a.date));
    if (!journalPeriod) return rows.slice(0, 200);
    return rows.filter((row) => row.date >= journalPeriod.start && row.date <= journalPeriod.end);
  }, [data, journalPeriod]);
  const journalStats = useMemo(() => journalAverages(journalRows), [journalRows]);

  async function onImport(file: File | null) {
    if (!file) return;
    setStatus("Importing...");
    try {
      const payload = await importTidepoolExport(file);
      setData(payload);
      setStatus(`Imported ${file.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  if (!data) {
    return <main className="loading">Loading dashboard... {status}</main>;
  }

  return (
    <div>
      <header className="app-header">
        <div>
          <h1>Twiist Tidepool Dashboard</h1>
          <p>{data.tidepool.daily_ranges.length} days · {data.tidepool.totals.readings} CGM readings</p>
        </div>
        <div className="header-actions">
          <label className="import-button">
            Import Tidepool JSON
            <input type="file" accept=".json,application/json" onChange={(event) => onImport(event.target.files?.[0] || null)} />
          </label>
          {activeTab === "summary" && (
            <select value={periodLabel} onChange={(event) => setPeriodLabel(event.target.value)}>
              {data.period_summaries.map((item) => <option key={item.label}>{item.label}</option>)}
            </select>
          )}
          {activeTab === "journal" && (
            <select value={journalPeriodLabel} onChange={(event) => setJournalPeriodLabel(event.target.value)}>
              <option value="">Latest 200 days</option>
              {data.period_summaries.map((item) => <option key={item.label}>{item.label}</option>)}
            </select>
          )}
          {activeTab === "day" && (
            <select value={day} onChange={(event) => setDay(event.target.value)}>
              {data.tidepool.daily_ranges.map((row) => <option key={row.day}>{row.day}</option>)}
            </select>
          )}
        </div>
      </header>

      {status && <div className="status">{status}</div>}

      <main>
        <nav className="tabs">
          <button className={activeTab === "summary" ? "active" : ""} onClick={() => setActiveTab("summary")}>Summary</button>
          <button className={activeTab === "day" ? "active" : ""} onClick={() => setActiveTab("day")}>Day Detail</button>
          <button className={activeTab === "journal" ? "active" : ""} onClick={() => setActiveTab("journal")}>Journal</button>
        </nav>

        {activeTab === "summary" && period && (
          <section className="grid">
            <article className="panel full">
              <h2>{period.label} Summary</h2>
              <p>{period.start} to {period.end} · {period.days_available}/{period.days_requested} days available</p>
              <div className="metric-grid">
                <div><span>Avg CGM</span><strong>{format(period.avg_glucose, 0)}</strong></div>
                <div><span>Time In Range</span><strong>{format(period.time_in_range_pct, 0)}%</strong></div>
                <div><span>Extra Basal</span><strong>{format(period.extra_basal_units, 1)}U</strong></div>
                <div><span>Extra / Day</span><strong>{format(period.extra_basal_per_day, 1)}U</strong></div>
                <div><span>Correction Load</span><strong>{format(period.correction_load_pct_tdi, 0)}%</strong></div>
                <div><span>Bolus/g</span><strong>{format(period.bolus_per_carb, 3)}</strong></div>
                <div><span>Meal Burden</span><strong>{format(periodMealBurden, 1)}</strong></div>
                <div><span>Avg Recovery</span><strong>{minutesLabel(periodRecovery)}</strong></div>
                <div><span>Area &gt;180</span><strong>{format(periodAreaOver180, 1)}</strong></div>
                <div><span>Low Risk</span><strong>{format(periodLowRisk, 0)}%</strong></div>
              </div>
            </article>
            <article className="panel full">
              <h2>Hourly Basal Rate Profile</h2>
              <p>Average delivered basal vs configured profile, plus delivered-minus-configured by hour.</p>
              <EChart option={hourlyRateOption(data.tidepool.basal_deviation.hourly, days)} height={380} />
            </article>
            <article className="panel">
              <h2>Basal Correction Load</h2>
              <EChart option={basalCorrectionOption(dailyBasal)} height={280} />
            </article>
            <article className="panel">
              <h2>Glucose Trend</h2>
              <EChart option={glucoseAverageOption(dailyRanges)} height={280} />
            </article>
            <article className="panel full">
              <h2>Daily Time In Range</h2>
              <EChart option={rangeOption(dailyRanges)} height={320} />
            </article>
            <article className="panel full">
              <h2>Meal Window Analysis</h2>
              <p>Clustered meals, 4-hour glucose response, recovery after crossing above 180 mg/dL, and post-meal basal correction load.</p>
              <div className="window-breakdown">
                <span><strong>Breakfast</strong> 5:00a-10:30a</span>
                <span><strong>Lunch</strong> 10:30a-3:30p</span>
                <span><strong>Dinner</strong> 3:30p-10:30p</span>
                <span><strong>Overnight/Other</strong> 10:30p-5:00a</span>
              </div>
              <MealTable rows={mealRows} />
            </article>
          </section>
        )}

        {activeTab === "day" && (
          <section className="grid">
            <article className="panel full">
              <h2>{day} Metrics</h2>
              <div className="metric-grid">
                <div><span>Avg CGM</span><strong>{format(selectedDayRange?.avg_glucose, 0)}</strong></div>
                <div><span>Time In Range</span><strong>{format(selectedDayRange?.in_range_pct, 0)}%</strong></div>
                <div><span>Total Insulin</span><strong>{format(selectedDayInsulin?.total_units, 1)}U</strong></div>
                <div><span>Carbs</span><strong>{format(selectedDayFood?.carbs, 0)}g</strong></div>
                <div><span>Std Dev</span><strong>{format(selectedDayRange?.stddev_glucose, 0)}</strong></div>
                <div><span>CV</span><strong>{format(selectedDayRange?.cv_pct, 0)}%</strong></div>
                <div><span>Extra Basal</span><strong>{format(selectedDayBasal?.extra_basal_units, 1)}U</strong></div>
                <div><span>Net Basal</span><strong>{format(selectedDayBasal?.net_deviation_units, 1)}U</strong></div>
                <div><span>Meal Burden</span><strong>{format(dayMealBurden, 1)}</strong></div>
                <div><span>Meal Recovery</span><strong>{minutesLabel(dayRecovery)}</strong></div>
                <div><span>Area &gt;180</span><strong>{format(dayAreaOver180, 1)}</strong></div>
                <div><span>Low After High</span><strong>{dayLowAfterCorrection}</strong></div>
              </div>
            </article>
            <article className="panel full">
              <h2>Selected Day Glucose Trend</h2>
              <EChart option={dayGlucoseOption(data, day)} height={320} />
            </article>
            <article className="panel full">
              <h2>Selected Day Basal Rate Profile</h2>
              <p>Delivered basal rate by hour compared with the programmed basal profile, plus delivered-minus-programmed delta.</p>
              <EChart option={dayBasalRateOption(data.tidepool.basal_deviation.hourly, day)} height={380} />
            </article>
            <article className="panel">
              <h2>Selected Day Ranges</h2>
              <p>CGM readings split into Tidepool-style glucose buckets.</p>
              <EChart option={dayRangeOption(selectedDayRange)} height={280} />
            </article>
            <article className="panel">
              <h2>Insulin & Carbs</h2>
              <p>Basal and bolus from Tidepool daily totals, with carbs from food entries.</p>
              <EChart option={insulinCarbOption(selectedDayInsulin, selectedDayFood)} height={280} />
            </article>
            <article className="panel full">
              <h2>Hourly Basal Deviation</h2>
              <p>Net delivered basal minus configured basal for each local hour.</p>
              <EChart option={hourlyDeviationHeatmapOption(data.tidepool.basal_deviation.hourly, day)} height={240} />
            </article>
            <article className="panel full">
              <h2>Selected Day Meal Impact</h2>
              <p>Meal windows ranked with post-meal glucose burden, basal correction load, recovery, and low-after-high risk.</p>
              <MealEventTable rows={selectedDayMeals} />
            </article>
          </section>
        )}

        {activeTab === "journal" && (
          <section className="grid">
            <article className="panel full">
              <h2>Journal Averages</h2>
              <p>
                {journalPeriod
                  ? `${journalPeriod.start} to ${journalPeriod.end} · ${journalStats.days} days`
                  : `Latest ${journalStats.days} journal days`}
              </p>
              <div className="metric-grid">
                <div><span>Avg Daily Insulin</span><strong>{format(journalStats.total, 1)}U</strong></div>
                <div><span>Avg Basal</span><strong>{format(journalStats.basal, 1)}U</strong></div>
                <div><span>Avg Bolus</span><strong>{format(journalStats.bolus, 1)}U</strong></div>
                <div><span>Avg Carbs</span><strong>{format(journalStats.carbs, 0)}g</strong></div>
                <div><span>Avg BG</span><strong>{format(journalStats.avgBg, 0)}</strong></div>
                <div><span>Basal %</span><strong>{format(journalStats.basalPct, 0)}%</strong></div>
                <div><span>Bolus %</span><strong>{format(journalStats.bolusPct, 0)}%</strong></div>
                <div><span>Bolus/g</span><strong>{format(journalStats.bolusPerCarb, 3)}</strong></div>
                <div><span>Carbs/U</span><strong>{format(journalStats.carbsPerBolus, 1)}</strong></div>
                <div><span>GMI</span><strong>{format(journalStats.gmi, 2)}%</strong></div>
              </div>
            </article>
            <article className="panel full">
              <h2>iLet 30-Day Baseline vs Twiist</h2>
              <p>Twiist averages are calculated from the selected Journal grouping and compared against the CSV iLet baseline.</p>
              <BaselineComparisonTable rows={data.log.baseline} averages={journalStats} />
            </article>
            <article className="panel full">
              <h2>Journal Summary</h2>
              <p>
                {journalPeriod
                  ? `${journalPeriod.start} to ${journalPeriod.end}`
                  : "Latest 200 days from the CSV journal"}
              </p>
              <JournalTable rows={journalRows} />
            </article>
          </section>
        )}

        <MetricDefinitions />
      </main>
    </div>
  );
}
