import type {
  AggregateFn,
  FilterLogic,
  FilterOp,
  HavingOp,
  ReportAggregate,
  ReportFilter,
  ReportFilterGroup,
  ReportHaving,
  SchemaColumn,
} from '../api/types';

/**
 * Report Builder editing state for filters and totals, and its conversion to and
 * from the `ReportSpec` the server validates. Columns are referred to by
 * `${tableKey}|${column}`; the page maps table keys to SQL aliases.
 */

export type ValueKind = 'integer' | 'decimal' | 'date' | 'time' | 'timestamp' | 'text' | 'none';

export function valueKind(c: Pick<SchemaColumn, 'type' | 'scale'> | undefined): ValueKind {
  if (!c) return 'none';
  const t = c.type.toUpperCase().trim();
  if (/^(SMALLINT|INTEGER|INT|BIGINT)$/.test(t)) return 'integer';
  if (/^(DECIMAL|NUMERIC)$/.test(t)) return (c.scale ?? 0) === 0 ? 'integer' : 'decimal';
  if (/^(DECFLOAT|REAL|FLOAT|DOUBLE|DOUBLE PRECISION)$/.test(t)) return 'decimal';
  if (t === 'DATE') return 'date';
  if (t === 'TIME') return 'time';
  if (t === 'TIMESTAMP' || t === 'TIMESTMP') return 'timestamp';
  if (/^(CHAR|CHARACTER|VARCHAR|CLOB|GRAPHIC|VARGRAPHIC|DBCLOB|NCHAR|NVARCHAR|NCLOB)$/.test(t))
    return 'text';
  return 'none';
}
export const isNumericKind = (k: ValueKind) => k === 'integer' || k === 'decimal';

export const OP_LABELS: Record<FilterOp, string> = {
  '=': 'equals',
  '<>': 'does not equal',
  '<': 'less than',
  '<=': 'at most',
  '>': 'greater than',
  '>=': 'at least',
  BETWEEN: 'between',
  IN: 'is one of',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts with',
  ENDS_WITH: 'ends with',
  IS_NULL: 'is empty (NULL)',
  IS_NOT_NULL: 'is not empty',
};
const COMPARE: FilterOp[] = ['=', '<>', '<', '<=', '>', '>=', 'BETWEEN', 'IN'];
const NULLS: FilterOp[] = ['IS_NULL', 'IS_NOT_NULL'];
/** Operators offered for a column of this kind (binary/other columns only test NULL). */
export function opsFor(kind: ValueKind): FilterOp[] {
  if (kind === 'none') return NULLS;
  if (kind === 'text') return [...COMPARE, 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', ...NULLS];
  return [...COMPARE, ...NULLS];
}
export const takesValue = (op: FilterOp) => !NULLS.includes(op);
/** "Ask when run" works for single-value operators and BETWEEN. */
export const canAsk = (op: FilterOp) => takesValue(op) && op !== 'IN';

export const MAX_IN_VALUES = 100;
export const MAX_FILTERS = 30;
export const MAX_GROUPS = 10;
export const MAX_AGGREGATES = 20;
export const MAX_HAVING = 10;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;

export interface FilterRow {
  key: string;
  pick: string;
  op: FilterOp;
  value: string;
  value2: string;
  /** IN values, one per line (commas also split). */
  values: string;
  ask: boolean;
  askName: string;
  askLabel: string;
}
export interface FilterGroupNode {
  key: string;
  kind: 'group';
  logic: FilterLogic;
  rows: FilterRow[];
}
export type FilterNode = (FilterRow & { kind: 'row' }) | FilterGroupNode;

export interface AggRow {
  key: string;
  fn: AggregateFn;
  /** '' = COUNT(*) */
  pick: string;
  name: string;
}
export interface HavingRow {
  key: string;
  /** Key of the AggRow (its name can still be edited). */
  aggregate: string;
  op: HavingOp;
  value: string;
  value2: string;
}

export const AGG_LABELS: Record<AggregateFn, string> = {
  COUNT: 'Count',
  COUNT_DISTINCT: 'Count distinct',
  SUM: 'Sum',
  AVG: 'Average',
  MIN: 'Minimum',
  MAX: 'Maximum',
};

export const splitValues = (s: string) =>
  s
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);

/** Default friendly name for a total, e.g. "Total AMOUNT", "Count of rows". */
export function defaultAggName(fn: AggregateFn, column: string | null) {
  if (!column) return 'Row count';
  const c = column.replace(/[^A-Za-z0-9_ ]/g, '_');
  const label = {
    COUNT: 'Count',
    COUNT_DISTINCT: 'Distinct',
    SUM: 'Total',
    AVG: 'Average',
    MIN: 'Min',
    MAX: 'Max',
  }[fn];
  return `${label} ${c}`.slice(0, 64);
}
export const aggName = (a: AggRow, column: (pick: string) => string | null) =>
  a.name.trim() || defaultAggName(a.fn, a.pick ? column(a.pick) : null);

export const suggestParamName = (column: string, used: Set<string>) => {
  let base = column.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!/^[A-Z]/.test(base)) base = `P_${base}`;
  if (base.startsWith('QF_')) base = `P_${base}`;
  base = base.slice(0, 25);
  let n = base;
  for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
  return n;
};

/** Client-side problems shown before the server is asked (the server re-checks everything). */
export function filterProblems(row: FilterRow, kind: ValueKind): string | null {
  if (!row.pick) return 'Choose a column.';
  if (row.ask) {
    if (!PARAM_NAME.test(row.askName))
      return 'Parameter name: a letter first, then letters, digits or _ (max 30).';
    if (row.askName.toUpperCase().startsWith('QF_')) return 'Names starting with QF_ are reserved.';
    if (row.op === 'BETWEEN' && row.askName.length > 25)
      return 'BETWEEN parameter names are at most 25 characters (_FROM/_TO are added).';
    return null;
  }
  if (!takesValue(row.op)) return null;
  if (row.op === 'IN') {
    const v = splitValues(row.values);
    if (v.length === 0) return 'Enter at least one value.';
    if (v.length > MAX_IN_VALUES) return `At most ${MAX_IN_VALUES} values.`;
    return v.map((x) => badValue(x, kind)).find(Boolean) ?? null;
  }
  if (!row.value.trim()) return 'Enter a value.';
  if (row.op === 'BETWEEN' && !row.value2.trim()) return 'Enter both values.';
  return badValue(row.value, kind) ?? (row.op === 'BETWEEN' ? badValue(row.value2, kind) : null);
}
function badValue(v: string, kind: ValueKind): string | null {
  const s = v.trim();
  if (kind === 'integer' && !/^[-+]?\d{1,18}$/.test(s)) return `${s} is not a whole number.`;
  if (kind === 'decimal' && !/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return `${s} is not a number.`;
  if (kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'Use YYYY-MM-DD.';
  if (kind === 'time' && !/^\d{2}[:.]\d{2}([:.]\d{2})?$/.test(s)) return 'Use HH:MM:SS.';
  if (
    kind === 'timestamp' &&
    !/^\d{4}-\d{2}-\d{2}([ T-]\d{2}[:.]\d{2}([:.]\d{2}(\.\d+)?)?)?$/.test(s)
  )
    return 'Use YYYY-MM-DD HH:MM:SS.';
  return null;
}

const typed = (v: string, kind: ValueKind): string | number =>
  isNumericKind(kind) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v.trim()) : v;

/** One row as the server's filter shape. */
export function toFilter(
  row: FilterRow,
  ref: (pick: string) => { table?: string; column: string },
  kind: ValueKind,
): ReportFilter {
  const f: ReportFilter = { ...ref(row.pick), op: row.op };
  if (!takesValue(row.op)) return f;
  if (row.op === 'IN') return { ...f, values: splitValues(row.values).map((v) => typed(v, kind)) };
  if (row.ask) {
    return {
      ...f,
      ask: {
        name: row.askName,
        label: row.askLabel.trim() || row.askName,
        ...(row.value.trim() ? { defaultValue: typed(row.value, kind) } : {}),
        ...(row.op === 'BETWEEN' && row.value2.trim()
          ? { defaultValue2: typed(row.value2, kind) }
          : {}),
      },
    };
  }
  return {
    ...f,
    value: typed(row.value, kind),
    ...(row.op === 'BETWEEN' ? { value2: typed(row.value2, kind) } : {}),
  };
}

export function toFilters(
  nodes: FilterNode[],
  ref: (pick: string) => { table?: string; column: string },
  kind: (pick: string) => ValueKind,
): (ReportFilter | ReportFilterGroup)[] {
  return nodes.flatMap((n): (ReportFilter | ReportFilterGroup)[] => {
    if (n.kind === 'row') return n.pick ? [toFilter(n, ref, kind(n.pick))] : [];
    const rows = n.rows.filter((r) => r.pick).map((r) => toFilter(r, ref, kind(r.pick)));
    return rows.length ? [{ logic: n.logic, filters: rows }] : [];
  });
}

export function toHaving(
  rows: HavingRow[],
  nameOfAgg: (key: string) => string | undefined,
): ReportHaving[] {
  return rows
    .filter((h) => nameOfAgg(h.aggregate))
    .map((h) => ({
      aggregate: nameOfAgg(h.aggregate)!,
      op: h.op,
      value: h.value.trim() === '' ? null : typed(h.value, 'decimal'),
      ...(h.op === 'BETWEEN'
        ? { value2: h.value2.trim() === '' ? null : typed(h.value2, 'decimal') }
        : {}),
    }));
}

export function toAggregates(
  rows: AggRow[],
  ref: (pick: string) => { table?: string; column: string },
  column: (pick: string) => string | null,
): ReportAggregate[] {
  return rows.map((a) => ({
    fn: a.fn,
    ...(a.pick ? ref(a.pick) : {}),
    name: aggName(a, column),
  }));
}

// ---- reopening a saved definition ----

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function fromFilter(f: ReportFilter, pick: string, key: () => string): FilterRow {
  return {
    key: key(),
    pick,
    op: f.op,
    value: str(f.ask ? f.ask.defaultValue : f.value),
    value2: str(f.ask ? f.ask.defaultValue2 : f.value2),
    values: (f.values ?? []).map(String).join('\n'),
    ask: Boolean(f.ask),
    askName: f.ask?.name ?? '',
    askLabel: f.ask?.label ?? '',
  };
}
