/**
 * In-memory stand-in for a Db2 for i system behind Mapepire, just detailed enough for the
 * verification kit: QSYS2 catalog views, the migration bookkeeping tables, and generic empty
 * results for application queries. No network, no real IBM i.
 */
import type { DaemonServer, JDBCOptions, QueryResult } from '@ibm/mapepire-js';
import { expectedSchema } from '../../scripts/verify/expected.js';
import type { JobFactory, QueryLike, SqlJobLike } from '../../src/db/types.js';

type Row = Record<string, unknown>;

export interface FakeIbmiOptions {
  os?: { version: string; release: string };
  specialAuthorities?: string;
  /** OBJECT_PRIVILEGES rows for *FILE objects in data libraries. */
  fileAuthorities?: Row[];
  libAuthorities?: Row[];
  /** Libraries that already exist, with the base tables in them. */
  existingLibraries?: Record<string, string[]>;
  /** Catalog objects to hide after migrations run (simulates a missing object). */
  hideIndexes?: string[];
  /** Replace a check clause (constraint name -> clause text). */
  checkClauses?: Record<string, string>;
  connectError?: string;
  /** Extra non-file objects in a library (OBJECT_STATISTICS '*ALL'). */
  otherObjects?: Record<string, { OBJNAME: string; OBJTYPE: string }[]>;
  /** Statements matching this fail with the given SQLSTATE. */
  failOn?: { pattern: RegExp; sqlState: string; sqlCode: number };
}

export class FakeIbmi {
  readonly statements: { user: string; sql: string; params?: unknown[] }[] = [];
  readonly connections: { user: string; options: JDBCOptions }[] = [];
  readonly libraries = new Map<string, Map<string, { type: string; text: string }>>();
  readonly versions = new Map<string, { VERSION: number; FILE_NAME: string }[]>();
  readonly journals = new Set<string>();
  private readonly expected = expectedSchema();

  constructor(private readonly opts: FakeIbmiOptions = {}) {
    for (const [lib, tables] of Object.entries(opts.existingLibraries ?? {}))
      this.libraries.set(lib, new Map(tables.map((t) => [t, { type: 'T', text: '' }])));
  }

  factory: JobFactory = (options) => new FakeIbmiJob(this, options);

  connect(user: string, options: JDBCOptions) {
    if (this.opts.connectError) throw new Error(this.opts.connectError);
    this.connections.push({ user, options });
  }

  writes() {
    return this.statements.filter((s) => !/^\s*(SELECT|VALUES|WITH)\b/i.test(s.sql));
  }

  private tableRows(lib: string): Row[] {
    const t = this.libraries.get(lib);
    if (!t) return [];
    return [...t.entries()].map(([name, v]) => ({
      TABLE_NAME: name,
      TABLE_TYPE: v.type,
      TABLE_TEXT: v.text,
    }));
  }

  private present(lib: string, table: string) {
    return this.libraries.get(lib)?.has(table) ?? false;
  }

  run(user: string, sql: string, params: unknown[] = []): { rows: Row[]; updateCount: number } {
    this.statements.push({ user, sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    const f = this.opts.failOn;
    if (f && f.pattern.test(s)) {
      const e = new Error(`[SQL] ${s.slice(0, 40)} failed, ${f.sqlState}, ${f.sqlCode}`);
      Object.assign(e, { sql_state: f.sqlState, sql_rc: f.sqlCode });
      throw e;
    }
    const lib = typeof params[0] === 'string' ? params[0] : '';
    const rows = (r: Row[]) => ({ rows: r, updateCount: -1 });
    const done = { rows: [], updateCount: 1 };
    let m: RegExpExecArray | null;

    if (s.startsWith('SELECT CURRENT SERVER'))
      return rows([{ SERVER_NAME: 'TESTLPAR', USER_NAME: user }]);
    if (s.includes('SYSIBMADM.ENV_SYS_INFO'))
      return rows([
        {
          OS_NAME: 'IBM i',
          OS_VERSION: this.opts.os?.version ?? '7',
          OS_RELEASE: this.opts.os?.release ?? '5',
        },
      ]);
    if (s.includes('QSYS2.GROUP_PTF_INFO'))
      return rows([
        { PTF_GROUP_NAME: 'SF99705', PTF_GROUP_LEVEL: 12, PTF_GROUP_STATUS: 'INSTALLED' },
      ]);
    if (s.includes('OFFSET 1 ROWS FETCH FIRST 2 ROWS'))
      return rows([{ TABLE_NAME: 'A' }, { TABLE_NAME: 'B' }]);
    if (s.includes('QSYS2.USER_INFO'))
      return rows([
        {
          SPECIAL_AUTHORITIES: this.opts.specialAuthorities ?? '*NONE',
          GROUP_PROFILE_NAME: '*NONE',
          SUPPLEMENTAL_GROUP_LIST: '',
          USER_CLASS_NAME: '*USER',
        },
      ]);
    if (s.includes('FROM QSYS2.SYSSCHEMAS WHERE SYSTEM_SCHEMA_NAME')) return rows([{ N: 1 }]);
    if (s.includes('FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME'))
      return rows([{ N: this.libraries.has(lib) ? 1 : 0 }]);
    if (s.includes("OBJECT_TYPE = '*LIB'"))
      return rows(
        this.opts.libAuthorities ?? [
          {
            AUTHORIZATION_NAME: '*PUBLIC',
            OBJECT_AUTHORITY: '*USE',
            DATA_ADD: 'NO',
            DATA_DELETE: 'NO',
            OBJECT_OWNER: 'NO',
          },
        ],
      );
    if (s.includes("OBJECT_TYPE = '*FILE'"))
      return rows(
        this.opts.fileAuthorities ?? [
          {
            SYSTEM_OBJECT_NAME: 'ORDERS',
            AUTHORIZATION_NAME: user,
            OBJECT_AUTHORITY: '*USE',
            OBJECT_OWNER: 'NO',
            DATA_ADD: 'NO',
            DATA_UPDATE: 'NO',
            DATA_DELETE: 'NO',
            OBJECT_EXISTENCE: 'NO',
            OBJECT_ALTER: 'NO',
          },
        ],
      );
    if (s.includes('CAST(12345678901234567.89'))
      return rows([{ AMOUNT: '12345678901234567.89', BIG: '9007199254740993' }]);
    if (s.includes('SQL_CHECK_AUTHORITY(?, ?) AS OK')) return rows([{ OK: 0 }]);
    if (s.startsWith('SELECT TABLE_NAME, TABLE_TYPE, TABLE_TEXT FROM QSYS2.SYSTABLES'))
      return rows(this.tableRows(lib));
    if ((m = /^SELECT VERSION(?:, FILE_NAME)? FROM ([A-Z0-9_]+)\.QF_SCHEMA_VERSION/.exec(s)))
      return rows([...(this.versions.get(m[1]) ?? [])].sort((a, b) => a.VERSION - b.VERSION));
    if (s.includes('FROM QSYS2.SYSCOLUMNS'))
      return rows(
        this.expected.columns
          .filter((c) => this.present(lib, c.table))
          .map((c) => ({ TABLE_NAME: c.table, COLUMN_NAME: c.name })),
      );
    if (s.includes('FROM QSYS2.SYSCST'))
      return rows(
        this.expected.constraints
          .filter((c) => this.present(lib, c.table))
          .map((c) => ({
            CONSTRAINT_NAME: c.name,
            CONSTRAINT_TYPE: c.type,
            TABLE_NAME: c.table,
            CONSTRAINT_STATE: 'ESTABLISHED',
            ENABLED: c.type === 'CHECK' || c.type === 'FOREIGN KEY' ? 'YES' : null,
            CHECK_PENDING: c.type === 'UNIQUE' || c.type === 'PRIMARY KEY' ? null : 'NO',
          })),
      );
    if (s.includes('FROM QSYS2.SYSREFCST'))
      return rows(
        this.expected.constraints
          .filter((c) => c.type === 'FOREIGN KEY' && this.present(lib, c.table))
          .map((c) => ({ CONSTRAINT_NAME: c.name, DELETE_RULE: c.deleteRule })),
      );
    if (s.includes('FROM QSYS2.SYSCHKCST'))
      return rows(
        this.expected.constraints
          .filter((c) => c.type === 'CHECK' && this.present(lib, c.table))
          .map((c) => ({
            CONSTRAINT_NAME: c.name,
            CHECK_CLAUSE:
              this.opts.checkClauses?.[c.name] ??
              `X IN (${(c.checkLiterals ?? []).map((l) => `'${l}'`).join(', ')})`,
          })),
      );
    if (s.includes('FROM QSYS2.SYSINDEXES'))
      return rows(
        this.expected.indexes
          .filter(
            (i) => this.present(lib, i.table) && !(this.opts.hideIndexes ?? []).includes(i.name),
          )
          .map((i) => ({ INDEX_NAME: i.name, TABLE_NAME: i.table, IS_UNIQUE: i.unique })),
      );
    if (s.includes("QSYS2.OBJECT_STATISTICS(?, '*ALL')"))
      return rows([
        ...(this.journals.has(lib) ? [{ OBJNAME: 'QSQJRN', OBJTYPE: '*JRN' }] : []),
        ...(this.opts.otherObjects?.[lib] ?? []),
      ]);
    if (s.includes("QSYS2.OBJECT_STATISTICS(?, '*JRN')"))
      return rows(this.journals.has(lib) ? [{ OBJNAME: 'QSQJRN' }] : []);

    if ((m = /^CREATE SCHEMA ([A-Z0-9_]+)$/.exec(s))) {
      this.libraries.set(
        m[1],
        new Map([
          ['SYSTABLES', { type: 'V', text: '' }],
          ['SYSCOLUMNS', { type: 'V', text: '' }],
        ]),
      );
      this.journals.add(m[1]);
      return done;
    }
    if ((m = /^DROP SCHEMA ([A-Z0-9_]+) CASCADE$/.exec(s))) {
      this.libraries.delete(m[1]);
      return done;
    }
    if ((m = /^CREATE TABLE ([A-Z0-9_]+)\.([A-Z0-9_]+)/.exec(s))) {
      this.libraries.get(m[1])?.set(m[2], { type: 'T', text: '' });
      return done;
    }
    if ((m = /^LABEL ON TABLE ([A-Z0-9_]+)\.([A-Z0-9_]+) IS '(.*)'$/.exec(s))) {
      const t = this.libraries.get(m[1])?.get(m[2]);
      if (t) t.text = m[3].replaceAll("''", "'");
      return done;
    }
    if ((m = /^INSERT INTO ([A-Z0-9_]+)\.QF_SCHEMA_VERSION/.exec(s))) {
      const list = this.versions.get(m[1]) ?? [];
      list.push({ VERSION: Number(params[0]), FILE_NAME: String(params[1]) });
      this.versions.set(m[1], list);
      return done;
    }
    if (/^(SELECT|VALUES|WITH)\b/.test(s)) return rows([]);
    return done;
  }
}

class FakeIbmiJob implements SqlJobLike {
  private user = '?';
  constructor(
    private readonly db: FakeIbmi,
    private readonly options: JDBCOptions,
  ) {}
  async connect(server: DaemonServer) {
    this.user = String(server.user).toUpperCase();
    this.db.connect(this.user, this.options);
    return { success: true };
  }
  query<T>(sql: string, opts?: { parameters?: unknown[]; isTerseResults?: boolean }): QueryLike<T> {
    let out: { rows: Row[]; updateCount: number } | undefined;
    let pos = 0;
    let done = false;
    // Like @ibm/mapepire-js 1.0.2: 100 rows unless told otherwise, is_done only after a short
    // block, and no fetching once the statement is fully run.
    const page = async (n = 100): Promise<QueryResult<T>> => {
      if (done) throw new Error('Statement has already been fully run');
      out ??= this.db.run(this.user, sql, opts?.parameters);
      const all = out.rows;
      const slice = all.slice(pos, pos + n);
      pos += slice.length;
      done = slice.length < n || out.updateCount >= 0;
      const names = Object.keys(all[0] ?? {});
      const columns = names.map((name) => ({
        name,
        label: name,
        type: name === 'BIG' ? 'BIGINT' : name === 'AMOUNT' ? 'DECIMAL' : 'VARCHAR',
        precision: 19,
        scale: name === 'AMOUNT' ? 2 : 0,
        display_size: 20,
        nullable: 1,
      }));
      return {
        id: 'q',
        success: true,
        sql_rc: 0,
        sql_state: '00000',
        execution_time: 1,
        metadata: { column_count: columns.length, columns },
        is_done: done,
        has_results: out.updateCount < 0,
        update_count: out.updateCount,
        data: (opts?.isTerseResults ? slice.map((r) => names.map((k) => r[k])) : slice) as T[],
      } as unknown as QueryResult<T>;
    };
    return {
      execute: page,
      fetchMore: page,
      close: async () => {
        done = true;
        return {};
      },
    };
  }
  /** SQLJob.execute(): one default-size block (100 rows), then close. */
  async execute<T>(sql: string, opts?: { parameters?: unknown[] }) {
    const q = this.query<T>(sql, opts);
    const res = await q.execute();
    await q.close();
    return res;
  }
  async endTransaction() {
    return {};
  }
  async close() {}
}
