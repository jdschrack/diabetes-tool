const data = window.DASHBOARD_DATA;

const COLORS = {
  very_low: "#d64f4f",
  low: "#f28a74",
  in_range: "#65c99a",
  high: "#9f7ce0",
  very_high: "#7858d9",
};

const ORDER = ["very_low", "low", "in_range", "high", "very_high"];

const fmt = (value, digits = 1) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? "--"
    : Number(value).toFixed(digits).replace(/\.0$/, "");

function byDay(rows, key = "day") {
  return new Map(rows.map((row) => [row[key], row]));
}

const ranges = data.tidepool.ranges;
const dailyRanges = data.tidepool.daily_ranges;
const basalDeviation = data.tidepool.basal_deviation;
const dailyBasal = basalDeviation.daily;
const hourlyBasal = basalDeviation.hourly;
const glucosePoints = data.tidepool.glucose_points;
const periodSummaries = data.period_summaries;
const logByDay = byDay(data.log.daily, "date");
const insulinByDay = byDay(data.tidepool.daily_insulin);
const foodByDay = byDay(data.tidepool.daily_food);
const basalByDay = byDay(dailyBasal);
const mealAnalysis = data.meal_analysis;
let currentPeriodDays = dailyRanges.map((row) => row.day);

function init() {
  document.getElementById("subtitle").textContent =
    `${dailyRanges.length} days · ${data.tidepool.totals.readings} CGM readings · ${data.generated_from.db}`;

  const select = document.getElementById("daySelect");
  dailyRanges.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.day;
    option.textContent = row.day;
    select.appendChild(option);
  });
  select.value = dailyRanges[dailyRanges.length - 1]?.day || "";
  select.addEventListener("change", () => renderSelectedDay(select.value));

  const periodSelect = document.getElementById("periodSelect");
  periodSummaries.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.label;
    option.textContent = row.label;
    periodSelect.appendChild(option);
  });
  periodSelect.value = periodSummaries[0]?.label || "";
  periodSelect.addEventListener("change", () => renderSummaryTab(periodSelect.value));

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  renderLegend();
  renderSummaryTab(periodSelect.value);
  renderDailyLogTable();
  renderBaselineTable();
  renderSelectedDay(select.value);
}

function activateTab(tabId) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === tabId);
  });
  document.getElementById("periodControl").classList.toggle("is-hidden", tabId !== "summaryTab");
  document.getElementById("dayControl").classList.toggle("is-hidden", tabId !== "dayTab");
}

function renderLegend() {
  const node = document.getElementById("rangeLegend");
  node.innerHTML = ranges
    .map(
      (range) =>
        `<span class="legend-item"><span class="swatch" style="background:${COLORS[range.key]}"></span>${range.label} ${range.bounds}</span>`
    )
    .join("");
}

function renderSelectedDay(day) {
  const range = dailyRanges.find((row) => row.day === day);
  const log = logByDay.get(day);
  const insulin = log || insulinByDay.get(day);
  const food = foodByDay.get(day);
  const basal = basalByDay.get(day);

  document.getElementById("selectedDayLabel").textContent = day || "";
  document.getElementById("avgGlucose").textContent = fmt(range?.avg_glucose, 0);
  document.getElementById("timeInRange").textContent = `${fmt(range?.in_range_pct, 0)}%`;
  document.getElementById("totalInsulin").textContent = fmt(insulin?.total ?? insulin?.total_units, 1);
  document.getElementById("carbs").textContent = fmt(log?.carbs ?? food?.carbs, 0);
  document.getElementById("stddev").textContent = fmt(range?.stddev_glucose, 0);
  document.getElementById("cv").textContent = fmt(range?.cv_pct, 0);
  document.getElementById("basalCorrection").textContent = fmt(basal?.extra_basal_units, 1);

  renderSelectedRangeBars(range);
  renderInsulinBars(log, insulinByDay.get(day), food);
  renderHourlyDeviation(day);
  renderSelectedDayGlucoseTrend(day);
}

function renderPeriodSummary(label) {
  const row = periodSummaries.find((item) => item.label === label) || periodSummaries[0];
  if (!row) {
    return null;
  }
  document.getElementById("periodTitle").textContent = `${row.label} Summary`;
  document.getElementById("periodRange").textContent =
    `${row.start} to ${row.end} · ${row.days_available}/${row.days_requested} days available`;
  document.getElementById("periodDays").textContent = `${row.days_available}`;
  document.getElementById("periodAvg").textContent = `${fmt(row.avg_glucose, 0)} mg/dL`;
  document.getElementById("periodTir").textContent = `${fmt(row.time_in_range_pct, 0)}%`;
  document.getElementById("periodExtra").textContent = `${fmt(row.extra_basal_units, 1)} U`;
  document.getElementById("periodExtraDay").textContent = `${fmt(row.extra_basal_per_day, 1)} U`;
  document.getElementById("periodBolusCarb").textContent = fmt(row.bolus_per_carb, 3);
  return row;
}

function renderSummaryTab(label) {
  const period = renderPeriodSummary(label);
  currentPeriodDays = periodDays(period);
  renderBasalCorrectionTrend(filteredDailyBasal());
  renderRangeTrend(filteredDailyRanges());
  renderGlucoseTrend(filteredDailyRanges());
  renderPeriodRangeBars(currentPeriodDays);
  renderPeriodBasalBars(period);
  renderHourlyDeviationProfile(currentPeriodDays);
  renderMealAnalysisTable(period?.label);
}

function periodDays(period) {
  if (!period?.start || !period?.end) {
    return dailyRanges.map((row) => row.day);
  }
  return dailyRanges
    .map((row) => row.day)
    .filter((day) => day >= period.start && day <= period.end);
}

function filteredDailyRanges() {
  const days = new Set(currentPeriodDays);
  return dailyRanges.filter((row) => days.has(row.day));
}

function filteredDailyBasal() {
  const days = new Set(currentPeriodDays);
  return dailyBasal.filter((row) => days.has(row.day));
}

function renderSelectedRangeBars(row, targetId = "selectedRangeBars") {
  const node = document.getElementById(targetId);
  if (!row) {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = ranges
    .map((range) => {
      const pct = row[`${range.key}_pct`] || 0;
      return `
        <div class="range-row">
          <span>${range.label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${COLORS[range.key]}"></div>
          </div>
          <strong>${fmt(pct, 1)}%</strong>
        </div>
      `;
    })
    .join("");
}

function renderInsulinBars(logRow, tidepoolRow, foodRow) {
  const basal = logRow?.basal ?? tidepoolRow?.basal_units ?? 0;
  const bolus = logRow?.bolus ?? tidepoolRow?.bolus_units ?? 0;
  const carbs = logRow?.carbs ?? foodRow?.carbs ?? 0;
  const max = Math.max(basal, bolus, carbs / 2, 1);
  const rows = [
    ["Basal", basal, "U", "var(--insulin)", max],
    ["Bolus", bolus, "U", "#67c3df", max],
    ["Carbs", carbs, "g", "var(--carbs)", max * 2],
  ];
  document.getElementById("insulinBars").innerHTML = rows
    .map(([label, value, unit, color, denominator]) => {
      const pct = Math.min(100, (value / denominator) * 100);
      return `
        <div class="insulin-row">
          <span>${label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <strong>${fmt(value, 1)}${unit}</strong>
        </div>
      `;
    })
    .join("");
}

function renderPeriodRangeBars(days) {
  const daySet = new Set(days);
  const rows = dailyRanges.filter((row) => daySet.has(row.day));
  const totals = Object.fromEntries(ORDER.map((key) => [key, 0]));
  let readings = 0;
  rows.forEach((row) => {
    readings += row.readings || 0;
    ORDER.forEach((key) => {
      totals[key] += row[`${key}_count`] || 0;
    });
  });
  const aggregate = Object.fromEntries(
    ORDER.map((key) => [`${key}_pct`, readings ? (100 * totals[key]) / readings : 0])
  );
  renderSelectedRangeBars(aggregate, "periodRangeBars");
}

function renderPeriodBasalBars(period) {
  const delivered = period?.delivered_basal_units || 0;
  const scheduled = period?.scheduled_basal_units || 0;
  const extra = period?.extra_basal_units || 0;
  const max = Math.max(delivered, scheduled, extra, 1);
  const rows = [
    ["Delivered", delivered, "U", "var(--insulin)", max],
    ["Scheduled", scheduled, "U", "#8fa1b8", max],
    ["Extra", extra, "U", "#1f7fac", max],
  ];
  document.getElementById("periodBasalBars").innerHTML = rows
    .map(([label, value, unit, color, denominator]) => {
      const pct = Math.min(100, (value / denominator) * 100);
      return `
        <div class="insulin-row">
          <span>${label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <strong>${fmt(value, 1)}${unit}</strong>
        </div>
      `;
    })
    .join("");
}

function hourlyRateProfiles(days) {
  const daySet = new Set(days);
  const dayProfiles = new Map();
  const average = new Map();
  const configured = new Map();
  for (let hour = 0; hour < 24; hour += 1) {
    average.set(hour, { hour, deliveredRateTotal: 0, deliveredCount: 0 });
    configured.set(hour, { hour, scheduledRateTotal: 0, scheduledCount: 0 });
  }

  hourlyBasal
    .filter((row) => daySet.has(row.day))
    .forEach((row) => {
      const hours = (row.observed_minutes || 0) / 60;
      if (!hours) {
        return;
      }
      const deliveredRate = (row.delivered_units || 0) / hours;
      const scheduledRate = (row.scheduled_units || 0) / hours;
      if (!dayProfiles.has(row.day)) {
        dayProfiles.set(
          row.day,
          Array.from({ length: 24 }, (_unused, hour) => ({ hour, rate: null }))
        );
      }
      dayProfiles.get(row.day)[row.hour_of_day] = { hour: row.hour_of_day, rate: deliveredRate };
      const avgBucket = average.get(row.hour_of_day);
      avgBucket.deliveredRateTotal += deliveredRate;
      avgBucket.deliveredCount += 1;
      const configuredBucket = configured.get(row.hour_of_day);
      configuredBucket.scheduledRateTotal += scheduledRate;
      configuredBucket.scheduledCount += 1;
    });

  return {
    days: [...dayProfiles.entries()].map(([day, rows]) => ({ day, rows })),
    average: [...average.values()].map((row) => ({
      hour: row.hour,
      rate: row.deliveredCount ? row.deliveredRateTotal / row.deliveredCount : null,
    })),
    configured: [...configured.values()].map((row) => ({
      hour: row.hour,
      rate: row.scheduledCount ? row.scheduledRateTotal / row.scheduledCount : null,
    })),
  };
}

function renderHourlyDeviationProfile(days) {
  const profiles = hourlyRateProfiles(days);
  const hourlySpread = Array.from({ length: 24 }, (_unused, hour) => {
    const values = profiles.days
      .map((profile) => profile.rows[hour]?.rate)
      .filter((value) => value !== null && value !== undefined);
    return {
      hour,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    };
  });
  const comparison = profiles.average.map((row) => {
    const configured = profiles.configured[row.hour]?.rate;
    return {
      hour: row.hour,
      average: row.rate,
      configured,
      delta: row.rate !== null && configured !== null ? row.rate - configured : null,
    };
  });
  const allRates = [
    ...hourlySpread.flatMap((row) => [row.min, row.max]),
    ...profiles.average.map((row) => row.rate),
    ...profiles.configured.map((row) => row.rate),
  ].filter((value) => value !== null && value !== undefined);
  const deltas = comparison
    .map((row) => row.delta)
    .filter((value) => value !== null && value !== undefined);
  const width = 980;
  const height = 330;
  const margin = { top: 16, right: 18, bottom: 36, left: 54 };
  const plotW = width - margin.left - margin.right;
  const topH = 178;
  const gap = 36;
  const bottomTop = margin.top + topH + gap;
  const bottomH = height - bottomTop - margin.bottom;
  const maxRate = Math.max(3, ...allRates) * 1.08;
  const maxDelta = Math.max(0.5, ...deltas.map((value) => Math.abs(value))) * 1.12;
  const xFor = (hour) => margin.left + (hour / 23) * plotW;
  const yRate = (rate) => margin.top + topH - (rate / maxRate) * topH;
  const yDelta = (delta) => bottomTop + bottomH / 2 - (delta / maxDelta) * (bottomH / 2);
  const linePoints = (rows) =>
    rows
      .filter((row) => row.rate !== null && row.rate !== undefined)
      .map((row) => `${xFor(row.hour)},${yRate(row.rate)}`)
      .join(" ");
  const spreadPoints = [
    ...hourlySpread
      .filter((row) => row.max !== null)
      .map((row) => `${xFor(row.hour)},${yRate(row.max)}`),
    ...hourlySpread
      .filter((row) => row.min !== null)
      .reverse()
      .map((row) => `${xFor(row.hour)},${yRate(row.min)}`),
  ].join(" ");

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly basal rate profile">`;
  [0, Math.ceil(maxRate / 2), Math.ceil(maxRate)].forEach((tick) => {
    const y = yRate(tick);
    svg += `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="8" y="${y + 4}">${fmt(tick, 1)}U/hr</text>`;
  });
  [0, 6, 12, 18, 23].forEach((hour) => {
    const x = xFor(hour);
    svg += `<line class="grid-line" x1="${x}" x2="${x}" y1="${margin.top}" y2="${bottomTop + bottomH}" opacity="0.45"></line>`;
    svg += `<text class="axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${hour === 0 ? "12a" : hour === 12 ? "12p" : hour}</text>`;
  });
  svg += `<polygon points="${spreadPoints}" fill="#2399c8" opacity="0.16"></polygon>`;
  svg += `<polyline points="${linePoints(profiles.average)}" fill="none" stroke="#2399c8" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
  svg += `<polyline points="${linePoints(profiles.configured)}" fill="none" stroke="#1f2937" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></polyline>`;

  [-maxDelta, 0, maxDelta].forEach((tick) => {
    const y = yDelta(tick);
    svg += `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="8" y="${y + 4}">${fmt(tick, 1)}Δ</text>`;
  });
  const barW = Math.max(12, plotW / 24 - 7);
  comparison.forEach((row) => {
    if (row.delta === null) {
      return;
    }
    const x = xFor(row.hour) - barW / 2;
    const y0 = yDelta(0);
    const y1 = yDelta(row.delta);
    const y = Math.min(y0, y1);
    const h = Math.abs(y1 - y0);
    const color = row.delta >= 0 ? "#2399c8" : "#d64f4f";
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="${color}" opacity="0.78"></rect>`;
  });

  svg += `<g transform="translate(${width - 404}, ${margin.top + 2})">
    <rect x="0" y="0" width="392" height="24" rx="5" fill="rgba(255,255,255,0.88)"></rect>
    <rect x="10" y="8" width="24" height="8" fill="#2399c8" opacity="0.18"></rect>
    <text class="axis-label" x="40" y="16">delivered range</text>
    <line x1="154" x2="178" y1="12" y2="12" stroke="#2399c8" stroke-width="4"></line>
    <text class="axis-label" x="186" y="16">avg delivered</text>
    <line x1="288" x2="312" y1="12" y2="12" stroke="#1f2937" stroke-width="4"></line>
    <text class="axis-label" x="320" y="16">profile</text>
  </g>`;
  svg += "</svg>";
  document.getElementById("hourlyDeviationProfile").innerHTML = svg;
}

function renderBasalCorrectionTrend(rows = dailyBasal) {
  const width = 980;
  const height = 230;
  const margin = { top: 14, right: 18, bottom: 36, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const max = Math.max(1, ...rows.map((row) => row.extra_basal_units));
  const barGap = 8;
  const barW = Math.max(18, (plotW - barGap * Math.max(0, rows.length - 1)) / Math.max(1, rows.length));

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily basal correction load chart">`;
  [0, Math.ceil(max / 2), Math.ceil(max)].forEach((tick) => {
    const y = margin.top + plotH - (tick / max) * plotH;
    svg += `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="8" y="${y + 4}">${tick}U</text>`;
  });
  rows.forEach((row, i) => {
    const x = margin.left + i * (barW + barGap);
    const h = (row.extra_basal_units / max) * plotH;
    const y = margin.top + plotH - h;
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="#2399c8"></rect>`;
    svg += `<text class="axis-label" x="${x + barW / 2}" y="${height - 12}" text-anchor="middle">${row.day.slice(5)}</text>`;
  });
  svg += "</svg>";
  document.getElementById("basalCorrectionTrend").innerHTML = svg;
}

function renderHourlyDeviation(day) {
  const rows = hourlyBasal.filter((row) => row.day === day);
  const maxAbs = Math.max(0.1, ...rows.map((row) => Math.abs(row.net_deviation_units)));
  const byHour = new Map(rows.map((row) => [row.hour_of_day, row]));
  const cells = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const row = byHour.get(hour);
    const value = row?.net_deviation_units ?? 0;
    const alpha = Math.min(0.9, 0.12 + Math.abs(value) / maxAbs * 0.68);
    const bg = value >= 0 ? `rgba(35,153,200,${alpha})` : `rgba(214,79,79,${alpha})`;
    const fg = Math.abs(value) / maxAbs > 0.55 ? "#fff" : "var(--ink)";
    cells.push(`
      <div class="hour-cell" style="background:${bg};color:${fg}" title="${hour}:00 · net ${fmt(value, 2)}U · extra ${fmt(row?.extra_basal_units, 2)}U">
        <strong>${String(hour).padStart(2, "0")}:00</strong>
        <span>${fmt(value, 2)}U</span>
      </div>
    `);
  }
  document.getElementById("hourlyDeviation").innerHTML = cells.join("");
}

function minutesSinceMidnight(localTime) {
  const date = new Date(localTime);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function glucoseSegmentColor(a, b) {
  if (a < 54 || b < 54) {
    return COLORS.very_low;
  }
  if (a > 250 || b > 250) {
    return COLORS.very_high;
  }
  return "#278f68";
}

function renderSelectedDayGlucoseTrend(day) {
  const rows = glucosePoints.filter((row) => row.day === day);
  const width = 980;
  const height = 230;
  const margin = { top: 16, right: 18, bottom: 34, left: 44 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = rows.map((row) => row.value);
  const min = Math.min(50, ...values);
  const max = Math.max(260, ...values);
  const xFor = (minute) => margin.left + (minute / 1440) * plotW;
  const yFor = (value) => margin.top + plotH - ((value - min) / (max - min)) * plotH;

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Selected day CGM trend">`;
  svg += `<rect x="${margin.left}" y="${yFor(180)}" width="${plotW}" height="${yFor(70) - yFor(180)}" fill="#d7efe5" opacity="0.72"></rect>`;
  [70, 180].forEach((tick) => {
    const y = yFor(tick);
    svg += `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="8" y="${y + 4}">${tick}</text>`;
  });
  [0, 360, 720, 1080, 1440].forEach((minute) => {
    const x = xFor(minute);
    const label = minute === 0 ? "12a" : minute === 720 ? "12p" : minute === 1440 ? "12a" : `${minute / 60}`;
    svg += `<line class="grid-line" x1="${x}" x2="${x}" y1="${margin.top}" y2="${margin.top + plotH}" opacity="0.45"></line>`;
    svg += `<text class="axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${label}</text>`;
  });
  if (rows.length) {
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1];
      const row = rows[i];
      const color = glucoseSegmentColor(prev.value, row.value);
      svg += `<line x1="${xFor(minutesSinceMidnight(prev.local_time))}" y1="${yFor(prev.value)}" x2="${xFor(minutesSinceMidnight(row.local_time))}" y2="${yFor(row.value)}" stroke="${color}" stroke-width="3" stroke-linecap="round"></line>`;
    }
  } else {
    svg += `<text class="axis-label" x="${width / 2}" y="${height / 2}" text-anchor="middle">No CGM readings</text>`;
  }
  svg += "</svg>";
  document.getElementById("selectedDayGlucoseTrend").innerHTML = svg;
}

function renderRangeTrend(rows = dailyRanges) {
  const width = 980;
  const height = 300;
  const margin = { top: 12, right: 18, bottom: 34, left: 42 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const barGap = 6;
  const barW = Math.max(18, (plotW - barGap * Math.max(0, rows.length - 1)) / Math.max(1, rows.length));

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily time in range stacked bar chart">`;
  [0, 25, 50, 75, 100].forEach((tick) => {
    const y = margin.top + plotH - (tick / 100) * plotH;
    svg += `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="8" y="${y + 4}">${tick}%</text>`;
  });

  rows.forEach((row, i) => {
    const x = margin.left + i * (barW + barGap);
    let y = margin.top + plotH;
    ORDER.forEach((key) => {
      const pct = row[`${key}_pct`] || 0;
      const h = (pct / 100) * plotH;
      y -= h;
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${COLORS[key]}"></rect>`;
    });
    svg += `<text class="axis-label" x="${x + barW / 2}" y="${height - 10}" text-anchor="middle">${row.day.slice(5)}</text>`;
  });
  svg += "</svg>";
  document.getElementById("rangeTrend").innerHTML = svg;
}

function renderGlucoseTrend(rows = dailyRanges) {
  const width = 980;
  const height = 220;
  const margin = { top: 16, right: 18, bottom: 34, left: 44 };
  const values = rows.map((row) => row.avg_glucose);
  const min = Math.min(60, ...values);
  const max = Math.max(220, ...values);
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const xFor = (i) => margin.left + (i / Math.max(1, rows.length - 1)) * plotW;
  const yFor = (v) => margin.top + plotH - ((v - min) / (max - min)) * plotH;
  const points = rows.map((row, i) => `${xFor(i)},${yFor(row.avg_glucose)}`).join(" ");

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily average glucose trend">`;
  [70, 180].forEach((tick) => {
    const y = yFor(tick);
    svg += `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line>`;
    svg += `<text class="axis-label" x="8" y="${y + 4}">${tick}</text>`;
  });
  svg += `<polyline points="${points}" fill="none" stroke="#278f68" stroke-width="3"></polyline>`;
  rows.forEach((row, i) => {
    svg += `<circle cx="${xFor(i)}" cy="${yFor(row.avg_glucose)}" r="4" fill="#65c99a"></circle>`;
    svg += `<text class="axis-label" x="${xFor(i)}" y="${height - 10}" text-anchor="middle">${row.day.slice(5)}</text>`;
  });
  svg += "</svg>";
  document.getElementById("glucoseTrend").innerHTML = svg;
}

function renderDailyLogTable() {
  const headers = ["Date", "Carbs", "Total U", "Basal U", "Bolus U", "Avg BG", "Basal %", "Bolus/g"];
  const rows = data.log.daily.map((row) => [
    row.date,
    fmt(row.carbs, 0),
    fmt(row.total, 1),
    fmt(row.basal, 1),
    fmt(row.bolus, 1),
    fmt(row.avg_bg, 0),
    `${fmt(row.basal_pct, 0)}%`,
    fmt(row.bolus_per_carb, 3),
  ]);
  renderTable("dailyLogTable", headers, rows);
}

function renderBaselineTable() {
  const rows = data.log.baseline.map((row) => [
    row.metric,
    row.ilet_30_day,
    row.twiist_avg,
    row.change,
  ]);
  renderTable("baselineTable", ["Metric", "iLet", "Twiist", "Change"], rows);
}

function mealLabel(value) {
  return value
    .split("/")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ");
}

function renderMealAnalysisTable(periodLabel) {
  const rows = mealAnalysis.periods?.[periodLabel] || mealAnalysis.all || [];
  const tableRows = rows.map((row) => [
    mealLabel(row.meal),
    row.meals,
    fmt(row.carbs_per_bolus, 1),
    fmt(row.pre_bg, 0),
    fmt(row.peak_4h, 0),
    `${fmt(row.pct_high_4h, 0)}%`,
    fmt(row.extra_basal_4h, 2),
    fmt(row.net_basal_4h, 2),
  ]);
  renderTable(
    "mealAnalysisTable",
    ["Meal", "Meals", "Carbs/U", "Pre BG", "4h Peak", "% >180", "Extra Basal 4h", "Net Basal 4h"],
    tableRows
  );
}

function renderTable(id, headers, rows) {
  const table = document.getElementById(id);
  table.innerHTML = `
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>${row.map((v) => `<td>${v ?? ""}</td>`).join("")}</tr>`).join("")}
    </tbody>
  `;
}

init();
