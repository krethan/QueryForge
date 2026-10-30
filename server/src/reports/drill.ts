import { z } from 'zod';
import { AppError } from '../util/errors.js';
import { chartDefSchema, type ChartDef } from '../charts/chart-def.js';
import type { FilterItem, FilterSpec, Scalar } from '../catalog/filter-builder.js';
import { isGroup, MAX_FILTERS } from '../catalog/filter-builder.js';
import type {
  ColumnRef,
  JoinedReportSpec,
  OutputColumn,
  ResolvedSource,
} from '../catalog/join-builder.js';

/**
 * Drill-down.
 *
 * Builder reports: the detail query is derived from the saved definition (same tables,
 * joins, filters and ask-when-run parameters) plus one equality / IS NULL filter per
 * clicked group field, with grouping, totals and total filters removed. The client only
 * sends result column names and values; the server checks the names against the
 * report's own group columns and binds the values as `?` markers.
 *
 * Configured target: "Drill to report X" maps clicked fields to X's parameters. It is
 * stored with the chart settings in QF_REPORTS.CHART_DEF (no migration): version 1 of
 * that column is a bare chart definition, version 2 is an envelope `{ version: 2, chart,
 * drill }`. Readers accept both; a report without a drill target keeps writing version 1.
 */

const field = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]+$/u, 'Invalid field name');
const paramName = z.string().min(1).max(30);

export const MAX_DRILL_MAPPINGS = 20;
export const drillDefSchema = z
  .object({
    version: z.literal(1),
    targetReportId: z.string().uuid(),
    /** Clicked result column -> target report parameter. */
    mapping: z
      .array(z.object({ field, parameter: paramName }).strict())
      .min(1)
      .max(MAX_DRILL_MAPPINGS),
  })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    for (const m of d.mapping) {
      const k = m.parameter.toUpperCase();
      if (seen.has(k))
        ctx.addIssue({
          code: 'custom',
          path: ['mapping'],
          message: `Parameter ${m.parameter} is mapped twice.`,
        });
      seen.add(k);
    }
  });
export type DrillDef = z.infer<typeof drillDefSchema>;

export const PRESENTATION_VERSION = 2;
const envelopeSchema = z
  .object({
    version: z.literal(PRESENTATION_VERSION),
    chart: z.unknown().optional(),
    drill: z.unknown().optional(),
  })
  .strict();

export interface Presentation {
  chart: ChartDef | null;
  chartError?: string;
  drill: DrillDef | null;
  drillError?: string;
}

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join('; ');

/** Parse CHART_DEF (version 1 chart, or version 2 envelope). Never throws. */
export function parsePresentation(raw: unknown): Presentation {
  if (raw === null || raw === undefined || raw === '') return { chart: null, drill: null };
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return {
        chart: null,
        drill: null,
        chartError: 'The saved chart settings are not valid JSON.',
      };
    }
  }
  const out: Presentation = { chart: null, drill: null };
  let chartRaw: unknown = v;
  if (v && typeof v === 'object' && (v as { version?: unknown }).version === PRESENTATION_VERSION) {
    const env = envelopeSchema.safeParse(v);
    if (!env.success)
      return { chart: null, drill: null, chartError: 'The saved chart settings are invalid.' };
    chartRaw = env.data.chart ?? null;
    if (env.data.drill !== undefined && env.data.drill !== null) {
      const d = drillDefSchema.safeParse(env.data.drill);
      if (d.success) out.drill = d.data;
      else out.drillError = `The saved drill settings are invalid: ${issues(d.error)}`;
    }
  }
  if (chartRaw !== null && chartRaw !== undefined) {
    const c = chartDefSchema.safeParse(chartRaw);
    if (c.success) out.chart = c.data;
    else out.chartError = `The saved chart settings are invalid: ${issues(c.error)}`;
  }
  return out;
}

/** Serialize for CHART_DEF: plain version-1 chart JSON unless a drill target is set. */
export function presentationJson(chart: ChartDef | null, drill: DrillDef | null): string | null {
  if (!drill) return chart ? JSON.stringify(chart) : null;
  return JSON.stringify({ version: PRESENTATION_VERSION, chart: chart ?? null, drill });
}

// ---------------------------------------------------------------------------
// Builder-derived detail query
// ---------------------------------------------------------------------------

export type DrillValue = Scalar | null;
export const MAX_DETAIL_COLUMNS = 100;
/** Default detail columns stop adding base-table columns after this many. */
export const DEFAULT_DETAIL_COLUMNS = 12;

export interface GroupField {
  /** Result column name the client sees (and sends back). */
  name: string;
  table: string;
  column: string;
}

const bad = (code: string, message: string) => new AppError(400, code, message);

/** Group fields of a built grouped query: every non-total output column. */
export function groupFields(spec: JoinedReportSpec, columns: OutputColumn[]): GroupField[] {
  const grouping = !!spec.groupBy?.length || !!spec.aggregates?.length;
  if (!grouping) return [];
  return columns
    .filter((c) => !c.aggregate)
    .map((c) => ({ name: c.name, table: c.alias, column: c.column }));
}

export interface DetailColumn {
  table: string;
  column: string;
  label: string;
  type: string;
}

/** All columns of all tables, for the drill panel's column picker. */
export function availableColumns(aliases: string[], sources: ResolvedSource[]): DetailColumn[] {
  const out: DetailColumn[] = [];
  sources.forEach((s, i) =>
    s.columns.forEach((c) =>
      out.push({
        table: aliases[i],
        column: c.name,
        label: `${aliases[i]}.${c.name}`,
        type: c.type,
      }),
    ),
  );
  return out.slice(0, 1000);
}

const keyOf = (r: { table: string; column: string }) => `${r.table}\u0000${r.column}`;

/** Selected non-total columns, totals' source columns, then base-table columns. */
export function defaultDetailColumns(
  spec: JoinedReportSpec,
  aliases: string[],
  sources: ResolvedSource[],
  fields: GroupField[],
): ColumnRef[] {
  const out: { table: string; column: string }[] = [];
  const seen = new Set<string>();
  const add = (table: string | undefined, column: string | null | undefined) => {
    if (!column) return;
    const t = table || aliases[0];
    const i = aliases.indexOf(t);
    if (i < 0) return;
    const c = sources[i].columns.find((x) => x.name === column);
    if (!c) return;
    const k = keyOf({ table: t, column: c.name });
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ table: t, column: c.name });
  };
  for (const f of fields) add(f.table, f.column);
  for (const a of spec.aggregates ?? []) add(a.table, a.column ?? undefined);
  for (const c of sources[0].columns) {
    if (out.length >= DEFAULT_DETAIL_COLUMNS) break;
    add(aliases[0], c.name);
  }
  return out;
}

/**
 * Derive the detail spec. `keys` maps group field names to clicked values; unknown
 * names are rejected. `columns` optionally replaces the default detail columns.
 */
export function deriveDetailSpec(
  spec: JoinedReportSpec,
  fields: GroupField[],
  keys: Record<string, DrillValue>,
  columns: ColumnRef[],
): { spec: JoinedReportSpec; applied: { field: string; value: DrillValue }[] } {
  if (fields.length === 0 && !spec.aggregates?.length)
    throw bad('NOT_DRILLABLE', 'This report is not grouped, so there is nothing to drill into.');
  const names = Object.keys(keys);
  const applied: { field: string; value: DrillValue }[] = [];
  const drillFilters: FilterSpec[] = [];
  for (const n of names) {
    const f = fields.find((x) => x.name === n);
    if (!f)
      throw bad(
        'INVALID_DRILL_FIELD',
        `${JSON.stringify(n)} is not a group field of this report, so it cannot be drilled on.`,
      );
    const v = keys[n];
    if (v !== null && typeof v !== 'string' && typeof v !== 'number')
      throw bad('INVALID_DRILL_VALUE', `The value for ${n} must be text, a number or null.`);
    if (typeof v === 'number' && !Number.isFinite(v))
      throw bad('INVALID_DRILL_VALUE', `The value for ${n} is not a finite number.`);
    drillFilters.push(
      v === null
        ? { table: f.table, column: f.column, op: 'IS_NULL' }
        : { table: f.table, column: f.column, op: '=', value: v },
    );
    applied.push({ field: n, value: v });
  }
  if (columns.length === 0) throw bad('EMPTY_SELECTION', 'Choose at least one detail column.');
  if (columns.length > MAX_DETAIL_COLUMNS)
    throw bad('TOO_MANY_COLUMNS', `A drill can show at most ${MAX_DETAIL_COLUMNS} columns.`);

  const orig: FilterItem[] = spec.filters ?? [];
  let filters: FilterItem[];
  if (orig.length === 0) filters = drillFilters;
  else if ((spec.filterLogic ?? 'AND') === 'AND' || orig.length === 1)
    filters = [...orig, ...drillFilters];
  else {
    if (orig.some(isGroup))
      throw bad(
        'DRILL_UNSUPPORTED',
        'Drill-down is not available for reports whose filters combine OR with filter groups.',
      );
    filters = [{ logic: 'OR', filters: orig as FilterSpec[] }, ...drillFilters];
  }
  const count = filters.reduce((n, f) => n + (isGroup(f) ? f.filters.length : 1), 0);
  if (count > MAX_FILTERS)
    throw bad(
      'TOO_MANY_FILTERS',
      `The drilled report would need more than ${MAX_FILTERS} filters.`,
    );

  return {
    spec: {
      schema: spec.schema,
      table: spec.table,
      ...(spec.alias ? { alias: spec.alias } : {}),
      ...(spec.joins?.length ? { joins: spec.joins } : {}),
      columns,
      sort: (spec.sort ?? []).filter((s) => !s.aggregate && s.column),
      filters,
      filterLogic: 'AND',
    },
    applied,
  };
}

/** Breadcrumb text for one drill step, e.g. "West" or "West / 2024". */
export function drillLabel(applied: { value: DrillValue }[]): string {
  if (applied.length === 0) return 'All rows';
  return applied.map((a) => (a.value === null ? '(empty)' : String(a.value))).join(' / ');
}

/** Map clicked values onto the target report's parameters. */
export function mapTargetValues(
  drill: DrillDef,
  keys: Record<string, DrillValue>,
  targetParams: { name: string; fixed?: boolean }[],
): Record<string, string | number | null> {
  const mapped = new Set(drill.mapping.map((m) => m.field));
  for (const k of Object.keys(keys))
    if (!mapped.has(k))
      throw bad(
        'INVALID_DRILL_FIELD',
        `${JSON.stringify(k)} is not mapped to a parameter of the drill target.`,
      );
  const out: Record<string, string | number | null> = {};
  for (const m of drill.mapping) {
    const p = targetParams.find((x) => x.name === m.parameter && !x.fixed);
    if (!p)
      throw bad(
        'INVALID_DRILL_TARGET',
        `The drill target no longer has a parameter named ${m.parameter}.`,
      );
    if (!(m.field in keys)) continue;
    const v = keys[m.field];
    if (v !== null && typeof v !== 'string' && typeof v !== 'number')
      throw bad('INVALID_DRILL_VALUE', `The value for ${m.field} must be text, a number or null.`);
    out[p.name] = v;
  }
  return out;
}
