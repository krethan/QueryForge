/**
 * Multi-table Report Builder: a base table plus up to MAX_JOINS joined tables.
 *
 * SECURITY: exactly like sql-builder.ts, the client only sends names. Every table and
 * column is resolved against cached QSYS2 catalog metadata, aliases are generated here
 * or must match ALIAS_PATTERN, join types come from a fixed list, and the only
 * predicate that can be expressed is `alias.column = alias.column` between a table
 * that is already in the FROM clause and the table being joined. No SQL text from
 * the client ever reaches the statement.
 */
import { AppError } from '../util/errors.js';
import {
  MAX_IDENTIFIER_LENGTH,
  quoteIdentifier,
  resolveEntry,
  sameName,
  type CatalogColumn,
  type CatalogTable,
  type SortDirection,
} from './sql-builder.js';
import {
  OUTPUT_NAME,
  buildAggregates,
  buildHaving,
  buildWhere,
  ParamCollector,
  type AggregateSpec,
  type BuildContext,
  type FilterItem,
  type HavingSpec,
} from './filter-builder.js';
import type { ParameterDef } from '../reports/parameters.js';
import {
  CALC_ID,
  CALC_TABLE,
  CalcError,
  calcCatalogType,
  calcTypeOf,
  compile,
  MAX_CALCULATED,
  parse,
  type CalcType,
  type ColumnResolver,
} from './calc-expr.js';

export const MAX_JOINS = 8;
export const MAX_CONDITIONS_PER_JOIN = 16;
/** Correlation names: short, upper-case, ordinary identifiers. */
export const ALIAS_PATTERN = /^[A-Z][A-Z0-9_]{0,9}$/;

export const JOIN_TYPES = ['INNER', 'LEFT', 'RIGHT', 'FULL'] as const;
export type JoinType = (typeof JOIN_TYPES)[number];
const JOIN_SQL: Record<JoinType, string> = {
  INNER: 'INNER JOIN',
  LEFT: 'LEFT OUTER JOIN',
  RIGHT: 'RIGHT OUTER JOIN',
  FULL: 'FULL OUTER JOIN',
};

/** `left` is a table already added (by alias); `right` is a column of the table being joined. */
export interface JoinCondition {
  left: { table: string; column: string };
  right: { column: string };
}

export interface JoinSpec {
  schema: string;
  table: string;
  alias?: string;
  type: JoinType;
  on: JoinCondition[];
}

/** A column of any table in the report, by alias. A bare string means the base table. */
export interface ColumnRef {
  table?: string;
  column: string;
}

export interface JoinedSortSpec {
  table?: string;
  /** A column; or omit it and give `aggregate` (a total's output name). */
  column?: string;
  aggregate?: string;
  direction: SortDirection;
}

export interface JoinedReportSpec {
  schema: string;
  table: string;
  alias?: string;
  joins?: JoinSpec[];
  columns: (string | ColumnRef)[];
  sort?: JoinedSortSpec[];
  /** WHERE: all AND or all OR at the top level, with one optional level of groups. */
  filters?: FilterItem[];
  filterLogic?: 'AND' | 'OR';
  /** GROUP BY columns; selected columns are added automatically when grouping. */
  groupBy?: ColumnRef[];
  aggregates?: AggregateSpec[];
  having?: HavingSpec[];
  /**
   * Named calculated fields. Elsewhere in the spec a calculated field is referred to
   * as `{ table: '@CALC', column: <id> }`.
   */
  calculated?: CalculatedFieldSpec[];
}

export interface CalculatedFieldSpec {
  id: string;
  name: string;
  expression: string;
  /** Inferred result type (recomputed by the server; informational on input). */
  type?: CalcType;
}

export interface CompiledCalculated {
  id: string;
  name: string;
  expression: string;
  sql: string;
  type: CalcType;
  /** Synthetic catalog column standing for the field (name = id). */
  column: CatalogColumn;
}

/**
 * Parse, type-check and compile every calculated field of a report. `column` resolves
 * a column reference written in an expression (no alias = base table) against the
 * catalog and returns its SQL text and catalog column.
 */
export function compileCalculated(
  list: unknown,
  column: (ref: { table?: string; column: string }) => {
    sql: string;
    c: CatalogColumn;
    label: string;
  },
): CompiledCalculated[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('INVALID_CALCULATION', 'Calculated fields must be a list.');
  if (list.length > MAX_CALCULATED)
    throw bad(
      'TOO_MANY_CALCULATIONS',
      `A report can have at most ${MAX_CALCULATED} calculated fields.`,
    );
  const ids = new Set<string>();
  const names = new Set<string>();
  return list.map((d: Partial<CalculatedFieldSpec> | null, k) => {
    const id = d?.id;
    const name = typeof d?.name === 'string' ? d.name.trim() : '';
    if (typeof id !== 'string' || !CALC_ID.test(id))
      throw bad('INVALID_CALCULATION', `Calculated field ${k + 1} has an invalid id.`);
    if (!OUTPUT_NAME.test(name))
      throw bad(
        'INVALID_CALCULATION',
        `Calculated field name ${JSON.stringify(d?.name ?? '')} must start with a letter and use letters, digits, spaces or _ (max 64).`,
      );
    if (ids.has(id.toUpperCase()))
      throw bad('INVALID_CALCULATION', `Calculated field id ${JSON.stringify(id)} is used twice.`);
    if (names.has(name.toUpperCase()))
      throw bad('DUPLICATE_OUTPUT_NAME', `The calculated field name "${name}" is used twice.`);
    ids.add(id.toUpperCase());
    names.add(name.toUpperCase());
    const expression = typeof d?.expression === 'string' ? d.expression : '';
    const resolver: ColumnResolver = (ref, pos) => {
      if (ref.table === CALC_TABLE)
        throw new CalcError('A calculated field cannot refer to another calculated field.', pos);
      let r: { sql: string; c: CatalogColumn; label: string };
      try {
        r = column(ref);
      } catch (e) {
        if (e instanceof AppError) throw new CalcError(`${e.message} (position ${pos + 1})`, pos);
        throw e;
      }
      const type = calcTypeOf(r.c.type, r.c.scale);
      if (!type)
        throw new CalcError(
          `${r.label} (${r.c.type}) cannot be used in a calculated field (position ${pos + 1}).`,
          pos,
        );
      return { sql: r.sql, type, label: r.label };
    };
    try {
      const out = compile(parse(expression), resolver);
      const t = calcCatalogType(out.type);
      return {
        id,
        name,
        expression,
        sql: out.sql,
        type: out.type,
        column: {
          name: id,
          type: t.type,
          scale: t.scale,
          length: null,
          precision: null,
          nullable: true,
          text: name,
          ordinal: k + 1,
        },
      };
    } catch (e) {
      if (e instanceof CalcError)
        throw new AppError(400, 'INVALID_CALCULATION', `Calculated field "${name}": ${e.message}`, {
          calculated: id,
          position: e.position,
        });
      throw e;
    }
  });
}

/** Catalog metadata for one table of the report, in spec order (base first). */
export interface ResolvedSource {
  table: CatalogTable;
  columns: CatalogColumn[];
}

export interface OutputColumn {
  alias: string;
  table: string;
  column: string;
  /** Set for totals: the aggregate function. */
  aggregate?: string;
  /** Result column name: the catalog name, or a generated unique AS name. */
  name: string;
}

export interface BuiltJoinQuery {
  sql: string;
  /** Final alias per table, base first (generated ones included). */
  aliases: string[];
  columns: OutputColumn[];
  warnings: string[];
  /** One definition per `?` marker, in order (fixed filter values and ask-when-run ones). */
  parameters: ParameterDef[];
  /** Calculated fields with their server-inferred types. */
  calculated: CalculatedFieldSpec[];
}

type Category = 'numeric' | 'char' | 'date' | 'time' | 'timestamp' | 'binary' | 'other';

/** Coarse Db2 for i comparison family of a SYSCOLUMNS.DATA_TYPE. */
export function typeCategory(dataType: string): Category {
  const t = dataType.toUpperCase().trim();
  if (
    /^(SMALLINT|INTEGER|INT|BIGINT|DECIMAL|NUMERIC|DECFLOAT|REAL|FLOAT|DOUBLE|DOUBLE PRECISION)$/.test(
      t,
    )
  )
    return 'numeric';
  if (/^(CHAR|CHARACTER|VARCHAR|CLOB|GRAPHIC|VARGRAPHIC|DBCLOB|NCHAR|NVARCHAR|NCLOB)$/.test(t))
    return 'char';
  if (t === 'DATE') return 'date';
  if (t === 'TIME') return 'time';
  if (t === 'TIMESTMP' || t === 'TIMESTAMP') return 'timestamp';
  if (/^(BINARY|VARBINARY|BLOB)$/.test(t)) return 'binary';
  return 'other';
}

/**
 * Whether two columns may be compared with `=`: 'ok', 'warn' (Db2 allows it, but it
 * is easy to get wrong), or 'reject' (e.g. numeric vs character).
 */
export function comparability(a: CatalogColumn, b: CatalogColumn): 'ok' | 'warn' | 'reject' {
  const x = typeCategory(a.type);
  const y = typeCategory(b.type);
  if (x === 'other' || y === 'other') return x === y ? 'warn' : 'reject';
  if (x === y) return 'ok';
  const pair = [x, y].sort().join('+');
  if (pair === 'date+timestamp') return 'warn';
  return 'reject';
}

const bad = (code: string, message: string) => new AppError(400, code, message);

function checkSource(i: number, schema: string, table: string, src: ResolvedSource | undefined) {
  if (!src || !sameName(schema, src.table.schema) || !sameName(table, src.table.name))
    throw bad(
      'UNKNOWN_TABLE',
      `Table ${JSON.stringify(`${schema}.${table}`)} (position ${i + 1}) is not in the cached catalog metadata.`,
    );
}

/** Generated output name for a duplicated column, kept within Db2 limits. */
const clip = (s: string) => s.slice(0, MAX_IDENTIFIER_LENGTH);

/**
 * Build the SELECT for a joined report. `sources[0]` is the base table and
 * `sources[i]` is `spec.joins[i - 1]`; all of them must come from the catalog service.
 */
export function buildJoinedReportSql(
  spec: JoinedReportSpec,
  sources: ResolvedSource[],
): BuiltJoinQuery {
  const joins = spec.joins ?? [];
  if (joins.length > MAX_JOINS)
    throw bad('TOO_MANY_JOINS', `A report can join at most ${MAX_JOINS} tables to the base table.`);
  if (sources.length !== joins.length + 1)
    throw bad('UNKNOWN_TABLE', 'Every table in the report must be in the catalog.');
  checkSource(0, spec.schema, spec.table, sources[0]);
  joins.forEach((j, i) => checkSource(i + 1, j.schema, j.table, sources[i + 1]));

  // ---- aliases: validated when supplied, generated (T1, T2, …) otherwise ----
  const requested = [spec.alias, ...joins.map((j) => j.alias)];
  for (const a of requested) {
    if (a === undefined || a === null || a === '') continue;
    if (typeof a !== 'string' || !ALIAS_PATTERN.test(a))
      throw bad(
        'INVALID_ALIAS',
        `Alias ${JSON.stringify(a)} must start with a letter and use only A-Z, 0-9 and _ (max 10 characters).`,
      );
  }
  // Unnamed tables get their position (T1 = base, T2 = first join, …), so the
  // aliases the UI shows never shift when another table is renamed.
  const aliases = requested.map((a, i) => a || `T${i + 1}`);
  const taken = new Set<string>();
  for (const a of aliases) {
    if (taken.has(a)) throw bad('DUPLICATE_ALIAS', `Alias ${JSON.stringify(a)} is used twice.`);
    taken.add(a);
  }
  const indexOfAlias = (a: unknown) => (typeof a === 'string' ? aliases.indexOf(a) : -1);
  const q = quoteIdentifier;
  const colRef = (i: number, c: CatalogColumn) => `${q(aliases[i])}.${q(c.name)}`;
  const findColumn = (i: number, name: unknown) => {
    if (typeof name !== 'string') throw bad('INVALID_IDENTIFIER', 'A column name is not text.');
    return resolveEntry(sources[i].columns, (c) => c.name, name, 'UNKNOWN_COLUMN', 'Column');
  };

  const warnings: string[] = [];

  // ---- FROM / JOIN … ON ----
  const base = sources[0].table;
  const lines = [`FROM ${q(base.schema)}.${q(base.name)} AS ${q(aliases[0])}`];
  joins.forEach((j, n) => {
    const i = n + 1;
    const type = String(j.type ?? '').toUpperCase() as JoinType;
    if (!JOIN_TYPES.includes(type))
      throw bad('INVALID_JOIN_TYPE', `Join type must be one of ${JOIN_TYPES.join(', ')}.`);
    const on = Array.isArray(j.on) ? j.on : [];
    if (on.length === 0)
      throw bad(
        'JOIN_WITHOUT_CONDITION',
        `Join ${aliases[i]} (${sources[i].table.name}) needs at least one ON condition.`,
      );
    if (on.length > MAX_CONDITIONS_PER_JOIN)
      throw bad(
        'TOO_MANY_CONDITIONS',
        `A join can have at most ${MAX_CONDITIONS_PER_JOIN} conditions.`,
      );
    const seen = new Set<string>();
    const preds = on.map((c) => {
      const leftAlias = c?.left?.table;
      const li = indexOfAlias(leftAlias);
      if (li === i)
        throw bad(
          'INVALID_JOIN_REFERENCE',
          `Join ${aliases[i]} cannot be joined on itself; pick a column from a table added earlier.`,
        );
      if (li < 0 || li > i)
        throw bad(
          'INVALID_JOIN_REFERENCE',
          `ON condition for ${aliases[i]} refers to ${JSON.stringify(leftAlias)}, which is not a table added before it.`,
        );
      const lc = findColumn(li, c.left.column);
      const rc = findColumn(i, c?.right?.column);
      const key = `${li}.${lc.name}=${rc.name}`;
      if (seen.has(key))
        throw bad(
          'DUPLICATE_CONDITION',
          `The same ON condition is listed twice for ${aliases[i]}.`,
        );
      seen.add(key);
      const verdict = comparability(lc, rc);
      if (verdict === 'reject')
        throw bad(
          'INCOMPATIBLE_JOIN_TYPES',
          `${aliases[li]}.${lc.name} (${lc.type}) cannot be compared with ${aliases[i]}.${rc.name} (${rc.type}).`,
        );
      if (verdict === 'warn')
        warnings.push(
          `${aliases[li]}.${lc.name} (${lc.type}) and ${aliases[i]}.${rc.name} (${rc.type}) have different types; check the join matches what you expect.`,
        );
      return `${colRef(li, lc)} = ${colRef(i, rc)}`;
    });
    const t = sources[i].table;
    lines.push(
      `${JOIN_SQL[type]} ${q(t.schema)}.${q(t.name)} AS ${q(aliases[i])}\n  ON ${preds.join('\n  AND ')}`,
    );
  });

  // ---- WHERE (filters are resolved before anything is grouped) ----
  const calcs = compileCalculated(spec.calculated, (ref) => {
    const i = ref.table === undefined || ref.table === null ? 0 : indexOfAlias(ref.table);
    if (i < 0)
      throw bad(
        'UNKNOWN_ALIAS',
        `${JSON.stringify(ref.table)} is not a table alias in this report.`,
      );
    const c = findColumn(i, ref.column);
    return { sql: colRef(i, c), c, label: `${aliases[i]}.${c.name}` };
  });
  const isCalc = (i: number) => i >= sources.length;
  const calcAt = (i: number) => calcs[i - sources.length];
  const resolveRef = (ref: { table?: string; column: unknown }, what: string) => {
    if (ref?.table === CALC_TABLE) {
      const k = calcs.findIndex(
        (x) => typeof ref.column === 'string' && x.id.toUpperCase() === ref.column.toUpperCase(),
      );
      if (k < 0)
        throw bad(
          'UNKNOWN_COLUMN',
          `${what} refers to calculated field ${JSON.stringify(ref?.column)}, which is not in this report.`,
        );
      return { i: sources.length + k, c: calcs[k].column };
    }
    const i = ref?.table === undefined || ref?.table === null ? 0 : indexOfAlias(ref.table);
    if (i < 0)
      throw bad(
        'UNKNOWN_ALIAS',
        `${what} ${JSON.stringify(ref?.column)} refers to an unknown table alias.`,
      );
    return { i, c: findColumn(i, ref?.column) };
  };
  const anyRef = (i: number, c: CatalogColumn) => (isCalc(i) ? calcAt(i).sql : colRef(i, c));
  const labelOf = (i: number, c: CatalogColumn) =>
    isCalc(i) ? calcAt(i).name : `${aliases[i]}.${c.name}`;
  const ctx: BuildContext = {
    resolve: resolveRef,
    colRef: anyRef,
    label: labelOf,
    baseName: (i, c) => (isCalc(i) ? calcAt(i).name.replace(/ /g, '_') : c.name),
  };
  const params = new ParamCollector();
  const where = buildWhere(spec.filters, spec.filterLogic, ctx, params);

  // ---- grouping ----
  const aggs = buildAggregates(spec.aggregates ?? [], ctx);
  const groupRefs = Array.isArray(spec.groupBy) ? spec.groupBy : [];
  const grouping = aggs.length > 0 || groupRefs.length > 0;

  // ---- SELECT list, with unique output names ----
  const wanted = Array.isArray(spec.columns) ? spec.columns : [];
  if (wanted.length === 0 && aggs.length === 0)
    throw bad('EMPTY_SELECTION', 'Choose at least one column to include in the report.');
  const chosen: { i: number; c: CatalogColumn }[] = [];
  for (const ref of wanted) {
    const r: ColumnRef = typeof ref === 'string' ? { column: ref } : (ref ?? { column: '' });
    const { i, c } = resolveRef(r, 'Column');
    if (chosen.some((x) => x.i === i && x.c.name === c.name))
      throw bad('DUPLICATE_COLUMN', `Column ${labelOf(i, c)} is selected more than once.`);
    chosen.push({ i, c });
  }
  const groupCols: { i: number; c: CatalogColumn }[] = [];
  if (grouping) {
    for (const ref of groupRefs) {
      const { i, c } = resolveRef(ref, 'Group-by column');
      if (groupCols.some((x) => x.i === i && x.c.name === c.name))
        throw bad('DUPLICATE_COLUMN', `${labelOf(i, c)} is grouped more than once.`);
      groupCols.push({ i, c });
    }
    // Every selected, non-aggregated column must be a group-by column: add it.
    const added: string[] = [];
    for (const x of chosen)
      if (!groupCols.some((g) => g.i === x.i && g.c.name === x.c.name)) {
        groupCols.push(x);
        if (groupRefs.length) added.push(labelOf(x.i, x.c));
      }
    if (added.length)
      warnings.push(
        `${added.join(', ')} ${added.length === 1 ? 'was' : 'were'} added to GROUP BY because ${added.length === 1 ? 'it is' : 'they are'} selected without a total.`,
      );
    // Group-by columns that were not selected are shown too, so each row is labelled.
    for (const g of groupCols)
      if (!chosen.some((x) => x.i === g.i && x.c.name === g.c.name)) chosen.push(g);
  }
  const counts = new Map<string, number>();
  for (const x of chosen) if (!isCalc(x.i)) counts.set(x.c.name, (counts.get(x.c.name) ?? 0) + 1);
  const used = new Set(
    chosen.filter((x) => !isCalc(x.i) && counts.get(x.c.name) === 1).map((x) => x.c.name),
  );
  for (const x of chosen) if (isCalc(x.i)) used.add(calcAt(x.i).name);
  const out: OutputColumn[] = chosen.map(({ i, c }) => {
    if (isCalc(i)) return { alias: CALC_TABLE, table: '', column: c.name, name: calcAt(i).name };
    let name = c.name;
    if ((counts.get(c.name) ?? 0) > 1) {
      const candidates = [
        clip(`${sources[i].table.name}_${c.name}`),
        clip(`${aliases[i]}_${c.name}`),
      ];
      name = candidates.find((n) => !used.has(n)) ?? candidates[1];
      for (let k = 2; used.has(name); k++) name = clip(`${aliases[i]}_${c.name}_${k}`);
      used.add(name);
    }
    return { alias: aliases[i], table: sources[i].table.name, column: c.name, name };
  });
  const outNames = new Set<string>();
  for (const o of out) {
    if (outNames.has(o.name.toUpperCase()))
      throw bad('DUPLICATE_OUTPUT_NAME', `The output name "${o.name}" is used more than once.`);
    outNames.add(o.name.toUpperCase());
  }
  for (const a of aggs) {
    if (outNames.has(a.name.toUpperCase()))
      throw bad('DUPLICATE_OUTPUT_NAME', `The output name "${a.name}" is used more than once.`);
    outNames.add(a.name.toUpperCase());
    out.push({
      alias: '',
      table: '',
      column: a.column?.name ?? '*',
      name: a.name,
      aggregate: a.fn,
    });
  }
  const select = [
    ...chosen.map(({ i, c }, k) =>
      isCalc(i)
        ? `${calcAt(i).sql} AS ${q(out[k].name)}`
        : out[k].name === c.name
          ? colRef(i, c)
          : `${colRef(i, c)} AS ${q(out[k].name)}`,
    ),
    ...aggs.map((a) => `${a.expr} AS ${q(a.name)}`),
  ].join(',\n       ');
  const having = grouping ? buildHaving(spec.having, aggs, params) : null;
  if (!grouping && spec.having?.length)
    throw bad('INVALID_HAVING', 'Total filters need grouping or at least one total.');

  // ---- ORDER BY: any column of any table ----
  const sorts: string[] = [];
  const sortSeen = new Set<string>();
  for (const row of spec.sort ?? []) {
    const isAgg = !!row && typeof row.aggregate === 'string' && row.aggregate !== '';
    if (!row || (!isAgg && typeof row.column !== 'string'))
      throw bad('INVALID_SORT_DIRECTION', 'A sort row is missing its column.');
    const direction = String(row.direction ?? '')
      .trim()
      .toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC')
      throw bad(
        'INVALID_SORT_DIRECTION',
        `Sort direction for ${JSON.stringify(row.column ?? row.aggregate)} must be ASC or DESC.`,
      );
    if (isAgg) {
      const a = aggs.find((x) => x.name.toUpperCase() === row.aggregate!.toUpperCase());
      if (!a)
        throw bad(
          'UNKNOWN_AGGREGATE',
          `Sort refers to ${JSON.stringify(row.aggregate)}, which is not a total in this report.`,
        );
      const key = `agg:${a.name.toUpperCase()}`;
      if (sortSeen.has(key))
        throw bad('DUPLICATE_SORT_COLUMN', `${a.name} is used more than once in the sort order.`);
      sortSeen.add(key);
      sorts.push(`${a.expr} ${direction}`);
      continue;
    }
    const { i, c } = resolveRef({ table: row.table, column: row.column }, 'Sort column');
    if (grouping && !groupCols.some((g) => g.i === i && g.c.name === c.name))
      throw bad(
        'INVALID_SORT_COLUMN',
        `${labelOf(i, c)} is not grouped, so it cannot be used to sort grouped results; sort by a group-by column or a total.`,
      );
    const key = `${i}.${c.name}`;
    if (sortSeen.has(key))
      throw bad(
        'DUPLICATE_SORT_COLUMN',
        `Column ${labelOf(i, c)} is used more than once in the sort order.`,
      );
    sortSeen.add(key);
    sorts.push(`${anyRef(i, c)} ${direction}`);
  }

  const clauses = [...lines];
  if (where) clauses.push(`WHERE ${where}`);
  if (grouping && groupCols.length)
    clauses.push(`GROUP BY ${groupCols.map(({ i, c }) => anyRef(i, c)).join(', ')}`);
  if (having) clauses.push(`HAVING ${having}`);
  if (sorts.length) clauses.push(`ORDER BY ${sorts.join(', ')}`);
  return {
    sql: `SELECT ${select}\n${clauses.join('\n')}`,
    aliases,
    columns: out,
    warnings,
    parameters: params.defs,
    calculated: calcs.map(({ id, name, expression, type }) => ({ id, name, expression, type })),
  };
}

/**
 * Live validation for the calculated-field editor: parse and type-check one expression
 * against the report's tables (base + joins, with the same alias rules as the builder).
 */
export function validateCalculation(
  spec: { alias?: string; joins?: { alias?: string }[] },
  sources: ResolvedSource[],
  expression: string,
): { type: CalcType; sql: string; columns: string[] } {
  const aliases = [spec.alias, ...(spec.joins ?? []).map((j) => j.alias)].map((a, i) =>
    typeof a === 'string' && ALIAS_PATTERN.test(a) ? a : `T${i + 1}`,
  );
  const columns: string[] = [];
  const [c] = compileCalculated([{ id: 'CHECK', name: 'Check', expression }], (ref) => {
    const i = ref.table === undefined || ref.table === null ? 0 : aliases.indexOf(ref.table);
    if (i < 0 || i >= sources.length)
      throw bad(
        'UNKNOWN_ALIAS',
        `${JSON.stringify(ref.table)} is not a table alias in this report.`,
      );
    const col = resolveEntry(
      sources[i].columns,
      (x) => x.name,
      ref.column,
      'UNKNOWN_COLUMN',
      'Column',
    );
    const label = `${aliases[i]}.${col.name}`;
    if (!columns.includes(label)) columns.push(label);
    return { sql: `${quoteIdentifier(aliases[i])}.${quoteIdentifier(col.name)}`, c: col, label };
  });
  return { type: c.type, sql: c.sql, columns };
}

/** Suggested saved-report name, e.g. `ORDERS + CUSTOMERS: ORDER_ID, NAME`. */
export function suggestJoinedReportName(spec: JoinedReportSpec, out: OutputColumn[], max = 128) {
  const tables = [spec.table, ...(spec.joins ?? []).map((j) => j.table)];
  const shownTables =
    tables.slice(0, 3).join(' + ') + (tables.length > 3 ? ` +${tables.length - 3}` : '');
  const shown = out
    .slice(0, 4)
    .map((c) => c.name)
    .join(', ');
  const extra = out.length > 4 ? ` +${out.length - 4} more` : '';
  return `${shownTables}: ${shown}${extra}`.slice(0, max);
}

// ---------------------------------------------------------------------------
// Join suggestions
// ---------------------------------------------------------------------------

/** One referential constraint column pair from QSYS2.SYSREFCST / SYSCST / SYSKEYCST. */
export interface ForeignKeyColumn {
  constraint: string;
  childSchema: string;
  childTable: string;
  childColumn: string;
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  ordinal: number;
}

export interface JoinSuggestion {
  source: 'foreign-key' | 'column-name';
  constraint?: string;
  label: string;
  on: JoinCondition[];
}

export interface SuggestionInput {
  alias: string;
  source: ResolvedSource;
}

const isTable = (s: ResolvedSource, schema: string, name: string) =>
  sameName(s.table.schema, schema) && sameName(s.table.name, name);

/**
 * Suggest ON conditions for joining `target` to the tables already in the report.
 * Catalog foreign keys (in either direction) come first; otherwise columns with the
 * same name and a comparable type are offered, one suggestion per existing table.
 */
export function suggestJoinConditions(
  existing: SuggestionInput[],
  target: ResolvedSource,
  foreignKeys: ForeignKeyColumn[],
  max = 10,
): JoinSuggestion[] {
  const out: JoinSuggestion[] = [];
  const byConstraint = new Map<string, ForeignKeyColumn[]>();
  for (const fk of foreignKeys) {
    const k = `${fk.childSchema}.${fk.constraint}`;
    byConstraint.set(k, [...(byConstraint.get(k) ?? []), fk]);
  }
  const has = (src: ResolvedSource, name: string) => src.columns.some((c) => c.name === name);
  for (const [, cols] of byConstraint) {
    const fk = cols.sort((a, b) => a.ordinal - b.ordinal);
    const first = fk[0];
    for (const e of existing) {
      let on: JoinCondition[] | null = null;
      if (
        isTable(target, first.childSchema, first.childTable) &&
        isTable(e.source, first.parentSchema, first.parentTable)
      )
        on = fk.map((f) => ({
          left: { table: e.alias, column: f.parentColumn },
          right: { column: f.childColumn },
        }));
      else if (
        isTable(e.source, first.childSchema, first.childTable) &&
        isTable(target, first.parentSchema, first.parentTable)
      )
        on = fk.map((f) => ({
          left: { table: e.alias, column: f.childColumn },
          right: { column: f.parentColumn },
        }));
      if (!on || !on.every((c) => has(e.source, c.left.column) && has(target, c.right.column)))
        continue;
      out.push({
        source: 'foreign-key',
        constraint: first.constraint,
        label: `${first.constraint}: ${on.map((c) => `${e.alias}.${c.left.column} = ${c.right.column}`).join(' AND ')}`,
        on,
      });
    }
  }
  if (out.length === 0) {
    for (const e of existing) {
      const on: JoinCondition[] = [];
      for (const c of e.source.columns) {
        const match = target.columns.find((t) => t.name === c.name);
        if (match && comparability(c, match) === 'ok')
          on.push({ left: { table: e.alias, column: c.name }, right: { column: match.name } });
      }
      // One condition per suggestion: matching *names* rarely means a composite key.
      for (const cond of on)
        out.push({
          source: 'column-name',
          label: `Same name: ${e.alias}.${cond.left.column} = ${cond.right.column}`,
          on: [cond],
        });
    }
  }
  return out.slice(0, max);
}
