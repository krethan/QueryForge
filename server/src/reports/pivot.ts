import type { AggregateSpec } from '../catalog/filter-builder.js';
import type { ColumnRef, JoinedReportSpec } from '../catalog/join-builder.js';
import type { Cell, ResultColumn } from '../sql/results.js';
import { AppError } from '../util/errors.js';

/**
 * Pivot (crosstab) reports.
 *
 * A pivot is never turned into dynamic-column SQL. The server builds an ordinary
 * GROUP BY query (row fields + the column field, one aggregate), runs it with bound
 * parameters, and reshapes the grouped rows into a grid here, adding row, column
 * and grand totals. The browser only ever sends the pivot definition.
 */

export const PIVOT_FNS = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'] as const;
export type PivotFn = (typeof PIVOT_FNS)[number];
/** Most distinct column-field values a pivot may spread across the page. */
export const MAX_PIVOT_COLUMNS = 50;
/** Most grouped rows (row x column combinations) read for one pivot. */
export const MAX_PIVOT_GROUPS = 10_000;
export const MAX_PIVOT_ROW_FIELDS = 5;
/** Output names of the grouped query. Hidden SUM/COUNT make AVG totals exact. */
export const PIVOT_VALUE = 'PIVOT_VALUE';
export const PIVOT_SUM = 'PIVOT_SUM';
export const PIVOT_COUNT = 'PIVOT_COUNT';
export const NULL_LABEL = '(null)';

export interface PivotSpec {
  rows: ColumnRef[];
  column: ColumnRef;
  value: { fn: PivotFn; table?: string; column?: string | null };
}

const bad = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(400, code, message, details);

const sameRef = (a: ColumnRef, b: ColumnRef) =>
  (a.table ?? '').toUpperCase() === (b.table ?? '').toUpperCase() &&
  a.column.toUpperCase() === b.column.toUpperCase();

/**
 * The grouped report spec a pivot runs as. Pivot reports choose their layout
 * through the pivot only, so columns, sorting, grouping and totals must be empty.
 */
export function expandPivot(spec: JoinedReportSpec & { pivot?: PivotSpec }): JoinedReportSpec {
  const { pivot, ...rest } = spec;
  if (!pivot) return rest;
  if (
    rest.columns?.length ||
    rest.sort?.length ||
    rest.groupBy?.length ||
    rest.aggregates?.length ||
    rest.having?.length
  )
    throw bad(
      'PIVOT_CONFLICT',
      'A pivot report sets its own rows, column and value; remove the selected columns, sorting, grouping and totals.',
    );
  const rows = pivot.rows ?? [];
  if (rows.length < 1 || rows.length > MAX_PIVOT_ROW_FIELDS)
    throw bad('INVALID_PIVOT', `Choose between 1 and ${MAX_PIVOT_ROW_FIELDS} row fields.`);
  if (!pivot.column?.column) throw bad('INVALID_PIVOT', 'Choose a column field.');
  if (rows.some((r) => sameRef(r, pivot.column)))
    throw bad('INVALID_PIVOT', 'The column field cannot also be a row field.');
  const fn = pivot.value?.fn;
  if (!PIVOT_FNS.includes(fn)) throw bad('INVALID_PIVOT', 'Choose SUM, COUNT, AVG, MIN or MAX.');
  const col = pivot.value.column || null;
  if (!col && fn !== 'COUNT') throw bad('INVALID_PIVOT', `${fn} needs a value field.`);
  const vt = pivot.value.table;
  const agg = (f: AggregateSpec['fn'], name: string): AggregateSpec => ({
    fn: f,
    ...(vt ? { table: vt } : {}),
    column: col,
    name,
  });
  const fields = [...rows, pivot.column];
  return {
    ...rest,
    columns: [],
    groupBy: fields,
    sort: fields.map((f) => ({
      ...(f.table ? { table: f.table } : {}),
      column: f.column,
      direction: 'ASC' as const,
    })),
    aggregates: [
      agg(fn, PIVOT_VALUE),
      ...(fn === 'AVG' ? [agg('SUM', PIVOT_SUM), agg('COUNT', PIVOT_COUNT)] : []),
    ],
    having: [],
  };
}

// ---------- exact decimal arithmetic ----------

interface Dec {
  n: bigint;
  s: number;
}
const DEC = /^([+-]?)(\d+)(?:\.(\d+))?$/;
function toDec(v: Cell): Dec | null {
  let str: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    str = Number.isInteger(v) ? BigInt(v).toString() : String(v);
  } else if (typeof v === 'string') str = v.trim();
  else return null;
  const m = DEC.exec(str);
  if (!m) return null;
  const frac = m[3] ?? '';
  const n = BigInt(m[2] + frac);
  return { n: m[1] === '-' ? -n : n, s: frac.length };
}
const scaleTo = (d: Dec, s: number): bigint => d.n * 10n ** BigInt(s - d.s);
const add = (a: Dec, b: Dec): Dec => {
  const s = Math.max(a.s, b.s);
  return { n: scaleTo(a, s) + scaleTo(b, s), s };
};
const cmp = (a: Dec, b: Dec): number => {
  const s = Math.max(a.s, b.s);
  const x = scaleTo(a, s);
  const y = scaleTo(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
};
function decString(d: Dec): string {
  const neg = d.n < 0n;
  let digits = (neg ? -d.n : d.n).toString();
  if (d.s === 0) return (neg ? '-' : '') + digits;
  digits = digits.padStart(d.s + 1, '0');
  const out = `${digits.slice(0, -d.s)}.${digits.slice(-d.s)}`;
  return (neg ? '-' : '') + out;
}
/** Truncating division (as Db2 does for decimal division), to `scale` places. */
function divide(a: Dec, b: Dec, scale: number): Dec | null {
  if (b.n === 0n) return null;
  const num = a.n * 10n ** BigInt(scale + b.s);
  const den = b.n * 10n ** BigInt(a.s);
  return { n: num / den, s: scale };
}

/** Total in the same representation (JS number vs exact string) the database returned. */
function emit(d: Dec, asNumber: boolean): Cell {
  return asNumber ? Number(decString(d)) : decString(d);
}

// ---------- pivoting ----------

export type PivotKey = string | number | null;

export interface PivotField {
  name: string;
  label: string;
  kind: ResultColumn['kind'];
  scale: number;
}

export interface PivotResult {
  rowFields: PivotField[];
  columnField: PivotField;
  value: { fn: PivotFn; label: string; kind: ResultColumn['kind']; scale: number };
  /** Distinct column-field values, sorted, with NULL last as its own column. */
  columns: { label: string; value: PivotKey }[];
  rows: {
    keys: PivotKey[];
    labels: string[];
    /** null where the cell's group returned NULL or has no rows (see `present`). */
    cells: Cell[];
    /** false where no source rows fall in that row/column. */
    present: boolean[];
    total: Cell;
  }[];
  columnTotals: Cell[];
  grandTotal: Cell;
  /** Grouped rows read from the database. */
  groupCount: number;
  /** True when every total was computed exactly (false: float arithmetic was used). */
  exact: boolean;
  /** The grouped rows without the hidden AVG helper columns, for charts. */
  long: { columns: ResultColumn[]; rows: Cell[][] };
}

const keyOf = (v: Cell): PivotKey => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return String(v);
  return '[binary]';
};
const labelOf = (v: PivotKey) => (v === null ? NULL_LABEL : String(v));
const mapKey = (v: PivotKey) => (v === null ? '\u0000null' : `${typeof v}:${v}`);

function compareKeys(a: PivotKey, b: PivotKey, numeric: boolean): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (numeric) {
    const x = toDec(a);
    const y = toDec(b);
    if (x && y) return cmp(x, y);
  }
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const NUMERIC: ResultColumn['kind'][] = ['integer', 'decimal', 'float'];

class Acc {
  private dec: Dec | null = null;
  private float = 0;
  private best: Cell = null;
  private sum: Dec | null = null;
  private count: Dec | null = null;
  private any = false;
  inexact = false;
  constructor(
    private readonly fn: PivotFn,
    private readonly numeric: boolean,
  ) {}
  /** Adds one grouped cell (value, plus SUM/COUNT for AVG). */
  push(v: Cell, sum?: Cell, count?: Cell) {
    if (this.fn === 'AVG') {
      const s = toDec(sum ?? null);
      const c = toDec(count ?? null);
      if (c) this.count = this.count ? add(this.count, c) : c;
      if (s) this.sum = this.sum ? add(this.sum, s) : s;
      else if (sum !== null && sum !== undefined) this.inexact = true;
      return;
    }
    if (v === null || v === undefined) return;
    if (this.fn === 'MIN' || this.fn === 'MAX') {
      if (!this.any || this.better(v, this.best)) this.best = v;
      this.any = true;
      return;
    }
    this.any = true;
    const d = toDec(v);
    if (d && !this.inexact) this.dec = this.dec ? add(this.dec, d) : d;
    else {
      if (!this.inexact) this.float = this.dec ? Number(decString(this.dec)) : 0;
      this.inexact = true;
      this.float += Number(v);
    }
  }
  private better(v: Cell, cur: Cell) {
    const c = compareKeys(keyOf(v), keyOf(cur), this.numeric);
    return this.fn === 'MIN' ? c < 0 : c > 0;
  }
  result(asNumber: boolean, kind: ResultColumn['kind'], scale: number): Cell {
    if (this.fn === 'MIN' || this.fn === 'MAX') return this.any ? this.best : null;
    if (this.fn === 'AVG') {
      if (!this.sum || !this.count) return null;
      // Db2 returns AVG of an integer column as an integer; match it.
      const places = kind === 'integer' ? 0 : Math.max(scale, this.sum.s, 2);
      const d = divide(this.sum, this.count, places);
      return d ? emit(d, asNumber) : null;
    }
    if (!this.any) return this.fn === 'COUNT' ? 0 : null;
    if (this.inexact) return this.float;
    return this.dec ? emit(this.dec, asNumber) : null;
  }
}

/**
 * Reshapes grouped rows (row fields..., column field, PIVOT_VALUE[, PIVOT_SUM, PIVOT_COUNT])
 * into a grid with totals. Throws when the column field has too many distinct values.
 */
export function pivotRows(
  columns: ResultColumn[],
  rows: Cell[][],
  rowFieldCount: number,
  fn: PivotFn,
  valueLabel: string,
  opts: { maxColumns?: number } = {},
): PivotResult {
  const maxColumns = opts.maxColumns ?? MAX_PIVOT_COLUMNS;
  const n = rowFieldCount;
  const field = (c: ResultColumn): PivotField => ({
    name: c.name,
    label: c.label || c.name,
    kind: c.kind,
    scale: c.scale ?? 0,
  });
  const colField = columns[n];
  const valueCol = columns[n + 1];
  if (!colField || !valueCol)
    throw new AppError(500, 'PIVOT_SHAPE', 'Unexpected pivot query shape.');
  const colNumeric = NUMERIC.includes(colField.kind);
  const valNumeric = NUMERIC.includes(valueCol.kind);

  // distinct column values
  const distinct = new Map<string, PivotKey>();
  for (const r of rows) {
    const k = keyOf(r[n]);
    distinct.set(mapKey(k), k);
    if (distinct.size > maxColumns)
      throw bad(
        'PIVOT_TOO_MANY_COLUMNS',
        `${field(colField).label} has more than ${maxColumns} distinct values, too many to show as columns. Add a filter on ${field(colField).label} to narrow it down, or choose a column field with fewer values.`,
        { limit: maxColumns, column: colField.name },
      );
  }
  const colKeys = [...distinct.values()].sort((a, b) => compareKeys(a, b, colNumeric));
  const colIndex = new Map(colKeys.map((k, i) => [mapKey(k), i]));

  // rows in database order
  type Row = { keys: PivotKey[]; cells: Cell[]; present: boolean[]; raw: Cell[][] };
  const out = new Map<string, Row>();
  let asNumber = false;
  for (const r of rows) {
    const keys = r.slice(0, n).map(keyOf);
    const id = keys.map(mapKey).join('\u0001');
    let row = out.get(id);
    if (!row) {
      row = {
        keys,
        cells: colKeys.map(() => null),
        present: colKeys.map(() => false),
        raw: colKeys.map(() => []),
      };
      out.set(id, row);
    }
    const ci = colIndex.get(mapKey(keyOf(r[n])))!;
    row.cells[ci] = r[n + 1] ?? null;
    row.present[ci] = true;
    row.raw[ci] = r.slice(n + 1);
    if (typeof r[n + 1] === 'number') asNumber = true;
  }

  const acc = () => new Acc(fn, valNumeric);
  const colAccs = colKeys.map(acc);
  const grand = acc();
  const scale = valueCol.scale ?? 0;
  const kind = valueCol.kind;
  let exact = true;
  const resultRows = [...out.values()].map((row) => {
    const ra = acc();
    row.raw.forEach((raw, ci) => {
      if (!row.present[ci]) return;
      const [v, s, c] = raw;
      ra.push(v, s, c);
      colAccs[ci].push(v, s, c);
      grand.push(v, s, c);
    });
    if (ra.inexact) exact = false;
    return {
      keys: row.keys,
      labels: row.keys.map(labelOf),
      cells: row.cells,
      present: row.present,
      total: ra.result(asNumber, kind, scale),
    };
  });
  if (grand.inexact || colAccs.some((a) => a.inexact)) exact = false;
  const visible = columns.slice(0, n + 2);
  return {
    rowFields: columns.slice(0, n).map(field),
    columnField: field(colField),
    value: {
      fn,
      label: valueLabel,
      kind,
      scale: fn === 'AVG' && kind !== 'integer' ? Math.max(scale, 2) : scale,
    },
    columns: colKeys.map((k) => ({ label: labelOf(k), value: k })),
    rows: resultRows,
    columnTotals: colAccs.map((a) => a.result(asNumber, kind, scale)),
    grandTotal: grand.result(asNumber, kind, scale),
    groupCount: rows.length,
    exact,
    long: { columns: visible, rows: rows.map((r) => r.slice(0, n + 2)) },
  };
}

const TYPE_OF: Partial<Record<ResultColumn['kind'], string>> = {
  integer: 'INTEGER',
  decimal: 'DECIMAL',
  float: 'DOUBLE',
  date: 'DATE',
  timestamp: 'TIMESTAMP',
};

/** The pivot as a flat table (header, one row per row-key, a totals row) for Excel. */
export function pivotTable(p: PivotResult): { columns: ResultColumn[]; rows: Cell[][] } {
  const base = (
    key: string,
    label: string,
    kind: ResultColumn['kind'],
    scale: number,
  ): ResultColumn => ({
    key,
    name: label,
    label,
    type: TYPE_OF[kind] ?? 'VARCHAR',
    kind,
    precision: 15,
    scale,
    nullable: true,
  });
  const valueKind = p.value.kind;
  const cols = [
    ...p.rowFields.map((f, i) => base(`r${i}`, f.label, f.kind, f.scale)),
    ...p.columns.map((c, i) => base(`c${i}`, c.label, valueKind, p.value.scale)),
    base('total', 'Total', valueKind, p.value.scale),
  ];
  const rows: Cell[][] = p.rows.map((r) => [
    ...r.keys.map((k) => (k === null ? NULL_LABEL : k)),
    ...r.cells,
    r.total,
  ]);
  rows.push(['Total', ...p.rowFields.slice(1).map(() => null), ...p.columnTotals, p.grandTotal]);
  return { columns: cols, rows };
}

export const PIVOT_FN_LABELS: Record<PivotFn, string> = {
  SUM: 'Sum',
  COUNT: 'Count',
  AVG: 'Average',
  MIN: 'Minimum',
  MAX: 'Maximum',
};
