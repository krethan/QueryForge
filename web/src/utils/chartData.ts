/**
 * Browser copy of server/src/charts/chart-def.ts (prepareChart) so the chart panel and the
 * server-rendered PNG (XLSX Chart sheet, scheduled e-mail) plot the same numbers.
 * The server re-validates every saved definition; checks here are only for UI feedback.
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
export type ChartSort = (typeof CHART_SORTS)[number];
export type ChartView = 'table' | 'chart' | 'both';
export const MAX_VALUE_FIELDS = 6;
export const MAX_TOP_N = 200;
export const MAX_CHART_ROWS = 5000;

export interface ChartDef {
  version: 1;
  type: ChartType;
  x: string;
  y: string[];
  series?: string | null;
  title?: string;
  sort?: ChartSort;
  topN?: number | null;
  view?: ChartView;
  showOnDashboard?: boolean;
  dashboardAutoLoad?: boolean;
}

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  barHorizontal: 'Horizontal bar',
  groupedBar: 'Grouped bar',
  stackedBar: 'Stacked bar',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  donut: 'Donut',
};
export const CHART_SORT_LABELS: Record<ChartSort, string> = {
  none: 'Result order',
  xAsc: 'X ascending',
  xDesc: 'X descending',
  valueAsc: 'Value ascending',
  valueDesc: 'Value descending',
};
export const isPie = (t: ChartType) => t === 'pie' || t === 'donut';

/** Same rules as the server schema; returns the first problem or null. */
export function chartProblem(d: ChartDef): string | null {
  if (!d.x) return 'Choose an X field.';
  if (d.y.length === 0) return 'Choose at least one value field.';
  if (d.y.length > MAX_VALUE_FIELDS) return `Use at most ${MAX_VALUE_FIELDS} value fields.`;
  if (new Set(d.y).size !== d.y.length) return 'Each value field can be used once.';
  if (isPie(d.type) && (d.y.length !== 1 || d.series))
    return 'Pie and donut charts take one value field and no series field.';
  if (d.series && d.y.length > 1)
    return 'Use either a series field or several value fields, not both.';
  if (d.series && (d.series === d.x || d.y.includes(d.series)))
    return 'The series field must differ from the X and value fields.';
  if (d.y.includes(d.x)) return 'The X field cannot also be a value field.';
  if (d.topN != null && (!Number.isInteger(d.topN) || d.topN < 1 || d.topN > MAX_TOP_N))
    return `Top N must be between 1 and ${MAX_TOP_N}.`;
  if ((d.title ?? '').length > 120) return 'The title can be at most 120 characters.';
  return null;
}

/** Remove empty optional fields so the saved JSON stays small and strict-schema clean. */
export function cleanChartDef(d: ChartDef): ChartDef {
  const out: ChartDef = { version: 1, type: d.type, x: d.x, y: d.y };
  if (d.series) out.series = d.series;
  if (d.title?.trim()) out.title = d.title.trim();
  if (d.sort && d.sort !== 'none') out.sort = d.sort;
  if (d.topN) out.topN = d.topN;
  if (d.view && d.view !== 'both') out.view = d.view;
  if (d.showOnDashboard) out.showOnDashboard = true;
  if (d.showOnDashboard && d.dashboardAutoLoad) out.dashboardAutoLoad = true;
  return out;
}

/**
 * Pick a sensible first chart: the first text/date column as X and the first numeric
 * column as Y (bar; line when X is a date). Null when there is nothing to plot.
 */
export function suggestChart(columns: ChartColumn[]): ChartDef | null {
  const num = columns.filter((c) => NUMERIC.has(c.kind));
  const cat = columns.filter((c) => !NUMERIC.has(c.kind) && c.kind !== 'binary');
  if (num.length === 0) return null;
  if (cat.length === 0) {
    if (num.length < 2) return null;
    return { version: 1, type: 'bar', x: num[0].name, y: [num[1].name] };
  }
  const x = cat.find((c) => c.kind === 'text') ?? cat[0];
  const dateLike = /date|time/i.test(x.kind);
  return { version: 1, type: dateLike ? 'line' : 'bar', x: x.name, y: [num[0].name] };
}

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

export const NUMERIC_CHART_KINDS = new Set(['integer', 'decimal', 'float']);
const NUMERIC = NUMERIC_CHART_KINDS;

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
