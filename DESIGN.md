---
name: "Tidepool Dashboard"
description: "A self-hosted diabetes, insulin, nutrition, and fitness signal dashboard for pattern review."
colors:
  background-cool: "#f6f7f9"
  surface: "#ffffff"
  surface-subtle: "#fafbfc"
  ink: "#22272f"
  ink-strong: "#1f2937"
  muted: "#667085"
  line: "#d9dee7"
  line-soft: "#eef1f5"
  control-line: "#aeb8cb"
  info: "#2399c8"
  success: "#278f68"
  success-soft: "#eef7f2"
  glucose-in-range: "#65c99a"
  warning: "#e7b759"
  danger: "#d64f4f"
  danger-soft: "#fdebea"
  error-text: "#8f2f27"
  error-bg: "#fff5f4"
  range-low: "#f28a74"
  range-high: "#9f7ce0"
  range-very-high: "#7858d9"
  carb-marker: "#1f4f8f"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.35
rounded:
  control: "6px"
  panel: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page-x: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink-strong}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 12px"
  control-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 12px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "16px"
  metric-tile:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px"
---

# Design System: Tidepool Dashboard

## 1. Overview

**Creative North Star: "Health Signals Console"**

This document captures the current proof-of-concept visual system as a baseline, not the final destination. The current interface is a restrained product dashboard built for careful review of diabetes, insulin, meal, journal, and future fitness/nutrition signals. It favors compact density, familiar controls, flat white panels, cool neutral surfaces, and direct data visualization.

The intended direction is more ambitious than the current proof of concept: a clinical, calm, precise, and innovative tool that makes users want to stay engaged with their diabetes, fitness, and nutrition data. Future redesign work should move toward a more beautiful and guided "Health Signals Console" while preserving trust, inspectability, and therapy-team usefulness.

The system explicitly rejects flashy consumer fitness dashboards, generic SaaS analytics pages, dark high-gloss command centers, gamified wellness tropes, and anything that implies automated dosing recommendations.

**Key Characteristics:**

- Dense but calm data review.
- High trust through explicit labels, import visibility, metric definitions, and inspectable calculations.
- Product-first controls with familiar affordances.
- Clinical semantics without clinical coldness.
- Visual evolution expected; this file is a baseline contract, not a ceiling.

## 2. Colors

The current palette is a restrained cool-neutral product palette with semantic chart colors for glucose ranges, insulin/basal states, import workflow status, and meal markers.

### Primary

- **Signal Blue** (#2399c8): Used for delivered basal, automated correction emphasis, running import state, and primary analytic signal lines.
- **Carb Marker Blue** (#1f4f8f): Used for carb markers on glucose trend charts where label legibility matters.
- **Console Ink** (#1f2937): Used for active navigation and programmed/configured reference lines.

### Secondary

- **Clinical Green** (#278f68): Used for success states and stable glucose trend emphasis.
- **In-Range Mint** (#65c99a): Used for glucose in-range encoding and in-range bands.
- **Nutrition Gold** (#e7b759): Used for carb/macronutrient-related bars when not overlaid on charts.

### Tertiary

- **Risk Red** (#d64f4f): Used for danger states, low glucose, failed import markers, and negative basal deltas.
- **Range Coral** (#f28a74): Used for low glucose bucket states.
- **Range Purple** (#9f7ce0): Used for high glucose states.
- **Very High Purple** (#7858d9): Used for very-high glucose states above 250 mg/dL.

### Neutral

- **Cool App Background** (#f6f7f9): The application canvas.
- **Panel White** (#ffffff): Primary content surface.
- **Soft Tile Surface** (#fafbfc): Metric tiles, chips, and lightweight grouped content.
- **Primary Ink** (#22272f): Main text.
- **Muted Slate** (#667085): Secondary text, labels, helper copy.
- **Divider Line** (#d9dee7): Panel and page dividers.
- **Soft Divider** (#eef1f5): Internal tile/table borders.
- **Control Line** (#aeb8cb): Form controls and day navigation borders.

### Named Rules

**The Semantic Color Rule.** Color must carry data or state meaning. Do not use chart colors as decoration.

**The Trust Over Drama Rule.** Risk colors should identify low/high/failure states clearly without making the interface feel alarmist.

## 3. Typography

**Display Font:** Not currently used.
**Body Font:** Inter/system sans stack.
**Label/Mono Font:** Not currently distinct.

**Character:** The current typography is compact, utilitarian, and data-oriented. It uses one sans-serif family across headings, labels, controls, tables, and chart-adjacent UI to keep the product familiar and readable.

### Hierarchy

- **Headline** (700, 26px, 1.2): Used for the application title only.
- **Title** (650, 16px, 1.3): Used for panel titles and table sections.
- **Body** (400, 13px, 1.45): Used for explanatory copy, table cells, and dashboard prose.
- **Label** (650, 12px, 1.35): Used for metric labels, table headers, import status labels, and compact metadata.
- **Metric Value** (650-800, 24px): Used inside metric tiles to make dense summaries scannable.

### Named Rules

**The No Display Drama Rule.** Until a full redesign establishes a richer visual language, avoid large display type, decorative typography, and fluid heading scales inside the app shell.

**The Scan First Rule.** Labels must remain short, predictable, and aligned with the metric definitions users need for therapy-team conversations.

## 4. Elevation

Elevation is intentionally unresolved for the final design direction. The current proof of concept is flat and layered: hierarchy is carried by borders, surface changes, spacing, and typography rather than shadows. This is a baseline, not a mandate. A future superior design may introduce subtle lift, but only where it improves state, focus, or spatial understanding.

### Shadow Vocabulary

- **None at rest:** The current system has no box-shadow token. Panels and tiles use borders and tonal layering.

### Named Rules

**The Deferred Elevation Rule.** Do not infer the final elevation model from the current proof of concept. Decide elevation during the next deliberate redesign pass.

**The No Ghost Cards Rule.** Do not pair thin borders with large soft shadows as decoration.

## 5. Components

Current components are compact product controls and analytic containers. They should be treated as baseline affordances, not as the final component language.

### Buttons

- **Shape:** Compact rounded rectangle, 6px radius.
- **Primary:** Active tab uses Console Ink (#1f2937) with white text.
- **Controls:** Import button and selectors use white background, Control Line border, 36px height, 13px type.
- **Hover / Focus:** Not yet fully specified. Future work should define visible focus states and restrained hover feedback.
- **Disabled:** Day navigation buttons use opacity reduction; future work should add clearer disabled semantics without relying on opacity alone.

### Chips

- **Style:** Window breakdown and import summary chips use Soft Tile Surface or Success Soft backgrounds, 6px radius, compact 12px text.
- **State:** Current chips are informational, not interactive.

### Cards / Containers

- **Corner Style:** Panels use 8px radius; metric tiles use 6px radius.
- **Background:** Panels use Panel White; nested metric tiles use Soft Tile Surface.
- **Shadow Strategy:** None in the current system.
- **Border:** Panels use Divider Line; inner tiles and table rows use Soft Divider.
- **Internal Padding:** Panels use 16px; metric tiles use 12px.

### Inputs / Fields

- **Style:** Native select and upload controls use white background, 1px Control Line border, 6px radius, 36px height.
- **Focus:** Browser default unless overridden by the user agent. Future work should define a visible, color-safe focus ring.
- **Error / Disabled:** Error states are currently strongest in the import workflow and trend indicators, not general form fields.

### Navigation

- **Style:** Top header with import/period/day controls, followed by segmented tabs.
- **Default:** Muted text on white.
- **Active:** Console Ink background with white text.
- **Mobile:** Header and controls stack vertically below 900px.

### Charts

- **Style:** ECharts line, bar, heatmap, and scatter charts inside flat panels.
- **Glucose trend:** Green line with an in-range band and red/purple extreme coloring.
- **Meal markers:** Dark blue circular markers with bold white carb labels.
- **Basal comparison:** Delivered basal is blue; programmed/configured basal is dark ink; deltas use blue/red.

## 6. Do's and Don'ts

### Do:

- **Do** preserve the product register: familiar controls, compact density, and task-first layout.
- **Do** make metric definitions and data provenance visible when they affect interpretation.
- **Do** use color semantically for glucose ranges, insulin states, import states, and risk states.
- **Do** keep charts readable without relying on color alone; use labels, legends, tooltips, and direct annotations.
- **Do** treat this file as the current baseline and `PRODUCT.md` as the strategic direction for a future superior design.
- **Do** design future work toward a beautiful, engaging Health Signals Console that supports diabetes, fitness, and nutrition involvement without gamification.

### Don't:

- **Don't** turn the product into a flashy consumer fitness dashboard with badges, streaks, confetti, or motivational noise.
- **Don't** use a dark, high-gloss command-center aesthetic that makes health data feel dramatic or intimidating.
- **Don't** copy generic SaaS analytics pages with decorative cards, vague metrics, or weak hierarchy.
- **Don't** make the interface imply automated medical recommendations instead of pattern review and therapy-team discussion.
- **Don't** infer final elevation, motion, or brand depth from this proof of concept.
- **Don't** use decorative color, gradient text, glass effects, side-stripe card borders, or large soft decorative shadows.
