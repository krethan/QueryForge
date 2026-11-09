import { z } from 'zod';
import type { Cell } from '../sql/results.js';
import { pivotTable, type PivotResult } from './pivot.js';

/** Small Carbon-friendly light backgrounds and their high-contrast foregrounds. */
export const FORMAT_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'gray',
] as const;
export const COLOR_HEX = {
  red: { bg: '#fff1f1', fg: '#a2191f' },
  orange: { bg: '#fff2e8', fg: '#8a3800' },
  yellow: { bg: '#fcf4d6', fg: '#684e00' },
  green: { bg: '#defbe6', fg: '#0e6027' },
  teal: { bg: '#d9f4f2', fg: '#005d5d' },
  blue: { bg: '#edf5ff', fg: '#0043ce' },
  purple: { bg: '#f6f0ff', fg: '#6929c4' },
  gray: { bg: '#e0e0e0', fg: '#161616' },
} as const;
export const formatRuleSchema = z
  .object({
    /** Result-column output name, including calculated / aggregate / total aliases. */
    column: z.string().trim().min(1).max(128),
    op: z.enum(['>', '>=', '<', '<=', '=', '<>', 'between', 'contains', 'is null']),
    value: z
      .union([z.string().max(1000), z.number().finite()])
      .nullable()
      .optional(),
    value2: z
      .union([z.string().max(1000), z.number().finite()])
      .nullable()
      .optional(),
    color: z.enum(FORMAT_COLORS),
    scope: z.enum(['cell', 'row']),
  })
  .strict();
export const formattingSchema = z
  .object({ version: z.literal(1), rules: z.array(formatRuleSchema).max(20) })
  .strict();
export type FormatRule = z.infer<typeof formatRuleSchema>;
export type Formatting = z.infer<typeof formattingSchema>;
export interface FormatStyle {
  color: FormatRule['color'];
  scope: 'cell' | 'row';
}

export function matches(r: FormatRule, value: Cell): boolean {
  if (r.op !== 'is null' && r.value == null) return false;
  if (r.op === 'between' && r.value2 == null) return false;
  if (r.op === 'is null') return value === null;
  if (value === null || typeof value === 'object' || r.value == null) return false;
  if (r.op === 'contains')
    return String(value).toLowerCase().includes(String(r.value).toLowerCase());
  if (r.op === 'between' && r.value2 == null) return false;
  const c = compareValues(value, r.value);
  switch (r.op) {
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '=':
      return c === 0;
    case '<>':
      return c !== 0;
    case 'between':
      return c >= 0 && compareValues(value, r.value2 as Cell) <= 0;
    default:
      return false;
  }
}
/** Exact plain-decimal comparison including >15-digit IBM DECIMAL values. */
export function compareValues(a: Cell, b: Cell): number {
  const decimal = (s: Cell) =>
    typeof s === 'number' && Number.isFinite(s)
      ? String(s)
      : typeof s === 'string'
        ? s.trim()
        : null;
  const parts = (s: string) => {
    const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return null;
    const i = m[2].replace(/^0+/, '');
    const f = (m[3] ?? '').replace(/0+$/, '');
    return { neg: m[1] === '-' && Boolean(i || f), i, f };
  };
  const sa = decimal(a);
  const sb = decimal(b);
  const na = sa !== null ? parts(sa) : null;
  const nb = sb !== null ? parts(sb) : null;
  if (na && nb) {
    if (na.neg !== nb.neg) return na.neg ? -1 : 1;
    let c =
      na.i.length !== nb.i.length
        ? na.i.length - nb.i.length
        : na.i < nb.i
          ? -1
          : na.i > nb.i
            ? 1
            : 0;
    if (c === 0) {
      const n = Math.max(na.f.length, nb.f.length);
      const af = na.f.padEnd(n, '0');
      const bf = nb.f.padEnd(n, '0');
      c = af < bf ? -1 : af > bf ? 1 : 0;
    }
    return c === 0 ? 0 : na.neg ? -Math.sign(c) : Math.sign(c);
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Styles by original result row, unaffected by browser filtering/sorting. */
export function matchFormatting(
  formatting: Formatting | null,
  columns: { name: string }[],
  rows: Cell[][],
): (FormatStyle | null)[][] {
  const rules = (formatting?.rules ?? [])
    .map((rule) => ({
      rule,
      index: columns.findIndex((c) => c.name.toLowerCase() === rule.column.toLowerCase()),
    }))
    .filter((r) => r.index >= 0);
  return rows.map((row) => {
    const whole = rules.find((r) => r.rule.scope === 'row' && matches(r.rule, row[r.index]));
    return columns.map((_, col) => {
      const own = rules.find((r) => r.index === col && matches(r.rule, row[r.index]));
      return own
        ? { color: own.rule.color, scope: own.rule.scope }
        : whole
          ? { color: whole.rule.color, scope: 'row' }
          : null;
    });
  });
}

/** Pivot long-form matches determine cells; a row field match spans its whole grid row. Totals use the measure name. */
export function matchPivotFormatting(
  formatting: Formatting | null,
  pivot: PivotResult,
): (FormatStyle | null)[][] {
  const table = pivotTable(pivot);
  const named: Formatting = {
    version: 1,
    rules: (formatting?.rules ?? []).map((r) => ({
      ...r,
      column:
        r.column.toLowerCase() === pivot.value.label.toLowerCase() ||
        r.column.toLowerCase() === 'pivot_value'
          ? 'PIVOT_VALUE'
          : r.column,
    })),
  };
  return matchFormatting(
    named,
    table.columns.map((c, i) => ({
      ...c,
      name: i < pivot.rowFields.length ? pivot.rowFields[i].name : 'PIVOT_VALUE',
    })),
    table.rows,
  );
}

/** Pivot measure aliases are flattened to the ordinary table exported to Excel. */
export function pivotExportFormatting(
  formatting: Formatting | null,
  pivot: PivotResult,
): Formatting | null {
  if (!formatting) return null;
  return {
    version: 1,
    rules: formatting.rules.map((r) => ({
      ...r,
      column:
        r.column.toLowerCase() === pivot.value.label.toLowerCase() ||
        r.column.toLowerCase() === 'pivot_value'
          ? 'PIVOT_VALUE'
          : r.column,
    })),
  };
}
