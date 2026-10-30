import { z } from 'zod';

/**
 * Versioned chart configuration saved with a report (QF_REPORTS.CHART_DEF, migration 005).
 * The same shape is used by the web chart panel (web/src/utils/chartData.ts mirrors
 * prepareChart so the browser and the server-side PNG plot the same numbers).
 */
export const CHART_DEF_VERSION = 1;
export const CHART_TYPES = [
  'bar',
  'barHorizontal',
  'groupedBar',
  'stackedBar',
  'line',
  'area',
  'pie',
  'donut',
] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const CHART_SORTS = ['none', 'xAsc', 'xDesc', 'valueAsc', 'valueDesc'] as const;
export const MAX_VALUE_FIELDS = 6;
export const MAX_TOP_N = 200;
/** Charts never plot more than this many rows (the rest are ignored, with a note). */
export const MAX_CHART_ROWS = 5000;

// result column names: printable, no control characters (they are only compared, never executed)
const field = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]+$/u, 'Invalid field name');

export const chartDefSchema = z
  .object({
    version: z.literal(CHART_DEF_VERSION),
    type: z.enum(CHART_TYPES),
    x: field,
    y: z.array(field).min(1).max(MAX_VALUE_FIELDS),
    series: field.nullable().optional(),
    title: z.string().max(120).optional(),
    sort: z.enum(CHART_SORTS).optional(),
    topN: z.number().int().min(1).max(MAX_TOP_N).nullable().optional(),
    view: z.enum(['table', 'chart', 'both']).optional(),
    /** Show a small live chart on the dashboard tile. */
    showOnDashboard: z.boolean().optional(),
    /** Run the report automatically when the dashboard loads (default: click to load). */
    dashboardAutoLoad: z.boolean().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (new Set(d.y).size !== d.y.length)
      ctx.addIssue({ code: 'custom', path: ['y'], message: 'Each value field can be used once.' });
    if ((d.type === 'pie' || d.type === 'donut') && (d.y.length !== 1 || d.series))
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'Pie and donut charts take one value field and no series field.',
      });
    if (d.series && d.y.length > 1)
      ctx.addIssue({
        code: 'custom',
        path: ['series'],
        message: 'Use either a series field or several value fields, not both.',
      });
    if (d.series && (d.series === d.x || d.y.includes(d.series)))
      ctx.addIssue({
        code: 'custom',
        path: ['series'],
        message: 'The series field must differ from the X and value fields.',
      });
    if (d.y.includes(d.x))
      ctx.addIssue({
        code: 'custom',
        path: ['y'],
        message: 'The X field cannot also be a value field.',
      });
    if (d.dashboardAutoLoad && !d.showOnDashboard)
      ctx.addIssue({
        code: 'custom',
        path: ['dashboardAutoLoad'],
        message: 'Auto-load only applies when the chart is shown on the dashboard.',
      });
  });
export type ChartDef = z.infer<typeof chartDefSchema>;

export type ChartCell = string | number | boolean | null | object;
export interface ChartColumn {
  name: string;
  label?: string;
  kind: string;
}
export interface ChartPoint {
  group: string;
  key: string;
  value: number;
}
export type PreparedChart =
  | { ok: false; message: string }
  | {
      ok: true;
      def: ChartDef;
      points: ChartPoint[];
      /** Categories (X values) in plotting order. */
      keys: string[];
      /** Series names in legend order. */
      groups: string[];
      /** Some exact values had more digits than a double holds. */
      precisionLoss: boolean;
      /** Rows not plotted (beyond MAX_CHART_ROWS, or outside top-N). */
      rowsIgnored: number;
      categoriesDropped: number;
    };

const NUMERIC = new Set(['integer', 'decimal', 'float']);

/** A double that represents an exact numeric string to 15 significant digits. */
function toPlotNumber(v: ChartCell): { n: number | null; lossy: boolean } {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'object')
    return { n: null, lossy: false };
  if (typeof v === 'number') return { n: Number.isFinite(v) ? v : null, lossy: false };
  const t = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return { n: null, lossy: false };
  const n = Number(t);
  if (!Number.isFinite(n)) return { n: null, lossy: false };
  const digits = t
    .replace(/e.*$/i, '')
    .replace(/[^\d]/g, '')
    .replace(/^0+/, '')
    .replace(/0+$/, '').length;
  return { n, lossy: digits > 15 };
}

const label = (v: ChartCell) =>
  v === null || v === undefined ? '(null)' : typeof v === 'object' ? '[binary]' : String(v);

/** Find a result column by name (first match, case-sensitive, then case-insensitive). */
function findCol(cols: ChartColumn[], name: string): number {
  const i = cols.findIndex((c) => c.name === name);
  if (i >= 0) return i;
  return cols.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
}

/**
 * Parse an untrusted stored or submitted value. Returns null for "no chart" and a
 * message (not an exception) when it is present but invalid, so a tampered or
 * outdated definition only disables the chart.
 */
export function parseChartDef(raw: unknown): { def: ChartDef | null; error?: string } {
  if (raw === null || raw === undefined || raw === '') return { def: null };
  let v = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return { def: null, error: 'The saved chart settings are not valid JSON.' };
    }
  }
  const p = chartDefSchema.safeParse(v);
  if (!p.success)
    return {
      def: null,
      error: `The saved chart settings are invalid: ${p.error.issues.map((i) => i.message).join('; ')}`,
    };
  return { def: p.data };
}

/**
 * Turn loaded result rows into plot points. Field names are checked against the
 * result columns at run time: an unknown or non-numeric field disables the chart
 * with a message instead of throwing.
 */
export function prepareChart(
  def: ChartDef,
  columns: ChartColumn[],
  rows: ChartCell[][],
): PreparedChart {
  const xi = findCol(columns, def.x);
  if (xi < 0)
    return { ok: false, message: `Chart disabled: column "${def.x}" is not in the results.` };
  const yi: number[] = [];
  for (const y of def.y) {
    const i = findCol(columns, y);
    if (i < 0)
      return { ok: false, message: `Chart disabled: column "${y}" is not in the results.` };
    if (!NUMERIC.has(columns[i].kind))
      return { ok: false, message: `Chart disabled: "${y}" is not a numeric column.` };
    yi.push(i);
  }
  let si = -1;
  if (def.series) {
    si = findCol(columns, def.series);
    if (si < 0)
      return {
        ok: false,
        message: `Chart disabled: column "${def.series}" is not in the results.`,
      };
  }
  const used = rows.slice(0, MAX_CHART_ROWS);
  let rowsIgnored = rows.length - used.length;
  let precisionLoss = false;
  const keys: string[] = [];
  const groups: string[] = [];
  const sums = new Map<string, Map<string, number>>(); // key -> group -> value
  const raw = new Map<string, ChartCell>();
  for (const r of used) {
    const key = label(r[xi]);
    if (!sums.has(key)) {
      sums.set(key, new Map());
      keys.push(key);
      raw.set(key, r[xi]);
    }
    yi.forEach((ci, j) => {
      const group = si >= 0 ? label(r[si]) : (columns[ci].label ?? def.y[j]);
      const { n, lossy } = toPlotNumber(r[ci]);
      if (lossy) precisionLoss = true;
      if (n === null) return;
      if (!groups.includes(group)) groups.push(group);
      const m = sums.get(key)!;
      m.set(group, (m.get(group) ?? 0) + n);
    });
  }
  const total = (k: string) => [...sums.get(k)!.values()].reduce((a, b) => a + b, 0);
  const sort = def.sort ?? (def.topN ? 'valueDesc' : 'none');
  const numericX = NUMERIC.has(columns[xi].kind);
  const cmpX = (a: string, b: string) => {
    if (numericX) return Number(raw.get(a)) - Number(raw.get(b));
    return a.localeCompare(b, undefined, { numeric: true });
  };
  if (sort === 'xAsc') keys.sort(cmpX);
  else if (sort === 'xDesc') keys.sort((a, b) => cmpX(b, a));
  else if (sort === 'valueAsc') keys.sort((a, b) => total(a) - total(b));
  else if (sort === 'valueDesc') keys.sort((a, b) => total(b) - total(a));
  let kept = keys;
  let categoriesDropped = 0;
  if (def.topN && keys.length > def.topN) {
    // top-N always means the largest totals, whatever the display order
    const top = new Set([...keys].sort((a, b) => total(b) - total(a)).slice(0, def.topN));
    kept = keys.filter((k) => top.has(k));
    categoriesDropped = keys.length - kept.length;
    rowsIgnored += used.filter((r) => !top.has(label(r[xi]))).length;
  }
  const points: ChartPoint[] = [];
  for (const key of kept)
    for (const group of groups) {
      const v = sums.get(key)!.get(group);
      if (v !== undefined) points.push({ group, key, value: v });
    }
  return {
    ok: true,
    def,
    points,
    keys: kept,
    groups,
    precisionLoss,
    rowsIgnored,
    categoriesDropped,
  };
}
