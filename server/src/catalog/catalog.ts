/**
 * Read-only view of the Db2 for i system catalog (QSYS2.SYSTABLES / QSYS2.SYSCOLUMNS)
 * that powers the Report Builder.
 *
 * Everything here runs through QueryExecutor, i.e. the same SQL validator, the same
 * read-only reporting profile and the same Mapepire job handling as an ad-hoc query.
 * Values that come from the client (the search term, a schema/table name) are always
 * bound as `?` parameters - they never become SQL text.
 *
 * Results are cached in memory for a short TTL because the catalog is read on every
 * keystroke of the table picker. The cache is shared by all app users: the catalog is
 * read as the single read-only reporting identity, so every user sees the same list.
 */
import type { AppConfig } from '../config/config.js';
import type { QueryExecutor } from '../sql/executor.js';
import { AppError, sanitizeErrorMessage } from '../util/errors.js';
import type { CatalogColumn, CatalogTable } from './sql-builder.js';
import type { ForeignKeyColumn } from './join-builder.js';
import type { Cell } from '../sql/results.js';

/** TABLE_TYPE values worth showing: SQL table, DDS physical file, view, logical file, alias, MQT. */
export const CATALOG_TABLE_TYPES = ['T', 'P', 'V', 'L', 'A', 'M'] as const;

/** Hard cap on rows read from the catalog per query (the client cannot raise it). */
export const MAX_TABLES = 500;
export const MAX_COLUMNS = 1000;

/** Default page size returned by GET /api/schema/tables. */
export const DEFAULT_TABLE_LIMIT = 100;

/**
 * Schemas hidden when REPORT_LIBRARIES is not configured. They hold Db2 / IBM i
 * catalog objects that the reporting profile normally can *USE (so SQL_CHECK_AUTHORITY
 * reports them as readable) and that would otherwise swamp the picker.
 */
const SYSTEM_SCHEMAS = [
  'QSYS',
  'QSYS2',
  'SYSIBM',
  'SYSIBMADM',
  'SYSCAT',
  'SYSSTAT',
  'QINFORML',
  'QINFORMA',
  'QMGTOOLS',
  'QSYSINC',
  'QSYSETC',
];

export interface CatalogTableEntry extends CatalogTable {
  /** Human-readable table type for the picker. */
  typeLabel: string;
}

const str = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v));
const num = (v: Cell | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Strip LIKE wildcards so a search term can never broaden the predicate. */
export const likePattern = (search: string): string =>
  `%${search.trim().replace(/[%_]/g, '').toUpperCase()}%`;

const TYPE_LABELS: Record<string, string> = {
  T: 'Table',
  P: 'Physical file',
  V: 'View',
  L: 'Logical file',
  A: 'Alias',
  M: 'Materialized query table',
};

/** `VARCHAR(40)`, `DECIMAL(11, 2)`, `DATE` - display only; the name is what is quoted in SQL. */
export function displayType(c: Omit<CatalogColumn, 'ordinal'>): string {
  const t = c.type.toUpperCase();
  if (t === 'DECIMAL' || t === 'NUMERIC')
    return `${t}(${c.precision ?? c.length ?? 0}, ${c.scale ?? 0})`;
  if (t === 'CHAR' || t === 'VARCHAR' || t === 'GRAPHIC' || t === 'VARG' || t === 'BINARY')
    return `${t}(${c.length ?? 0})`;
  if (t === 'TIMESTMP') return 'TIMESTAMP';
  return t;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface TableQuery {
  search?: string;
  limit?: number;
}

export interface TableListResult {
  tables: CatalogTableEntry[];
  cachedAt: string;
  /** True when the catalog holds more matches than were read (MAX_TABLES). */
  truncated: boolean;
}

export interface ResolvedTable {
  table: CatalogTableEntry;
  columns: CatalogColumn[];
  cachedAt: string;
}

export class CatalogService {
  private readonly ttlMs: number;
  private readonly tables = new Map<string, CacheEntry<CatalogTableEntry[]>>();
  private readonly oneTable = new Map<string, CacheEntry<CatalogTableEntry | null>>();
  private readonly columnsByTable = new Map<string, CacheEntry<CatalogColumn[]>>();
  private readonly foreignKeys = new Map<string, CacheEntry<ForeignKeyColumn[]>>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly executor: QueryExecutor,
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = Math.max(0, opts.ttlMs ?? cfg.limits.catalogCacheTtlMs);
  }

  /** Drop every cached entry (used by tests and by an explicit refresh). */
  invalidate(): void {
    this.tables.clear();
    this.oneTable.clear();
    this.columnsByTable.clear();
    this.foreignKeys.clear();
  }

  private fresh<T>(e: CacheEntry<T> | undefined, now: number): e is CacheEntry<T> {
    return !!e && now - e.at < this.ttlMs;
  }

  /** De-duplicate concurrent loads for the same key. */
  private async once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.pending.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = load().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private static trim(map: Map<string, { at: number }>, max = 64) {
    if (map.size <= max) return;
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, map.size - max);
    for (const [k] of oldest) map.delete(k);
  }

  private scope(tables: string[], protectedSchemas: string[]) {
    // REPORT_LIBRARIES / REPORT_DEFAULT_SCHEMA restrict the picker when configured;
    // otherwise every readable schema is listed except the system catalogs.
    const params: string[] = [];
    const clauses: string[] = [];
    if (tables.length) {
      clauses.push(`TABLE_SCHEMA IN (${tables.map(() => '?').join(', ')})`);
      params.push(...tables);
    } else {
      const hidden = [...new Set([...SYSTEM_SCHEMAS, ...protectedSchemas])];
      clauses.push(`TABLE_SCHEMA NOT IN (${hidden.map(() => '?').join(', ')})`);
      params.push(...hidden);
    }
    return { clauses, params };
  }

  private tableQuery(opts: { search?: string; schema?: string; table?: string } = {}) {
    const { search, schema, table } = opts;
    const libraries = [
      ...new Set(
        [
          ...(this.cfg.reporting.libraries ?? []),
          ...(this.cfg.reporting.defaultSchema ? [this.cfg.reporting.defaultSchema] : []),
        ].filter(Boolean),
      ),
    ].map((s) => s.toUpperCase());
    const { clauses, params } = this.scope(libraries, this.cfg.protectedSchemas);
    const where = [
      `TABLE_TYPE IN (${CATALOG_TABLE_TYPES.map(() => '?').join(', ')})`,
      "SYSTEM_TABLE = 'N'",
      // SQL_CHECK_AUTHORITY returns 1 only when the reporting profile may read the
      // object, and it accounts for group profiles, *PUBLIC and authorization lists.
      // It needs the *system* library/file name, hence the COALESCE fallbacks.
      `QSYS2.SQL_CHECK_AUTHORITY(COALESCE(NULLIF(TRIM(SYSTEM_TABLE_SCHEMA), ''), TABLE_SCHEMA),
                                 COALESCE(NULLIF(TRIM(SYSTEM_TABLE_NAME), ''), TABLE_NAME)) = 1`,
      ...clauses,
    ];
    const bound: (string | number | null)[] = [...CATALOG_TABLE_TYPES, ...params];
    if (schema) {
      where.push('UPPER(TABLE_SCHEMA) = ?');
      bound.push(schema.toUpperCase());
    }
    if (table) {
      where.push('UPPER(TABLE_NAME) = ?');
      bound.push(table.toUpperCase());
    }
    const needle = search?.trim();
    if (needle) {
      where.push('(UPPER(TABLE_SCHEMA) LIKE ? OR UPPER(TABLE_NAME) LIKE ?)');
      const pattern = likePattern(needle);
      bound.push(pattern, pattern);
    }
    const sql = `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_TEXT, TABLE_OWNER
FROM QSYS2.SYSTABLES
WHERE ${where.join('\n  AND ')}
ORDER BY TABLE_SCHEMA, TABLE_NAME
FETCH FIRST ${MAX_TABLES} ROWS ONLY`;
    return { sql, params: bound };
  }

  private columnsQuery(schema: string, table: string) {
    const sql = `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
       IS_NULLABLE, COLUMN_TEXT, ORDINAL_POSITION
FROM QSYS2.SYSCOLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION
FETCH FIRST ${MAX_COLUMNS} ROWS ONLY`;
    return { sql, params: [schema, table] satisfies (string | number | null)[] };
  }

  private async run(sql: string, ownerId: string, params: (string | number | null)[], max: number) {
    try {
      return await this.executor.run(sql, ownerId, { maxRows: max, parameters: params });
    } catch (e) {
      if (e instanceof AppError && e.code === 'PROTECTED_OBJECT')
        throw new AppError(
          503,
          'CATALOG_UNAVAILABLE',
          'The catalog is not reachable: QSYS2 is listed in PROTECTED_SCHEMAS. Remove it to use the Report Builder.',
        );
      throw new AppError(
        503,
        'CATALOG_UNAVAILABLE',
        `Could not read the Db2 for i system catalog: ${sanitizeErrorMessage(e)}`,
      );
    }
  }

  /** Bounded, cached list of tables/views the reporting profile can read. */
  async listTables(ownerId: string, q: TableQuery = {}): Promise<TableListResult> {
    const search = q.search?.trim() ?? '';
    const limit = Math.max(
      1,
      Math.min(
        Number.isFinite(q.limit) ? Math.floor(q.limit as number) : DEFAULT_TABLE_LIMIT,
        MAX_TABLES,
      ),
    );
    const key = `tables:${search.toUpperCase()}`;
    const cached = this.tables.get(key);
    if (this.fresh(cached, Date.now())) {
      return {
        tables: cached.value.slice(0, limit),
        cachedAt: new Date(cached.at).toISOString(),
        truncated: cached.value.length > limit,
      };
    }
    return this.once(key, async () => {
      const { sql, params } = this.tableQuery({ search });
      const run = await this.run(sql, ownerId, params, MAX_TABLES);
      const list: CatalogTableEntry[] = run.rows
        .map((r) => {
          const type = str(r[2]) || 'T';
          return {
            schema: str(r[0]),
            name: str(r[1]),
            type,
            typeLabel: TYPE_LABELS[type] ?? `Type ${type}`,
            text: str(r[3]) || null,
            owner: str(r[4]) || null,
          };
        })
        .filter((t) => t.schema && t.name);
      this.tables.set(key, { at: Date.now(), value: list });
      CatalogService.trim(this.tables);
      const entry = this.tables.get(key)!;
      return {
        tables: entry.value.slice(0, limit),
        cachedAt: new Date(entry.at).toISOString(),
        truncated: entry.value.length > limit,
      };
    });
  }

  /** Cached column metadata for one table, read from QSYS2.SYSCOLUMNS. */
  async listColumns(ownerId: string, schema: string, table: string): Promise<CatalogColumn[]> {
    const key = `${schema.toUpperCase()}.${table.toUpperCase()}`;
    const cached = this.columnsByTable.get(key);
    if (this.fresh(cached, Date.now())) return cached.value;
    return this.once(`columns:${key}`, async () => {
      const { sql, params } = this.columnsQuery(schema, table);
      const run = await this.run(sql, ownerId, params, MAX_COLUMNS);
      const list: CatalogColumn[] = run.rows
        .map((r) => {
          const length = num(r[2]);
          const precision = num(r[3]);
          const scale = num(r[4]);
          return {
            name: str(r[0]),
            type: str(r[1]),
            length,
            precision,
            scale,
            nullable: str(r[5]).toUpperCase() !== 'N',
            text: str(r[6]) || null,
            ordinal: num(r[7]) ?? 0,
          };
        })
        .filter((c) => c.name);
      this.columnsByTable.set(key, { at: Date.now(), value: list });
      CatalogService.trim(this.columnsByTable);
      return list;
    });
  }

  /**
   * Exact lookup of one catalogued table (case-insensitive), using the same
   * authority/type filters as the picker. Returns null when the reporting profile
   * cannot see it - callers turn that into a 404 rather than building SQL.
   */
  async findTable(
    ownerId: string,
    schema: string,
    table: string,
  ): Promise<CatalogTableEntry | null> {
    if (!schema.trim() || !table.trim())
      throw new AppError(400, 'UNKNOWN_TABLE', 'Choose a schema and a table.');
    const key = `${schema.toUpperCase()}.${table.toUpperCase()}`;
    const cached = this.oneTable.get(key);
    if (this.fresh(cached, Date.now())) return cached.value;
    return this.once(`table:${key}`, async () => {
      const { sql, params } = this.tableQuery({ schema, table });
      const run = await this.run(sql, ownerId, params, 2);
      const row = run.rows[0];
      const found: CatalogTableEntry | null = row
        ? {
            schema: str(row[0]),
            name: str(row[1]),
            type: str(row[2]) || 'T',
            typeLabel: TYPE_LABELS[str(row[2])] ?? `Type ${str(row[2])}`,
            text: str(row[3]) || null,
            owner: str(row[4]) || null,
          }
        : null;
      this.oneTable.set(key, { at: Date.now(), value: found });
      CatalogService.trim(this.oneTable);
      return found;
    });
  }

  /**
   * Resolve a client-supplied schema/table to the catalogued entry and its columns.
   * Unknown or unreadable tables are rejected here, before any SQL is built.
   */
  async resolveTable(ownerId: string, schema: string, table: string): Promise<ResolvedTable> {
    const found = await this.findTable(ownerId, schema, table);
    if (!found)
      throw new AppError(
        404,
        'UNKNOWN_TABLE',
        `Table ${JSON.stringify(`${schema}.${table}`)} is not in the catalog the reporting profile can read.`,
      );
    const columns = await this.listColumns(ownerId, found.schema, found.name);
    if (columns.length === 0)
      throw new AppError(
        404,
        'NO_COLUMNS',
        `No columns are visible for ${JSON.stringify(`${found.schema}.${found.name}`)}.`,
      );
    return {
      table: found,
      columns,
      cachedAt: new Date(
        this.columnsByTable.get(`${found.schema}.${found.name}`)?.at ?? Date.now(),
      ).toISOString(),
    };
  }

  /**
   * Referential constraints in which the table is the child or the parent, read from
   * QSYS2.SYSREFCST + SYSCST + SYSKEYCST (one row per key column). Used only to
   * suggest join conditions, so a catalog that cannot be read yields no suggestions
   * instead of an error.
   */
  async listForeignKeys(
    ownerId: string,
    schema: string,
    table: string,
  ): Promise<ForeignKeyColumn[]> {
    const key = `${schema.toUpperCase()}.${table.toUpperCase()}`;
    const cached = this.foreignKeys.get(key);
    if (this.fresh(cached, Date.now())) return cached.value;
    return this.once(`fks:${key}`, async () => {
      const sql = `SELECT C.TABLE_SCHEMA, C.TABLE_NAME, K.COLUMN_NAME,
       P.TABLE_SCHEMA, P.TABLE_NAME, PK.COLUMN_NAME,
       R.CONSTRAINT_NAME, K.ORDINAL_POSITION
FROM QSYS2.SYSREFCST R
JOIN QSYS2.SYSCST C
  ON C.CONSTRAINT_SCHEMA = R.CONSTRAINT_SCHEMA AND C.CONSTRAINT_NAME = R.CONSTRAINT_NAME
JOIN QSYS2.SYSKEYCST K
  ON K.CONSTRAINT_SCHEMA = R.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = R.CONSTRAINT_NAME
JOIN QSYS2.SYSCST P
  ON P.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND P.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME
JOIN QSYS2.SYSKEYCST PK
  ON PK.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND PK.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME
 AND PK.ORDINAL_POSITION = K.ORDINAL_POSITION
WHERE (C.TABLE_SCHEMA = ? AND C.TABLE_NAME = ?) OR (P.TABLE_SCHEMA = ? AND P.TABLE_NAME = ?)
ORDER BY R.CONSTRAINT_NAME, K.ORDINAL_POSITION
FETCH FIRST ${MAX_COLUMNS} ROWS ONLY`;
      let list: ForeignKeyColumn[] = [];
      try {
        const run = await this.run(sql, ownerId, [schema, table, schema, table], MAX_COLUMNS);
        list = run.rows
          .map((r) => ({
            childSchema: str(r[0]),
            childTable: str(r[1]),
            childColumn: str(r[2]),
            parentSchema: str(r[3]),
            parentTable: str(r[4]),
            parentColumn: str(r[5]),
            constraint: str(r[6]),
            ordinal: num(r[7]) ?? 0,
          }))
          .filter((f) => f.constraint && f.childColumn && f.parentColumn);
      } catch {
        list = [];
      }
      this.foreignKeys.set(key, { at: Date.now(), value: list });
      CatalogService.trim(this.foreignKeys);
      return list;
    });
  }
}
