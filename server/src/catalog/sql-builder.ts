/**
 * Builds the SELECT statement behind a Report Builder report.
 *
 * SECURITY: the client never supplies SQL. It supplies a schema, a table, column
 * names and sort directions. Every name is resolved against the catalog metadata
 * that the server itself read from QSYS2 (see catalog.ts); anything that does not
 * exactly match a known object (case-insensitively, when unambiguous) is rejected
 * with a 400 instead of being pasted into the statement. The identifiers that are
 * finally emitted are the *catalog's* spelling, wrapped in Db2 for i delimited
 * identifiers ("NAME", with embedded quotes doubled), which is the only way to
 * handle names with blanks, punctuation or mixed case safely.
 */
import { AppError } from '../util/errors.js';

export type SortDirection = 'ASC' | 'DESC';

/** One row of QSYS2.SYSTABLES, as cached by the catalog service. */
export interface CatalogTable {
  schema: string;
  name: string;
  /** QSYS2.SYSTABLES.TABLE_TYPE: T table, V view, L logical file, A alias, M MQT. */
  type: string;
  text: string | null;
  owner?: string | null;
}

/** One row of QSYS2.SYSCOLUMNS, as cached by the catalog service. */
export interface CatalogColumn {
  name: string;
  type: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  text: string | null;
  ordinal: number;
}

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

/** The report definition the client is allowed to send. Never contains SQL. */
export interface ReportSpec {
  schema: string;
  table: string;
  columns: string[];
  sort?: SortSpec[];
}

/** Db2 for i limit for a delimited identifier. */
export const MAX_IDENTIFIER_LENGTH = 128;

/** True for C0 control characters and DEL, which have no place in a Db2 for i name. */
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};

/** Quote one IBM i identifier: "NAME", with any embedded " doubled. */
export function quoteIdentifier(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new AppError(400, 'INVALID_IDENTIFIER', 'An identifier is empty.');
  if (raw.length > MAX_IDENTIFIER_LENGTH)
    throw new AppError(
      400,
      'INVALID_IDENTIFIER',
      `An identifier is longer than ${MAX_IDENTIFIER_LENGTH} characters.`,
    );
  if (hasControlChar(raw))
    throw new AppError(400, 'INVALID_IDENTIFIER', 'An identifier contains a control character.');
  return `"${raw.replace(/"/g, '""')}"`;
}

const sameName = (a: string, b: string) => a === b || a.toUpperCase() === b.toUpperCase();

/**
 * Find the catalog entry a client-supplied name refers to.
 *
 * An exact match always wins. Otherwise a case-insensitive match is accepted, but
 * only when it identifies exactly one entry - otherwise the name is ambiguous
 * (Db2 for i can hold "Orders" and "ORDERS" side by side) and is rejected.
 */
function resolveEntry<T>(
  items: T[],
  nameOf: (item: T) => string,
  wanted: string,
  code: string,
  kind: string,
): T {
  const exact = items.find((i) => nameOf(i) === wanted);
  if (exact) return exact;
  const folded = wanted.toUpperCase();
  const loose = items.filter((i) => nameOf(i).toUpperCase() === folded);
  if (loose.length === 1) return loose[0];
  if (loose.length > 1)
    throw new AppError(
      400,
      'AMBIGUOUS_IDENTIFIER',
      `${kind} ${JSON.stringify(wanted)} matches more than one object; pick one from the list.`,
    );
  throw new AppError(
    400,
    code,
    `${kind} ${JSON.stringify(wanted)} is not in the cached catalog metadata for this table.`,
  );
}

function resolveTables(spec: ReportSpec, table: CatalogTable): CatalogTable {
  if (!sameName(spec.schema, table.schema) || !sameName(spec.table, table.name))
    throw new AppError(
      400,
      'UNKNOWN_TABLE',
      `Table ${JSON.stringify(`${spec.schema}.${spec.table}`)} is not the catalogued table ${JSON.stringify(`${table.schema}.${table.name}`)}.`,
    );
  return table;
}

/**
 * Build the read-only SELECT for a validated report spec.
 *
 * `table` and `columns` must be the catalog metadata for the selected object
 * (already filtered to what the reporting profile may read).
 */
export function buildReportSql(
  spec: ReportSpec,
  table: CatalogTable,
  columns: CatalogColumn[],
): string {
  const target = resolveTables(spec, table);

  const wanted = Array.isArray(spec.columns) ? spec.columns : [];
  if (wanted.length === 0)
    throw new AppError(
      400,
      'EMPTY_SELECTION',
      'Choose at least one column to include in the report.',
    );

  const chosen: CatalogColumn[] = [];
  for (const name of wanted) {
    if (typeof name !== 'string')
      throw new AppError(400, 'INVALID_IDENTIFIER', 'A column name is not text.');
    const column = resolveEntry(columns, (c) => c.name, name, 'UNKNOWN_COLUMN', 'Column');
    if (chosen.some((c) => c.name === column.name))
      throw new AppError(
        400,
        'DUPLICATE_COLUMN',
        `Column ${JSON.stringify(column.name)} is selected more than once.`,
      );
    chosen.push(column);
  }

  const sorts: SortSpec[] = [];
  for (const row of spec.sort ?? []) {
    if (!row || typeof row.column !== 'string')
      throw new AppError(400, 'INVALID_SORT_DIRECTION', 'A sort row is missing its column.');
    const direction = String(row.direction ?? '')
      .trim()
      .toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC')
      throw new AppError(
        400,
        'INVALID_SORT_DIRECTION',
        `Sort direction for ${JSON.stringify(row.column)} must be ASC or DESC.`,
      );
    const column = resolveEntry(columns, (c) => c.name, row.column, 'UNKNOWN_COLUMN', 'Column');
    if (sorts.some((s) => sameName(s.column, column.name)))
      throw new AppError(
        400,
        'DUPLICATE_SORT_COLUMN',
        `Column ${JSON.stringify(column.name)} is used more than once in the sort order.`,
      );
    sorts.push({ column: column.name, direction });
  }

  const selectList = chosen.map((c) => quoteIdentifier(c.name)).join(', ');
  const from = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`;
  const orderBy = sorts.length
    ? `\nORDER BY ${sorts.map((s) => `${quoteIdentifier(s.column)} ${s.direction}`).join(', ')}`
    : '';
  return `SELECT ${selectList}\nFROM ${from}${orderBy}`;
}

/** Suggested saved-report name, e.g. `ORDERS: ORDER_ID, CUSTOMER sorted by ORDER_DATE DESC`. */
export function suggestReportName(spec: ReportSpec, max = 128): string {
  const columns = spec.columns ?? [];
  const shown = columns.slice(0, 4).join(', ');
  const extra = columns.length > 4 ? ` +${columns.length - 4} more` : '';
  const fields = columns.length ? `${shown}${extra}` : 'all columns';
  const sort = (spec.sort ?? []).filter((s) => s.column);
  const order = sort.length
    ? ` sorted by ${sort.map((s) => `${s.column} ${s.direction}`).join(', ')}`
    : '';
  return `${spec.table}: ${fields}${order}`.slice(0, max);
}
