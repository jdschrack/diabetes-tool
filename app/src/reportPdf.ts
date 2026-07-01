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

type JournalRow = DashboardData["log"]["daily"][number];
type FoodLogRow = DashboardData["cronometer"]["groups"][number];

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
    smbg: DashboardData["tidepool"]["smbg_points"];
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
    foodLogRows: DashboardData["cronometer"]["groups"];
    stats: JournalStats;
    previousStats: JournalStats;
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

function minuteOfDay(isoLocal: string): number {
  const hh = Number(isoLocal.slice(11, 13)) || 0;
  const mm = Number(isoLocal.slice(14, 16)) || 0;
  return hh * 60 + mm;
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

function foodGroupLabel(group: string) {
  return group.toLowerCase() === "uncategorized" ? "Snacks" : group;
}

function foodSlot(group: string) {
  const label = foodGroupLabel(group).toLowerCase();
  if (label.includes("breakfast")) return "Breakfast";
  if (label.includes("lunch")) return "Lunch";
  if (label.includes("dinner")) return "Dinner";
  return "Snacks/Other";
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
  points: Array<{ label: string; value: number | null | undefined; position?: number }>,
  options: {
    min?: number;
    max?: number;
    color?: string;
    thresholdLow?: number;
    thresholdHigh?: number;
    dots?: Array<{ position: number; value: number }>;
    dotColor?: string;
  } = {}
) {
  const values = points.map((point) => point.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const dotValues = (options.dots || []).map((dot) => dot.value);
  doc.setFillColor("#ffffff");
  doc.setDrawColor(colors.line);
  doc.roundedRect(x, y, w, h, 6, 6, "FD");
  if (values.length < 2 && dotValues.length === 0) {
    doc.setTextColor(colors.muted);
    doc.setFontSize(9);
    doc.text("Not enough data", x + 12, y + h / 2);
    return;
  }
  const allValues = values.concat(dotValues);
  const min = options.min ?? Math.min(...allValues);
  const max = options.max ?? Math.max(...allValues);
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
      const position = point.position ?? index / Math.max(1, points.length - 1);
      return {
        x: chart.x + Math.max(0, Math.min(1, position)) * chart.w,
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
  if (options.dots && options.dots.length) {
    doc.setFillColor(options.dotColor || colors.red);
    doc.setDrawColor("#ffffff");
    doc.setLineWidth(0.6);
    options.dots.forEach((dot) => {
      const dotX = chart.x + Math.max(0, Math.min(1, dot.position)) * chart.w;
      const dotY = chart.y + chart.h - ((dot.value - min) / spread) * chart.h;
      doc.circle(dotX, dotY, 1.8, "FD");
    });
  }
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
      [row.very_low_pct ?? 0, colors.red],
      [row.low_pct ?? 0, "#f28a74"],
      [row.in_range_pct ?? 0, "#65c99a"],
      [row.high_pct ?? 0, colors.amber],
      [row.very_high_pct ?? 0, colors.amberDark]
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

function drawTableHeader(doc: jsPDF, y: number, headers: string[], widths: number[]) {
  const x = page.margin;
  const usable = page.width - page.margin * 2;
  const rowH = 18;
  doc.setFillColor(colors.soft);
  doc.setDrawColor(colors.line);
  doc.roundedRect(x, y, usable, rowH, 4, 4, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.2);
  doc.setTextColor(colors.ink);
  let cursor = x + 8;
  headers.forEach((header, index) => {
    doc.text(header, cursor, y + 12, { maxWidth: widths[index] - 6 });
    cursor += widths[index];
  });
}

function drawJournalRowsTable(
  doc: jsPDF,
  payload: PdfReportPayload,
  y: number,
  rows: JournalRow[],
  pageNumber: number
) {
  const headers = ["Date", "Carbs", "Total U", "Basal U", "Bolus U", "Avg BG", "Basal %", "Bolus %", "Bolus/g", "Carbs/U"];
  const widths = [60, 45, 48, 48, 48, 50, 50, 50, 52, 54];
  const rowH = 18;
  const bottomLimit = page.height - 48;
  const usable = page.width - page.margin * 2;
  const x = page.margin;
  let currentPage = pageNumber;
  let cursorY = y;

  if (!rows.length) {
    doc.setTextColor(colors.muted);
    doc.setFontSize(9);
    doc.text("No journal rows in the selected range.", x, cursorY + 14);
    return { y: cursorY + 32, pageNumber: currentPage };
  }

  drawTableHeader(doc, cursorY, headers, widths);
  cursorY += rowH;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.1);

  rows.forEach((row) => {
    if (cursorY + rowH > bottomLimit) {
      currentPage += 1;
      cursorY = addPage(doc, currentPage);
      cursorY = drawHeader(doc, payload, cursorY);
      cursorY = drawSectionTitle(doc, cursorY, "Journal Rows", "Continued selected-range daily journal data.");
      drawTableHeader(doc, cursorY, headers, widths);
      cursorY += rowH;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.1);
    }

    doc.setDrawColor(colors.line);
    doc.line(x, cursorY, x + usable, cursorY);
    let cursorX = x + 8;
    const cells = [
      row.date,
      `${fmt(row.carbs, 0)}g`,
      `${fmt(row.total, 1)}U`,
      `${fmt(row.basal, 1)}U`,
      `${fmt(row.bolus, 1)}U`,
      fmt(row.avg_bg, 0),
      `${fmt(row.basal_pct, 0)}%`,
      `${fmt(row.bolus_pct, 0)}%`,
      fmt(row.bolus_per_carb, 3),
      fmt(row.carbs_per_bolus, 1)
    ];
    cells.forEach((cell, index) => {
      doc.setTextColor(index === 0 ? colors.ink : colors.muted);
      if (index === 0) doc.setFont("helvetica", "bold");
      doc.text(cell, cursorX, cursorY + 12, { maxWidth: widths[index] - 6 });
      if (index === 0) doc.setFont("helvetica", "normal");
      cursorX += widths[index];
    });
    cursorY += rowH;
  });

  return { y: cursorY + 20, pageNumber: currentPage };
}

function drawFoodLogRowsTable(
  doc: jsPDF,
  payload: PdfReportPayload,
  y: number,
  rows: FoodLogRow[],
  pageNumber: number
) {
  const slots = ["Breakfast", "Lunch", "Dinner", "Snacks/Other"] as const;
  const headers = ["Date", ...slots];
  const widths = [58, 121, 121, 121, 123];
  const headerH = 20;
  const rowH = 66;
  const bottomLimit = page.height - 48;
  const usable = page.width - page.margin * 2;
  const x = page.margin;
  let currentPage = pageNumber;
  let cursorY = y;

  if (!rows.length) {
    doc.setTextColor(colors.muted);
    doc.setFontSize(9);
    doc.text("No Cronometer food log rows in the selected range.", x, cursorY + 14);
    return { y: cursorY + 32, pageNumber: currentPage };
  }

  const byDay = new Map<string, Record<(typeof slots)[number], FoodLogRow[]>>();
  rows.forEach((row) => {
    if (!byDay.has(row.date)) {
      byDay.set(row.date, { Breakfast: [], Lunch: [], Dinner: [], "Snacks/Other": [] });
    }
    byDay.get(row.date)?.[foodSlot(row.group)].push(row);
  });
  const dayRows = Array.from(byDay.entries()).sort(([a], [b]) => b.localeCompare(a));
  const mealTotals = (mealRows: FoodLogRow[]) => ({
    calories: mealRows.reduce((sum, row) => sum + (row.energy_kcal || 0), 0),
    carbs: mealRows.reduce((sum, row) => sum + (row.carbs_g || 0), 0),
    netCarbs: mealRows.reduce((sum, row) => sum + (row.net_carbs_g || 0), 0),
    fiber: mealRows.reduce((sum, row) => sum + (row.fiber_g || 0), 0),
    protein: mealRows.reduce((sum, row) => sum + (row.protein_g || 0), 0),
    fat: mealRows.reduce((sum, row) => sum + (row.fat_g || 0), 0)
  });
  const mealLines = (mealRows: FoodLogRow[]) => {
    if (!mealRows.length) return ["--"];
    const totals = mealTotals(mealRows);
    return [
      `${fmt(totals.calories, 0)} kcal`,
      `Carbs ${fmt(totals.carbs, 1)}g / Net ${fmt(totals.netCarbs, 1)}g`,
      `Protein ${fmt(totals.protein, 1)}g / Fat ${fmt(totals.fat, 1)}g`,
      `Fiber ${fmt(totals.fiber, 1)}g`
    ];
  };

  drawTableHeader(doc, cursorY, headers, widths);
  cursorY += headerH;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.8);

  dayRows.forEach(([date, meals]) => {
    if (cursorY + rowH > bottomLimit) {
      currentPage += 1;
      cursorY = addPage(doc, currentPage);
      cursorY = drawHeader(doc, payload, cursorY);
      cursorY = drawSectionTitle(doc, cursorY, "Food Log", "Continued daily meal macro matrix.");
      drawTableHeader(doc, cursorY, headers, widths);
      cursorY += headerH;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
    }

    doc.setDrawColor(colors.line);
    doc.line(x, cursorY, x + usable, cursorY);

    doc.setTextColor(colors.ink);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.3);
    doc.text(date, x + 8, cursorY + 14, { maxWidth: widths[0] - 10 });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);

    let cursorX = x + widths[0] + 8;
    slots.forEach((slot, index) => {
      const lines = mealLines(meals[slot]);
      doc.setTextColor(lines[0] === "--" ? colors.muted : colors.ink);
      if (lines[0] !== "--") {
        doc.setFont("helvetica", "bold");
        doc.text(lines[0], cursorX, cursorY + 12, { maxWidth: widths[index + 1] - 12 });
        doc.setFont("helvetica", "normal");
      } else {
        doc.text("--", cursorX, cursorY + 28, { maxWidth: widths[index + 1] - 12 });
      }
      lines.slice(1).forEach((line, lineIndex) => {
        doc.setTextColor(colors.muted);
        doc.text(line, cursorX, cursorY + 23 + lineIndex * 10, { maxWidth: widths[index + 1] - 12 });
      });
      cursorX += widths[index + 1];
    });
    cursorY += rowH;
  });

  return { y: cursorY + 20, pageNumber: currentPage };
}

function drawFoodLogSummary(doc: jsPDF, y: number, rows: FoodLogRow[]) {
  const total = (getter: (row: FoodLogRow) => number | null | undefined) =>
    rows.reduce((sum, row) => sum + (getter(row) || 0), 0);
  const days = new Set(rows.map((row) => row.date)).size;
  const dailyAverage = (getter: (row: FoodLogRow) => number | null | undefined) => (days ? total(getter) / days : null);
  return drawCards(doc, y, [
    ["Food Days", `${days}`, `${rows.length} meal-group rows`, colors.deepBlue],
    ["Avg Calories", `${fmt(dailyAverage((row) => row.energy_kcal), 0)}`, "Daily kcal average", colors.amber],
    [
      "Avg Carbs",
      `${fmt(dailyAverage((row) => row.carbs_g), 1)}g`,
      `${fmt(dailyAverage((row) => row.net_carbs_g), 1)}g net / day`,
      colors.green
    ],
    [
      "Avg Protein",
      `${fmt(dailyAverage((row) => row.protein_g), 1)}g`,
      `${fmt(dailyAverage((row) => row.fat_g), 1)}g fat / day`,
      colors.violet
    ]
  ]);
}

function drawSmallChartTitle(doc: jsPDF, x: number, y: number, title: string, detail: string, color: string) {
  doc.setTextColor(colors.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(title, x, y);
  doc.setTextColor(color);
  doc.setFontSize(8);
  doc.text(detail, x + 86, y);
}

function drawJournalTrendBoard(doc: jsPDF, y: number, rows: JournalRow[]) {
  const chronological = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const usable = page.width - page.margin * 2;
  const gap = 12;
  const half = (usable - gap) / 2;
  const points = chronological.map((row) => ({ label: row.date.slice(5), value: row.avg_bg }));
  drawSmallChartTitle(doc, page.margin, y, "Average BG", "40-400 mg/dL", colors.green);
  drawLineChart(doc, page.margin, y + 8, usable, 120, points, {
    min: 40,
    max: 400,
    thresholdLow: 70,
    thresholdHigh: 180,
    color: colors.green
  });

  const lowerY = y + 146;
  drawSmallChartTitle(doc, page.margin, lowerY, "Daily insulin", "total units", colors.deepBlue);
  drawLineChart(
    doc,
    page.margin,
    lowerY + 8,
    half,
    106,
    chronological.map((row) => ({ label: row.date.slice(5), value: row.total })),
    { min: 0, color: colors.deepBlue }
  );
  drawSmallChartTitle(doc, page.margin + half + gap, lowerY, "Daily carbs", "grams", colors.amber);
  drawBars(
    doc,
    page.margin + half + gap,
    lowerY + 8,
    half,
    106,
    chronological.map((row) => ({ label: row.date.slice(5), value: row.carbs })),
    { min: 0, color: colors.amber, suffix: "g" }
  );
  return lowerY + 132;
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
    ["Data Coverage", `${fmt(today.range ? Math.min(100, (today.range.cgm_readings / 288) * 100) : null, 0)}%`, `${today.range?.cgm_readings || 0} CGM · ${today.range?.smbg_readings || 0} fingerstick`, colors.blue]
  ]);
  y += 4;
  y = drawSectionTitle(doc, y, "Glucose Trend", "Selected-day CGM with fingerstick markers overlaid.");
  drawLineChart(
    doc,
    page.margin,
    y,
    page.width - page.margin * 2,
    170,
    today.glucose.map((row) => ({
      label: row.local_time.slice(11, 16),
      value: row.value,
      position: minuteOfDay(row.local_time) / 1440
    })),
    {
      min: 40,
      max: 400,
      thresholdLow: 70,
      thresholdHigh: 180,
      color: colors.green,
      dots: today.smbg.map((row) => ({ position: minuteOfDay(row.local_time) / 1440, value: row.value })),
      dotColor: colors.red
    }
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
    { min: 40, max: 400, thresholdLow: 70, thresholdHigh: 180, color: colors.blue }
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
  y = drawSectionTitle(
    doc,
    y + 4,
    "Journal Trend",
    "Average glucose, total insulin, and carbohydrate context across the selected range."
  );
  y = drawJournalTrendBoard(doc, y, journal.rows);
  let pageNumber = 1;
  if (y > 600) {
    pageNumber += 1;
    y = addPage(doc, pageNumber);
    y = drawHeader(doc, payload, y);
  }
  y = drawSectionTitle(doc, y, "Journal Rows", "All daily journal rows in the selected range.");
  const journalTable = drawJournalRowsTable(doc, payload, y, journal.rows, pageNumber);
  y = journalTable.y;
  pageNumber = journalTable.pageNumber;

  if (y > 600) {
    pageNumber += 1;
    y = addPage(doc, pageNumber);
    y = drawHeader(doc, payload, y);
  }
  y = drawSectionTitle(doc, y, "Food Log", "Cronometer meal-group rows in the selected Journal range.");
  y = drawFoodLogSummary(doc, y, journal.foodLogRows);
  if (y > 610) {
    pageNumber += 1;
    y = addPage(doc, pageNumber);
    y = drawHeader(doc, payload, y);
    y = drawSectionTitle(doc, y, "Food Log", "Cronometer meal-group rows in the selected Journal range.");
  }
  drawFoodLogRowsTable(doc, payload, y, journal.foodLogRows, pageNumber);
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
