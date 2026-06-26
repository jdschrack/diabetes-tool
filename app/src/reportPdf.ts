import { jsPDF } from "jspdf";
import type { DashboardData, DailyRange, MealSummary } from "./api/types";

type ActiveReportTab = "today" | "summary" | "journal";

type JournalStats = {
  days: number;
  carbs: number | null;
  total: number | null;
  basal: number | null;
  bolus: number | null;
  avgBg: number | null;
  basalPct: number | null;
  bolusPct: number | null;
  bolusPerCarb: number | null;
  carbsPerBolus: number | null;
  gmi: number | null;
};

export type PdfReportPayload = {
  tab: ActiveReportTab;
  title: string;
  subtitle: string;
  filename: string;
  today?: {
    range: DailyRange | undefined;
    insulin: DashboardData["tidepool"]["daily_insulin"][number] | undefined;
    food: DashboardData["tidepool"]["daily_food"][number] | undefined;
    basal: DashboardData["tidepool"]["basal_deviation"]["daily"][number] | undefined;
    glucose: DashboardData["tidepool"]["glucose_points"];
    meals: DashboardData["meal_analysis"]["events"];
    mealRows: MealSummary[];
    events: DashboardData["tidepool"]["daily_events"];
  };
  summary?: {
    days: string[];
    ranges: DailyRange[];
    basal: DashboardData["tidepool"]["basal_deviation"]["daily"];
    basalHourly: DashboardData["tidepool"]["basal_deviation"]["hourly"];
    insulin: DashboardData["tidepool"]["daily_insulin"];
    food: DashboardData["tidepool"]["daily_food"];
    mealRows: MealSummary[];
    mealEvents: DashboardData["meal_analysis"]["events"];
    metrics: Array<[string, string, string, string]>;
  };
  journal?: {
    rows: DashboardData["log"]["daily"];
    stats: JournalStats;
    previousStats: JournalStats;
    baseline: DashboardData["log"]["baseline"];
  };
};

const page = { width: 612, height: 792, margin: 34 };
const colors = {
  ink: "#172033",
  muted: "#657186",
  line: "#dfe6ef",
  soft: "#f7fafc",
  panel: "#fffdf9",
  blue: "#2f80ed",
  deepBlue: "#1f4f8f",
  green: "#14905d",
  amber: "#f59e0b",
  amberDark: "#d97706",
  violet: "#7c5ce7",
  red: "#d64f4f"
};

const mealMeta: Record<string, { label: string; window: string; color: string; soft: string }> = {
  breakfast: { label: "Breakfast", window: "Morning window", color: colors.blue, soft: "#eaf3ff" },
  lunch: { label: "Lunch", window: "Midday window", color: colors.green, soft: "#e9f7ef" },
  dinner: { label: "Dinner", window: "Evening window", color: colors.amber, soft: "#fff7e6" },
  overnight: { label: "Overnight", window: "Late / sleep window", color: colors.violet, soft: "#f1edff" }
};

function fmt(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined || Number.isNaN(value) ? "--" : value.toFixed(digits).replace(/\.0$/, "");
}

function minutes(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return hours ? `${hours}h ${mins}m` : `${mins}m`;
}

function moneySafe(text: string) {
  return text.replace(/\u00b7/g, "-");
}

function addFooter(doc: jsPDF, pageNumber: number) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(colors.muted);
  doc.text(`SignalWell report - page ${pageNumber}`, page.margin, page.height - 18);
}

function addPage(doc: jsPDF, pageNumber: number) {
  if (pageNumber > 1) doc.addPage();
  addFooter(doc, pageNumber);
  return page.margin;
}

function drawHeader(doc: jsPDF, payload: PdfReportPayload, y: number) {
  doc.setFillColor(colors.deepBlue);
  doc.roundedRect(page.margin, y, page.width - page.margin * 2, 58, 7, 7, "F");
  doc.setTextColor("#ffffff");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(moneySafe(payload.title), page.margin + 18, y + 23);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(moneySafe(payload.subtitle), page.margin + 18, y + 40);
  doc.setFontSize(8);
  doc.text(`Generated ${new Date().toLocaleString()}`, page.width - page.margin - 18, y + 40, { align: "right" });
  return y + 76;
}

function drawCard(doc: jsPDF, x: number, y: number, w: number, h: number, label: string, value: string, context: string, color: string) {
  doc.setFillColor("#ffffff");
  doc.setDrawColor(colors.line);
  doc.roundedRect(x, y, w, h, 6, 6, "FD");
  doc.setFillColor(color);
  doc.roundedRect(x + 10, y + 10, 5, h - 20, 2, 2, "F");
  doc.setTextColor(colors.muted);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text(label, x + 22, y + 16);
  doc.setTextColor(colors.ink);
  doc.setFontSize(17);
  doc.text(value, x + 22, y + 36);
  doc.setTextColor(colors.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.text(context, x + 22, y + 50, { maxWidth: w - 30 });
}

function drawCards(doc: jsPDF, y: number, cards: Array<[string, string, string, string]>) {
  const gap = 10;
  const w = (page.width - page.margin * 2 - gap * 3) / 4;
  const h = 64;
  cards.forEach((card, index) => {
    const x = page.margin + (index % 4) * (w + gap);
    const rowY = y + Math.floor(index / 4) * (h + gap);
    drawCard(doc, x, rowY, w, h, card[0], card[1], card[2], card[3]);
  });
  return y + Math.ceil(cards.length / 4) * (h + gap);
}

function drawSectionTitle(doc: jsPDF, y: number, title: string, subtitle?: string) {
  doc.setTextColor(colors.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(title, page.margin, y);
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(colors.muted);
    doc.text(subtitle, page.margin, y + 12, { maxWidth: page.width - page.margin * 2 });
    return y + 22;
  }
  return y + 12;
}

function drawLineChart(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  points: Array<{ label: string; value: number | null | undefined }>,
  options: { min?: number; max?: number; color?: string; thresholdLow?: number; thresholdHigh?: number } = {}
) {
  const values = points.map((point) => point.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  doc.setFillColor("#ffffff");
  doc.setDrawColor(colors.line);
  doc.roundedRect(x, y, w, h, 6, 6, "FD");
  if (values.length < 2) {
    doc.setTextColor(colors.muted);
    doc.setFontSize(9);
    doc.text("Not enough data", x + 12, y + h / 2);
    return;
  }
  const min = options.min ?? Math.min(...values);
  const max = options.max ?? Math.max(...values);
  const spread = max - min || 1;
  const chart = { x: x + 16, y: y + 12, w: w - 28, h: h - 28 };
  if (options.thresholdLow !== undefined && options.thresholdHigh !== undefined) {
    const highY = chart.y + chart.h - ((options.thresholdHigh - min) / spread) * chart.h;
    const lowY = chart.y + chart.h - ((options.thresholdLow - min) / spread) * chart.h;
    doc.setFillColor("#e9f7ef");
    doc.rect(chart.x, Math.max(chart.y, highY), chart.w, Math.max(0, lowY - highY), "F");
  }
  doc.setDrawColor("#eef2f6");
  for (let i = 0; i < 4; i += 1) {
    const gy = chart.y + (chart.h / 3) * i;
    doc.line(chart.x, gy, chart.x + chart.w, gy);
  }
  const coords = points
    .map((point, index) => {
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) return null;
      return {
        x: chart.x + (index / Math.max(1, points.length - 1)) * chart.w,
        y: chart.y + chart.h - ((point.value - min) / spread) * chart.h,
        value: point.value
      };
    })
    .filter((point): point is { x: number; y: number; value: number } => point !== null);
  doc.setDrawColor(options.color || colors.green);
  doc.setLineWidth(1.8);
  coords.forEach((point, index) => {
    if (index === 0) return;
    const previous = coords[index - 1];
    doc.line(previous.x, previous.y, point.x, point.y);
  });
  doc.setLineWidth(0.2);
  doc.setTextColor(colors.muted);
  doc.setFontSize(7);
  doc.text(fmt(max, 0), x + w - 18, chart.y + 2, { align: "right" });
  doc.text(fmt(min, 0), x + w - 18, chart.y + chart.h, { align: "right" });
}

function drawBars(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  points: Array<{ label: string; value: number | null | undefined }>,
  options: { color?: string; min?: number; max?: number; suffix?: string } = {}
) {
  const values = points.map((point) => point.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  doc.setFillColor("#ffffff");
  doc.setDrawColor(colors.line);
  doc.roundedRect(x, y, w, h, 6, 6, "FD");
  if (!values.length) {
    doc.setTextColor(colors.muted);
    doc.setFontSize(9);
    doc.text("Not enough data", x + 12, y + h / 2);
    return;
  }
  const min = options.min ?? 0;
  const max = options.max ?? Math.max(...values, 1);
  const spread = max - min || 1;
  const chart = { x: x + 18, y: y + 16, w: w - 38, h: h - 38 };
  doc.setDrawColor("#eef2f6");
  for (let i = 0; i < 4; i += 1) {
    const gy = chart.y + (chart.h / 3) * i;
    doc.line(chart.x, gy, chart.x + chart.w, gy);
  }
  const gap = Math.max(2, chart.w / Math.max(points.length, 1) * 0.22);
  const barW = Math.max(3, chart.w / Math.max(points.length, 1) - gap);
  points.forEach((point, index) => {
    const value = typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
    if (value === null) return;
    const barH = Math.max(2, ((value - min) / spread) * chart.h);
    const bx = chart.x + index * (barW + gap);
    const by = chart.y + chart.h - barH;
    doc.setFillColor(options.color || colors.violet);
    doc.roundedRect(bx, by, barW, barH, 2, 2, "F");
  });
  doc.setTextColor(colors.muted);
  doc.setFontSize(7);
  doc.text(`${fmt(max, 0)}${options.suffix || ""}`, x + w - 12, chart.y + 2, { align: "right" });
  doc.text(`${fmt(min, 0)}${options.suffix || ""}`, x + w - 12, chart.y + chart.h, { align: "right" });
}

function drawDualLineChart(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  delivered: Array<{ label: string; value: number | null | undefined }>,
  scheduled: Array<{ label: string; value: number | null | undefined }>
) {
  const values = [...delivered, ...scheduled]
    .map((point) => point.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const max = Math.max(1, ...values);
  drawLineChart(doc, x, y, w, h, delivered, { min: 0, max, color: colors.deepBlue });
  const chart = { x: x + 16, y: y + 12, w: w - 28, h: h - 28 };
  const spread = max || 1;
  const coords = scheduled
    .map((point, index) => {
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) return null;
      return {
        x: chart.x + (index / Math.max(1, scheduled.length - 1)) * chart.w,
        y: chart.y + chart.h - (point.value / spread) * chart.h
      };
    })
    .filter((point): point is { x: number; y: number } => point !== null);
  doc.setDrawColor(colors.amber);
  doc.setLineWidth(1.4);
  coords.forEach((point, index) => {
    if (index === 0) return;
    const previous = coords[index - 1];
    doc.line(previous.x, previous.y, point.x, point.y);
  });
  doc.setLineWidth(0.2);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(colors.deepBlue);
  doc.text("Delivered", x + 14, y + 14);
  doc.setTextColor(colors.amberDark);
  doc.text("Scheduled", x + 72, y + 14);
}

function drawTimeInRangeBoard(doc: jsPDF, y: number, ranges: DailyRange[], maxRows = 14) {
  const rows = ranges.slice(-maxRows);
  const x = page.margin;
  const usable = page.width - page.margin * 2;
  const labelW = 48;
  const barW = usable - labelW - 8;
  const rowH = 17;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  rows.forEach((row, index) => {
    const rowY = y + index * rowH;
    doc.setTextColor(colors.muted);
    doc.text(row.day.slice(5), x, rowY + 10);
    let bx = x + labelW;
    const buckets: Array<[number, string]> = [
      [row.very_low_pct, colors.red],
      [row.low_pct, "#f28a74"],
      [row.in_range_pct, "#65c99a"],
      [row.high_pct, colors.amber],
      [row.very_high_pct, colors.amberDark]
    ];
    buckets.forEach(([pct, color], bucketIndex) => {
      const bw = Math.max(0, (pct / 100) * barW);
      doc.setFillColor(color);
      doc.roundedRect(bx, rowY, bw, 10, bucketIndex === 0 ? 2 : 0, bucketIndex === buckets.length - 1 ? 2 : 0, "F");
      bx += bw;
    });
    doc.setTextColor(colors.ink);
    doc.text(`${fmt(row.in_range_pct, 0)}%`, x + usable, rowY + 10, { align: "right" });
  });
  doc.setTextColor(colors.muted);
  doc.setFontSize(7);
  doc.text("Low", x + labelW, y + rows.length * rowH + 10);
  doc.text("In range", x + labelW + 78, y + rows.length * rowH + 10);
  doc.text("High", x + labelW + 168, y + rows.length * rowH + 10);
  return y + rows.length * rowH + 24;
}

function drawTable(doc: jsPDF, y: number, headers: string[], rows: string[][], widths: number[], maxRows = 12) {
  const x = page.margin;
  const usable = page.width - page.margin * 2;
  const rowH = 18;
  const tableRows = rows.slice(0, maxRows);
  doc.setFillColor(colors.soft);
  doc.setDrawColor(colors.line);
  doc.roundedRect(x, y, usable, rowH, 4, 4, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(colors.ink);
  let cursor = x + 8;
  headers.forEach((header, index) => {
    doc.text(header, cursor, y + 12, { maxWidth: widths[index] - 6 });
    cursor += widths[index];
  });
  doc.setFont("helvetica", "normal");
  tableRows.forEach((row, rowIndex) => {
    const rowY = y + rowH * (rowIndex + 1);
    doc.setDrawColor(colors.line);
    doc.line(x, rowY, x + usable, rowY);
    cursor = x + 8;
    row.forEach((cell, index) => {
      doc.setTextColor(index === 0 ? colors.ink : colors.muted);
      doc.text(moneySafe(cell), cursor, rowY + 12, { maxWidth: widths[index] - 6 });
      cursor += widths[index];
    });
  });
  if (rows.length > maxRows) {
    doc.setTextColor(colors.muted);
    doc.setFontSize(7);
    doc.text(`Showing ${maxRows} of ${rows.length} rows`, x, y + rowH * (tableRows.length + 1) + 14);
  }
  return y + rowH * (tableRows.length + 1) + 24;
}

function average(values: Array<number | null | undefined>) {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numeric.length ? numeric.reduce((total, value) => total + value, 0) / numeric.length : null;
}

function patternRows(summary: NonNullable<PdfReportPayload["summary"]>) {
  const byMeal = new Map(summary.mealRows.map((row) => [row.meal, row]));
  return Object.entries(mealMeta).map(([meal, meta]) => {
    const row = byMeal.get(meal);
    const events = summary.mealEvents.filter((event) => event.meal === meal);
    return {
      meal,
      meta,
      row,
      events,
      avgCarbs: average(events.map((event) => event.carbs)),
      avgBolus: average(events.map((event) => event.bolus)),
      sustainedEvents: events.filter((event) => event.sustained_over_250_2h).length
    };
  });
}

function todayReport(doc: jsPDF, payload: PdfReportPayload) {
  const today = payload.today;
  if (!today) return;
  let y = addPage(doc, 1);
  y = drawHeader(doc, payload, y);
  y = drawCards(doc, y, [
    ["Time In Range", `${fmt(today.range?.in_range_pct, 0)}%`, "70-180 mg/dL", colors.green],
    ["Avg Glucose", `${fmt(today.range?.avg_glucose, 0)} mg/dL`, `CV ${fmt(today.range?.cv_pct, 0)}%`, colors.blue],
    ["Total Carbs", `${fmt(today.food?.carbs, 0)}g`, `${today.food?.meals || 0} meal entries`, colors.amber],
    ["Total Insulin", `${fmt(today.insulin?.total_units, 1)}U`, `Basal ${fmt(today.insulin?.basal_units, 1)}U`, colors.deepBlue],
    ["Extra Basal", `${fmt(today.basal?.extra_basal_units, 2)}U`, "Above programmed basal", colors.violet],
    ["Events", `${today.events.length}`, "Exercise and notes", colors.green],
    ["Meals", `${today.meals.length}`, "Tidepool meal clusters", colors.amber],
    ["Data Coverage", `${fmt(today.range ? Math.min(100, (today.range.readings / 288) * 100) : null, 0)}%`, `${today.range?.readings || 0} CGM readings`, colors.blue]
  ]);
  y += 4;
  y = drawSectionTitle(doc, y, "Glucose Trend", "Selected-day CGM with in-range band.");
  drawLineChart(
    doc,
    page.margin,
    y,
    page.width - page.margin * 2,
    170,
    today.glucose.map((row) => ({ label: row.local_time.slice(11, 16), value: row.value })),
    { min: 40, max: Math.max(260, ...today.glucose.map((row) => row.value)), thresholdLow: 70, thresholdHigh: 180, color: colors.green }
  );
  y += 192;
  y = drawSectionTitle(doc, y, "Meal Impact Review", "Rows flagged when glucose remains above 250 mg/dL for at least two hours.");
  drawTable(
    doc,
    y,
    ["Time", "Meal", "Carbs", "Bolus", ">250", "Review g/U", "Carb Gap", "Peak", "Recovery"],
    today.meals.map((row) => [
      row.start.slice(11, 16),
      row.meal,
      `${fmt(row.carbs, 0)}g`,
      `${fmt(row.bolus, 2)}U`,
      row.sustained_over_250_2h ? minutes(row.minutes_over_250_4h) : "No",
      row.sustained_over_250_2h ? fmt(row.review_carbs_per_unit, 1) : "--",
      row.sustained_over_250_2h ? `${fmt(row.estimated_missing_carbs, 0)}g` : "--",
      fmt(row.peak_4h, 0),
      minutes(row.recovery_minutes_4h)
    ]),
    [42, 56, 48, 48, 54, 62, 58, 42, 64],
    10
  );
}

function summaryReport(doc: jsPDF, payload: PdfReportPayload) {
  const summary = payload.summary;
  if (!summary) return;
  let y = addPage(doc, 1);
  y = drawHeader(doc, payload, y);
  y = drawCards(doc, y, summary.metrics);
  y = drawSectionTitle(doc, y + 4, "Daily CGM Trend", "Average glucose by day in the selected range.");
  drawLineChart(
    doc,
    page.margin,
    y,
    page.width - page.margin * 2,
    145,
    summary.ranges.map((row) => ({ label: row.day.slice(5), value: row.avg_glucose })),
    { min: 60, max: Math.max(260, ...summary.ranges.map((row) => row.avg_glucose)), thresholdLow: 70, thresholdHigh: 180, color: colors.blue }
  );
  y += 164;

  const hourly = Array.from({ length: 24 }, (_unused, hour) => {
    const rows = summary.basalHourly.filter((row) => summary.days.includes(row.day) && row.hour_of_day === hour);
    return {
      hour,
      delivered: average(rows.map((row) => row.delivered_units)),
      scheduled: average(rows.map((row) => row.scheduled_units)),
      net: average(rows.map((row) => row.net_deviation_units))
    };
  });
  y = drawSectionTitle(doc, y, "Basal Profile", "Average delivered basal compared with configured basal profile by hour.");
  drawDualLineChart(
    doc,
    page.margin,
    y,
    page.width - page.margin * 2,
    128,
    hourly.map((row) => ({ label: `${row.hour}`, value: row.delivered })),
    hourly.map((row) => ({ label: `${row.hour}`, value: row.scheduled }))
  );
  y += 150;
  y = drawSectionTitle(doc, y, "Correction Load", "Daily extra basal used as pump-driven correction signal.");
  drawBars(
    doc,
    page.margin,
    y,
    page.width - page.margin * 2,
    112,
    summary.basal.map((row) => ({ label: row.day.slice(5), value: row.extra_basal_units })),
    { color: colors.violet, min: 0, suffix: "U" }
  );
  y += 134;

  y = addPage(doc, 2);
  y = drawHeader(doc, payload, y);
  y = drawSectionTitle(doc, y, "Daily Time In Range", "Tidepool-style glucose buckets for each selected day.");
  y = drawTimeInRangeBoard(doc, y, summary.ranges, 18);
  y = drawSectionTitle(doc, y + 8, "Time In Range Detail", "Daily range percentages and average glucose.");
  y = drawTable(
    doc,
    y,
    ["Date", "Very Low", "Low", "In Range", "High", "Very High", "Avg CGM", "CV"],
    summary.ranges.map((row) => [
      row.day,
      `${fmt(row.very_low_pct, 0)}%`,
      `${fmt(row.low_pct, 0)}%`,
      `${fmt(row.in_range_pct, 0)}%`,
      `${fmt(row.high_pct, 0)}%`,
      `${fmt(row.very_high_pct, 0)}%`,
      fmt(row.avg_glucose, 0),
      `${fmt(row.cv_pct, 0)}%`
    ]),
    [72, 56, 44, 68, 48, 62, 58, 44],
    14
  );
  y = drawSectionTitle(doc, y, "Basal Profile Detail", "Hourly delivered, scheduled, and net basal deviation.");
  drawTable(
    doc,
    y,
    ["Hour", "Delivered", "Scheduled", "Net Delta"],
    hourly.map((row) => [
      `${String(row.hour).padStart(2, "0")}:00`,
      `${fmt(row.delivered, 2)}U`,
      `${fmt(row.scheduled, 2)}U`,
      `${fmt(row.net, 2)}U`
    ]),
    [92, 128, 128, 128],
    10
  );

  y = addPage(doc, 3);
  y = drawHeader(doc, payload, y);
  y = drawSectionTitle(doc, y, "Pattern Board", "Meal-window signals for ratio review, missed-carb suspicion, recovery, and correction burden.");
  const cards = patternRows(summary);
  const gap = 10;
  const cardW = (page.width - page.margin * 2 - gap) / 2;
  const cardH = 124;
  cards.forEach((card, index) => {
    const x = page.margin + (index % 2) * (cardW + gap);
    const cardY = y + Math.floor(index / 2) * (cardH + gap);
    doc.setFillColor(card.meta.soft);
    doc.setDrawColor(colors.line);
    doc.roundedRect(x, cardY, cardW, cardH, 7, 7, "FD");
    doc.setFillColor(card.meta.color);
    doc.circle(x + 14, cardY + 16, 4, "F");
    doc.setTextColor(colors.ink);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(card.meta.label, x + 24, cardY + 18);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(colors.muted);
    doc.text(card.meta.window, x + cardW - 12, cardY + 18, { align: "right" });
    const lines: Array<[string, string]> = [
      ["Meal count", `${card.events.length}`],
      ["Avg carbs / bolus", `${fmt(card.avgCarbs, 0)}g / ${fmt(card.avgBolus, 1)}U`],
      ["Recovery", minutes(card.row?.recovery_minutes_4h)],
      ["Extra basal", `${fmt(card.row?.extra_basal_4h, 2)}U`],
      ["Observed sensitivity", `${fmt(card.row?.observed_sensitivity, 0)} mg/dL/U`],
      ["Sustained >250", `${card.sustainedEvents}`],
      ["Burden score", fmt(card.row?.burden_score, 0)]
    ];
    lines.forEach(([label, value], lineIndex) => {
      const lineY = cardY + 38 + lineIndex * 11;
      doc.setTextColor(colors.muted);
      doc.text(label, x + 14, lineY);
      doc.setTextColor(colors.ink);
      doc.setFont("helvetica", "bold");
      doc.text(value, x + cardW - 12, lineY, { align: "right" });
      doc.setFont("helvetica", "normal");
    });
  });
  y += Math.ceil(cards.length / 2) * (cardH + gap) + 10;
  y = drawSectionTitle(doc, y, "Meal Window Analysis", "Clustered meals, 4-hour response, correction load, and missed-carb review signals.");
  drawTable(
    doc,
    y,
    ["Meal", "Meals", "Carbs/U", "Peak", "% >180", "Recovery", "Extra Basal", "Burden", "Low Risk"],
    summary.mealRows.map((row) => [
      row.meal,
      `${row.meals}`,
      fmt(row.carbs_per_bolus, 1),
      fmt(row.peak_4h, 0),
      `${fmt(row.pct_high_4h, 0)}%`,
      minutes(row.recovery_minutes_4h),
      `${fmt(row.extra_basal_4h, 2)}U`,
      fmt(row.burden_score, 1),
      `${fmt(row.low_after_correction_pct, 0)}%`
    ]),
    [60, 38, 52, 42, 48, 58, 62, 48, 50],
    8
  );
}

function journalReport(doc: jsPDF, payload: PdfReportPayload) {
  const journal = payload.journal;
  if (!journal) return;
  let y = addPage(doc, 1);
  y = drawHeader(doc, payload, y);
  y = drawCards(doc, y, [
    ["Avg Daily Insulin", `${fmt(journal.stats.total, 1)}U`, `${journal.stats.days} days`, colors.deepBlue],
    ["Avg Basal", `${fmt(journal.stats.basal, 1)}U`, `${fmt(journal.stats.basalPct, 0)}% of TDD`, colors.blue],
    ["Avg Bolus", `${fmt(journal.stats.bolus, 1)}U`, `${fmt(journal.stats.bolusPct, 0)}% of TDD`, colors.violet],
    ["Avg Carbs", `${fmt(journal.stats.carbs, 0)}g`, "Daily journal carbs", colors.green],
    ["Avg BG", fmt(journal.stats.avgBg, 0), "Journal average BG", colors.green],
    ["Bolus/g", fmt(journal.stats.bolusPerCarb, 3), "Insulin per carb gram", colors.amber],
    ["Carbs/U", fmt(journal.stats.carbsPerBolus, 1), "Carbs per bolus unit", colors.amber],
    ["GMI", `${fmt(journal.stats.gmi, 2)}%`, "From avg glucose", colors.red]
  ]);
  y = drawSectionTitle(doc, y + 4, "Journal Trend", "Daily insulin and carbohydrate log values.");
  drawLineChart(
    doc,
    page.margin,
    y,
    page.width - page.margin * 2,
    130,
    journal.rows.slice().reverse().map((row) => ({ label: row.date.slice(5), value: row.total })),
    { min: 0, color: colors.deepBlue }
  );
  y += 152;
  y = drawSectionTitle(doc, y, "Baseline Comparison", "Selected Journal range compared with the saved iLet baseline rows.");
  y = drawTable(
    doc,
    y,
    ["Metric", "iLet baseline", "Twiist average", "Logged change"],
    journal.baseline.map((row) => [row.metric, row.ilet_30_day, row.twiist_avg, row.change]),
    [146, 118, 118, 122],
    8
  );
  if (y > 610) {
    y = addPage(doc, 2);
    y = drawHeader(doc, payload, y);
  }
  y = drawSectionTitle(doc, y, "Journal Rows", "Most recent rows in the selected range.");
  drawTable(
    doc,
    y,
    ["Date", "Carbs", "Total", "Basal", "Bolus", "Avg BG", "Bolus/g", "Carbs/U"],
    journal.rows.map((row) => [
      row.date,
      `${fmt(row.carbs, 0)}g`,
      `${fmt(row.total, 1)}U`,
      `${fmt(row.basal, 1)}U`,
      `${fmt(row.bolus, 1)}U`,
      fmt(row.avg_bg, 0),
      fmt(row.bolus_per_carb, 3),
      fmt(row.carbs_per_bolus, 1)
    ]),
    [70, 52, 54, 54, 54, 58, 68, 68],
    18
  );
}

export function generateReportPdf(payload: PdfReportPayload) {
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  doc.setProperties({
    title: payload.title,
    subject: payload.subtitle,
    creator: "SignalWell"
  });
  if (payload.tab === "today") todayReport(doc, payload);
  if (payload.tab === "summary") summaryReport(doc, payload);
  if (payload.tab === "journal") journalReport(doc, payload);
  doc.save(payload.filename);
}
