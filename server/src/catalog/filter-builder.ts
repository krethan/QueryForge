/**
 * Report Builder filters (WHERE), aggregates and HAVING.
 *
 * SECURITY: as in join-builder.ts the client only sends names, operators from a fixed
 * list and values. Every column is resolved against cached catalog metadata, every
 * operator is mapped to SQL text written here, and every value - fixed or "Ask when
 * run" - is bound to a `?` marker through a ParameterDef. No client text is ever
 * concatenated into the statement.
 */
import { AppError } from '../util/errors.js';
import {
  coerce,
  MAX_PARAMS,
  type ParameterDef,
  type ParameterType,
} from '../reports/parameters.js';
import type { CatalogColumn } from './sql-builder.js';
import { typeCategory } from './join-builder.js';

export const FILTER_OPS = [
  '=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  'BETWEEN',
  'IN',
  'CONTAINS',
  'STARTS_WITH',
  'ENDS_WITH',
  'IS_NULL',
  'IS_NOT_NULL',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const COMPARISON_OPS = ['=', '<>', '<', '<=', '>', '>='] as const;
export const HAVING_OPS = [...COMPARISON_OPS, 'BETWEEN'] as const;
export type HavingOp = (typeof HAVING_OPS)[number];

export const MAX_FILTERS = 30;
export const MAX_FILTER_GROUPS = 10;
export const MAX_IN_VALUES = 100;
export const MAX_AGGREGATES = 20;
export const MAX_HAVING = 10;
export const MAX_VALUE_LENGTH = 1000;
/** Names of generated (fixed) parameters; users may not use this prefix. */
export const RESERVED_PARAM_PREFIX = 'QF_';
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;

export type Logic = 'AND' | 'OR';
export type Scalar = string | number;

/** "Ask when run": the filter value becomes a report parameter. */
export interface AskSpec {
  name: string;
  label: string;
  defaultValue?: Scalar | null;
  /** Second bound for BETWEEN (parameters `<name>_FROM` and `<name>_TO`). */
  defaultValue2?: Scalar | null;
}

export interface FilterSpec {
  table?: string;
  column: string;
  op: FilterOp;
  value?: Scalar | null;
  value2?: Scalar | null;
  values?: Scalar[];
  ask?: AskSpec | null;
}
/** One optional level of grouping: `( a OR b )` inside a top-level AND (or vice versa). */
export interface FilterGroup {
  logic: Logic;
  filters: FilterSpec[];
}
export type FilterItem = FilterSpec | FilterGroup;
export const isGroup = (f: FilterItem): f is FilterGroup =>
  !!f && typeof f === 'object' && Array.isArray((f as FilterGroup).filters);

export const AGGREGATE_FNS = ['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];
export interface AggregateSpec {
  fn: AggregateFn;
  table?: string;
  /** Omitted for COUNT(*) only. */
  column?: string | null;
  /** Friendly output name, e.g. "Total amount". */
  name?: string;
}
export interface HavingSpec {
  /** Output name of an aggregate in the same report. */
  aggregate: string;
  op: HavingOp;
  value: Scalar | null;
  value2?: Scalar | null;
}

/** What the builders need from join-builder: resolved columns and SQL references. */
export interface BuildContext {
  resolve(ref: { table?: string; column: unknown }, what: string): { i: number; c: CatalogColumn };
  colRef(i: number, c: CatalogColumn): string;
  label(i: number, c: CatalogColumn): string;
}

const bad = (code: string, message: string) => new AppError(400, code, message);

const INTEGER_TYPES = /^(SMALLINT|INTEGER|INT|BIGINT)$/;
/** Parameter type used to bind a value compared with column `c`. */
export function parameterTypeFor(c: CatalogColumn): ParameterType | null {
  const cat = typeCategory(c.type);
  if (cat === 'numeric')
    return INTEGER_TYPES.test(c.type.toUpperCase().trim()) ||
      (/^(DECIMAL|NUMERIC)$/.test(c.type.toUpperCase().trim()) && c.scale === 0)
      ? 'integer'
      : 'decimal';
  if (cat === 'date') return 'date';
  if (cat === 'char' || cat === 'time' || cat === 'timestamp') return 'string';
  return null;
}

const TIME = /^([01]\d|2[0-3])[:.][0-5]\d([:.][0-5]\d)?$/;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}([ T-]([01]\d|2[0-3])[:.][0-5]\d([:.][0-5]\d(\.\d{1,12})?)?)?$/;

/** Validate one value for column `c`; returns the stored (string) form. */
function checkValue(c: CatalogColumn, type: ParameterType, raw: unknown, what: string): string {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''))
    throw bad('MISSING_FILTER_VALUE', `${what} needs a value (use "is empty" to match NULL).`);
  if (typeof raw !== 'string' && typeof raw !== 'number')
    throw bad('INVALID_FILTER_VALUE', `${what} must be text or a number.`);
  if (typeof raw === 'number' && !Number.isFinite(raw))
    throw bad('INVALID_FILTER_VALUE', `${what} must be a finite number.`);
  const s = String(raw);
  if (s.length > MAX_VALUE_LENGTH)
    throw bad('INVALID_FILTER_VALUE', `${what} is longer than ${MAX_VALUE_LENGTH} characters.`);
  const cat = typeCategory(c.type);
  if (cat === 'time' && !TIME.test(s.trim()))
    throw bad('INVALID_FILTER_VALUE', `${what} must be a time (HH:MM:SS).`);
  if (cat === 'timestamp' && !TIMESTAMP.test(s.trim()))
    throw bad('INVALID_FILTER_VALUE', `${what} must be a timestamp (YYYY-MM-DD HH:MM:SS).`);
  const r = coerce({ name: 'v', label: what, type, required: true, defaultValue: null }, s);
  if (!r.ok) throw bad('INVALID_FILTER_VALUE', `${what} ${r.message}.`);
  return type === 'string' ? s : String(r.value);
}

/** Collects parameter definitions in marker order. */
export class ParamCollector {
  readonly defs: ParameterDef[] = [];
  private names = new Set<string>();
  private n = 0;

  /** A fixed (never prompted) value. */
  fixed(prefix: string, type: ParameterType, value: string, label: string, match?: Match) {
    const name = `${RESERVED_PARAM_PREFIX}${prefix}${++this.n}`;
    this.names.add(name.toUpperCase());
    this.defs.push({
      name,
      label: label.slice(0, 80),
      type,
      required: true,
      defaultValue: value,
      fixed: true,
      ...(match ? { match } : {}),
    });
    return '?';
  }

  /** An "Ask when run" report parameter. */
  ask(name: unknown, label: unknown, type: ParameterType, dflt: string | null, match?: Match) {
    if (typeof name !== 'string' || !PARAM_NAME.test(name))
      throw bad(
        'INVALID_PARAMETER_NAME',
        `Parameter name ${JSON.stringify(name)} must start with a letter and use only letters, digits and _ (max 30).`,
      );
    if (name.toUpperCase().startsWith(RESERVED_PARAM_PREFIX))
      throw bad(
        'INVALID_PARAMETER_NAME',
        `Parameter names starting with ${RESERVED_PARAM_PREFIX} are reserved.`,
      );
    if (this.names.has(name.toUpperCase()))
      throw bad('DUPLICATE_PARAMETER', `Parameter name "${name}" is used twice.`);
    const text = typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : name;
    this.names.add(name.toUpperCase());
    this.defs.push({
      name,
      label: text,
      type,
      required: true,
      defaultValue: dflt,
      ...(match ? { match } : {}),
    });
    if (this.defs.filter((d) => !d.fixed).length > MAX_PARAMS)
      throw bad('TOO_MANY_PARAMETERS', `A report can ask for at most ${MAX_PARAMS} values.`);
    return '?';
  }
}
type Match = 'contains' | 'startsWith' | 'endsWith';

const LIKE: Partial<Record<FilterOp, Match>> = {
  CONTAINS: 'contains',
  STARTS_WITH: 'startsWith',
  ENDS_WITH: 'endsWith',
};

function buildFilter(f: FilterSpec, ctx: BuildContext, p: ParamCollector): string {
  if (!f || typeof f !== 'object') throw bad('INVALID_FILTER', 'A filter row is malformed.');
  const op = String(f.op ?? '').toUpperCase() as FilterOp;
  if (!FILTER_OPS.includes(op))
    throw bad(
      'INVALID_FILTER_OPERATOR',
      `Filter operator ${JSON.stringify(f.op)} is not supported.`,
    );
  const { i, c } = ctx.resolve(f, 'Filter column');
  const ref = ctx.colRef(i, c);
  const what = `Filter on ${ctx.label(i, c)}`;
  if (op === 'IS_NULL') return `${ref} IS NULL`;
  if (op === 'IS_NOT_NULL') return `${ref} IS NOT NULL`;

  const type = parameterTypeFor(c);
  if (!type)
    throw bad(
      'UNSUPPORTED_FILTER_TYPE',
      `${ctx.label(i, c)} (${c.type}) can only be filtered with "is empty" / "is not empty".`,
    );
  const match = LIKE[op];
  if (match && typeCategory(c.type) !== 'char')
    throw bad(
      'INVALID_FILTER_OPERATOR',
      `"${op.toLowerCase().replace('_', ' ')}" only applies to text columns; ${ctx.label(i, c)} is ${c.type}.`,
    );
  const ask = f.ask ?? null;
  if (ask && op === 'IN')
    throw bad('INVALID_FILTER', `${what}: "Ask when run" is not available for "in list" filters.`);
  const optDefault = (v: unknown, w: string) =>
    v === null || v === undefined || v === '' ? null : checkValue(c, type, v, w);

  if (op === 'IN') {
    const values = Array.isArray(f.values) ? f.values : [];
    if (values.length === 0) throw bad('MISSING_FILTER_VALUE', `${what} needs at least one value.`);
    if (values.length > MAX_IN_VALUES)
      throw bad('TOO_MANY_VALUES', `${what} can list at most ${MAX_IN_VALUES} values.`);
    const seen = new Set<string>();
    const markers: string[] = [];
    for (const v of values) {
      const s = checkValue(c, type, v, what);
      if (seen.has(s)) continue;
      seen.add(s);
      markers.push(p.fixed('F', type, s, `${ctx.label(i, c)} in list`));
    }
    return `${ref} IN (${markers.join(', ')})`;
  }

  if (op === 'BETWEEN') {
    if (ask) {
      if (typeof ask.name !== 'string' || ask.name.length > 25)
        throw bad(
          'INVALID_PARAMETER_NAME',
          `${what}: a BETWEEN parameter name must be at most 25 characters (_FROM / _TO are added).`,
        );
      const label = typeof ask.label === 'string' && ask.label.trim() ? ask.label.trim() : ask.name;
      const a = p.ask(
        `${ask.name}_FROM`,
        `${label} (from)`,
        type,
        optDefault(ask.defaultValue, what),
      );
      const b = p.ask(`${ask.name}_TO`, `${label} (to)`, type, optDefault(ask.defaultValue2, what));
      return `${ref} BETWEEN ${a} AND ${b}`;
    }
    const a = p.fixed('F', type, checkValue(c, type, f.value, `${what} (from)`), ctx.label(i, c));
    const b = p.fixed('F', type, checkValue(c, type, f.value2, `${what} (to)`), ctx.label(i, c));
    return `${ref} BETWEEN ${a} AND ${b}`;
  }

  const marker = ask
    ? p.ask(ask.name, ask.label, type, optDefault(ask.defaultValue, what), match)
    : p.fixed('F', type, checkValue(c, type, f.value, what), ctx.label(i, c), match);
  if (match) return `${ref} LIKE ${marker} ESCAPE '\\'`;
  return `${ref} ${op} ${marker}`;
}

const checkLogic = (l: unknown, what: string): Logic => {
  const v = String(l ?? 'AND').toUpperCase();
  if (v !== 'AND' && v !== 'OR') throw bad('INVALID_FILTER_LOGIC', `${what} must be AND or OR.`);
  return v;
};

/** WHERE clause body (without the keyword), or null when there are no filters. */
export function buildWhere(
  items: FilterItem[] | undefined,
  logic: unknown,
  ctx: BuildContext,
  p: ParamCollector,
): string | null {
  if (items === undefined || items === null) return null;
  if (!Array.isArray(items)) throw bad('INVALID_FILTER', 'Filters must be a list.');
  if (items.length === 0) return null;
  const top = checkLogic(logic, 'Filter logic');
  let count = 0;
  let groups = 0;
  const parts = items.map((it) => {
    if (isGroup(it)) {
      if (++groups > MAX_FILTER_GROUPS)
        throw bad('TOO_MANY_FILTERS', `At most ${MAX_FILTER_GROUPS} filter groups are allowed.`);
      const gl = checkLogic(it.logic, 'Group logic');
      const inner = it.filters.map((f) => {
        if (isGroup(f as FilterItem))
          throw bad('INVALID_FILTER', 'Filter groups cannot be nested more than one level.');
        count++;
        return buildFilter(f, ctx, p);
      });
      if (inner.length === 0) throw bad('INVALID_FILTER', 'A filter group is empty.');
      return inner.length === 1 ? inner[0] : `(${inner.join(` ${gl} `)})`;
    }
    count++;
    return buildFilter(it, ctx, p);
  });
  if (count > MAX_FILTERS)
    throw bad('TOO_MANY_FILTERS', `A report can have at most ${MAX_FILTERS} filters.`);
  return parts.join(`\n  ${top} `);
}

// ---------------------------------------------------------------------------
// Aggregates and HAVING
// ---------------------------------------------------------------------------

const OUTPUT_NAME = /^[A-Za-z][A-Za-z0-9_ ]{0,63}$/;

export interface BuiltAggregate {
  fn: AggregateFn;
  name: string;
  expr: string;
  /** Column aggregated (null for COUNT(*)). */
  column: CatalogColumn | null;
}

export function buildAggregates(list: AggregateSpec[], ctx: BuildContext): BuiltAggregate[] {
  if (!Array.isArray(list)) throw bad('INVALID_AGGREGATE', 'Totals must be a list.');
  if (list.length > MAX_AGGREGATES)
    throw bad('TOO_MANY_AGGREGATES', `A report can have at most ${MAX_AGGREGATES} totals.`);
  return list.map((a) => {
    const fn = String(a?.fn ?? '').toUpperCase() as AggregateFn;
    if (!AGGREGATE_FNS.includes(fn))
      throw bad('INVALID_AGGREGATE', `Total ${JSON.stringify(a?.fn)} is not supported.`);
    const hasColumn = a.column !== undefined && a.column !== null && a.column !== '';
    if (!hasColumn && fn !== 'COUNT')
      throw bad('INVALID_AGGREGATE', `${fn.replace('_', ' ')} needs a column.`);
    let expr = 'COUNT(*)';
    let col: CatalogColumn | null = null;
    let base = 'ROWS';
    if (hasColumn) {
      const { i, c } = ctx.resolve({ table: a.table, column: a.column }, 'Total column');
      col = c;
      base = c.name;
      const cat = typeCategory(c.type);
      if ((fn === 'SUM' || fn === 'AVG') && cat !== 'numeric')
        throw bad(
          'INVALID_AGGREGATE',
          `${fn} needs a numeric column; ${ctx.label(i, c)} is ${c.type}.`,
        );
      if (cat === 'binary' || cat === 'other' || /LOB$/.test(c.type.toUpperCase()))
        throw bad('INVALID_AGGREGATE', `${ctx.label(i, c)} (${c.type}) cannot be totalled.`);
      const ref = ctx.colRef(i, c);
      expr = fn === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${ref})` : `${fn}(${ref})`;
    }
    const name =
      typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `${fn}_${base}`.slice(0, 64);
    if (!OUTPUT_NAME.test(name))
      throw bad(
        'INVALID_OUTPUT_NAME',
        `Total name ${JSON.stringify(name)} must start with a letter and use letters, digits, spaces or _ (max 64).`,
      );
    return { fn, name, expr, column: col };
  });
}

export function buildHaving(
  list: HavingSpec[] | undefined,
  aggs: BuiltAggregate[],
  p: ParamCollector,
): string | null {
  if (!list || (Array.isArray(list) && list.length === 0)) return null;
  if (!Array.isArray(list)) throw bad('INVALID_HAVING', 'Total filters must be a list.');
  if (list.length > MAX_HAVING)
    throw bad('TOO_MANY_FILTERS', `At most ${MAX_HAVING} total filters are allowed.`);
  return list
    .map((h) => {
      const agg = aggs.find(
        (a) => a.name.toUpperCase() === String(h?.aggregate ?? '').toUpperCase(),
      );
      if (!agg)
        throw bad(
          'UNKNOWN_AGGREGATE',
          `Total filter refers to ${JSON.stringify(h?.aggregate)}, which is not a total in this report.`,
        );
      const op = String(h.op ?? '').toUpperCase() as HavingOp;
      if (!HAVING_OPS.includes(op))
        throw bad(
          'INVALID_FILTER_OPERATOR',
          `Total filter operator ${JSON.stringify(h.op)} is not supported.`,
        );
      const type: ParameterType =
        agg.fn === 'COUNT' || agg.fn === 'COUNT_DISTINCT'
          ? 'integer'
          : agg.fn === 'AVG'
            ? 'decimal'
            : (parameterTypeFor(agg.column!) ?? 'string');
      const col: CatalogColumn = agg.column ?? {
        name: agg.name,
        type: 'BIGINT',
        length: null,
        precision: null,
        scale: 0,
        nullable: false,
        text: null,
        ordinal: 0,
      };
      const what = `Total filter on ${agg.name}`;
      const m1 = p.fixed('H', type, checkValue(col, type, h.value, what), agg.name);
      if (op === 'BETWEEN') {
        const m2 = p.fixed('H', type, checkValue(col, type, h.value2, `${what} (to)`), agg.name);
        return `${agg.expr} BETWEEN ${m1} AND ${m2}`;
      }
      return `${agg.expr} ${op} ${m1}`;
    })
    .join('\n   AND ');
}
