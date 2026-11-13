/**
 * Report Builder catalog caps: the column list (QSYS2.SYSCOLUMNS) and the foreign-key list
 * (QSYS2.SYSREFCST + SYSKEYCST) read one row past their cap, like the table list, so a table
 * with more columns or key-column rows than the cap is reported as `truncated` instead of being
 * cut off silently. The fake honours `FETCH FIRST n ROWS ONLY` the way Db2 for i would.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CatalogService, MAX_COLUMNS, MAX_FOREIGN_KEY_ROWS } from '../src/catalog/catalog.js';
import { QueryExecutor } from '../src/sql/executor.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const SCHEMA = 'SALESLIB';

/** Column counts per table. */
const WIDTH: Record<string, number> = {
  ORDERS: 3,
  WIDE: MAX_COLUMNS + 1,
  EXACT: MAX_COLUMNS,
  HUB: 2,
  EVEN: 2,
};

/** FK rows per table: `constraints` constraints of `keyColumns` columns each, HUB as child. */
const FK_SHAPE: Record<string, { constraints: number; keyColumns: number }> = {
  // 334 x 3 = 1002 rows: the cap (1000) falls inside constraint 334, which must be dropped
  HUB: { constraints: 334, keyColumns: 3 },
  // 500 x 2 = exactly 1000 rows: complete, not truncated
  EVEN: { constraints: 500, keyColumns: 2 },
};

const fetchFirst = (sql: string): number => {
  const m = /FETCH FIRST (\d+) ROWS ONLY/i.exec(sql);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

const TABLE_COLS = ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'TABLE_TEXT', 'TABLE_OWNER'].map(
  (n) => col(n, 'VARCHAR', 128),
);
const COLUMN_COLS = ['N', 'T', 'L', 'P', 'S', 'NUL', 'TXT', 'O'].map((n) => col(n, 'VARCHAR', 128));
const FK_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => col(n, 'VARCHAR', 128));

const columnRows = (table: string) =>
  Array.from({ length: WIDTH[table] ?? 0 }, (_, i) => [
    `C${String(i + 1).padStart(4, '0')}`,
    'INTEGER',
    4,
    10,
    0,
    'Y',
    null,
    i + 1,
  ]);

const fkRows = (table: string) => {
  const shape = FK_SHAPE[table];
  if (!shape) return [];
  const rows: unknown[][] = [];
  for (let c = 1; c <= shape.constraints; c++)
    for (let k = 1; k <= shape.keyColumns; k++)
      rows.push([
        SCHEMA,
        table,
        `C${String(k).padStart(4, '0')}`,
        SCHEMA,
        'ORDERS',
        `C${String(k).padStart(4, '0')}`,
        `FK${String(c).padStart(4, '0')}`,
        k,
      ]);
  return rows;
};

function catalogScript(seen: string[]) {
  return (sql: string, parameters?: unknown[]): Scripted => {
    const s = sql.toUpperCase();
    const p = (parameters ?? []).map(String);
    if (s.includes('__CONNECT__')) return { columns: [], rows: [] };
    seen.push(sql);
    const limit = fetchFirst(s);
    if (s.includes('QSYS2.SYSREFCST'))
      return { columns: FK_COLS, rows: fkRows(p[1]).slice(0, limit) };
    if (s.includes('QSYS2.SYSCOLUMNS'))
      return { columns: COLUMN_COLS, rows: columnRows(p[1]).slice(0, limit) };
    if (s.includes('QSYS2.SYSTABLES')) {
      const [schema, table] = p.slice(-2);
      return {
        columns: TABLE_COLS,
        rows: schema === SCHEMA && WIDTH[table] ? [[SCHEMA, table, 'T', null, 'QSECOFR']] : [],
      };
    }
    return { columns: [], rows: [] };
  };
}

describe('CatalogService column list cap', () => {
  const service = () => {
    const seen: string[] = [];
    const cfg = testConfig();
    const { factory } = fakeFactory(catalogScript(seen));
    return { svc: new CatalogService(cfg, new QueryExecutor(cfg, factory)), seen };
  };

  it('reads one row past MAX_COLUMNS and flags a wider table as truncated', async () => {
    const { svc, seen } = service();
    const res = await svc.listColumnsResult('u1', SCHEMA, 'WIDE');
    expect(res.columns).toHaveLength(MAX_COLUMNS);
    expect(res.truncated).toBe(true);
    expect(res.columns.at(-1)?.ordinal).toBe(MAX_COLUMNS); // the first ones, in position order
    const q = seen.find((x) => x.includes('QSYS2.SYSCOLUMNS'))!;
    expect(q).toContain(`FETCH FIRST ${MAX_COLUMNS + 1} ROWS ONLY`);
    // the flag survives the cache
    const reads = seen.length;
    expect((await svc.listColumnsResult('u1', SCHEMA, 'WIDE')).truncated).toBe(true);
    expect(seen.length).toBe(reads);
    // and the array-only accessor keeps working
    expect(await svc.listColumns('u1', SCHEMA, 'WIDE')).toHaveLength(MAX_COLUMNS);
  });

  it('is not truncated with exactly MAX_COLUMNS columns', async () => {
    const { svc } = service();
    const res = await svc.listColumnsResult('u1', SCHEMA, 'EXACT');
    expect(res.columns).toHaveLength(MAX_COLUMNS);
    expect(res.truncated).toBe(false);
  });

  it('resolveTable carries the flag', async () => {
    const { svc } = service();
    expect((await svc.resolveTable('u1', SCHEMA, 'WIDE')).columnsTruncated).toBe(true);
    expect((await svc.resolveTable('u1', SCHEMA, 'ORDERS')).columnsTruncated).toBe(false);
  });
});

describe('CatalogService foreign-key list cap', () => {
  const service = () => {
    const seen: string[] = [];
    const cfg = testConfig();
    const { factory } = fakeFactory(catalogScript(seen));
    return { svc: new CatalogService(cfg, new QueryExecutor(cfg, factory)), seen };
  };

  it('flags truncation and drops the constraint the cap cut short', async () => {
    const { svc, seen } = service();
    const res = await svc.listForeignKeysResult('u1', SCHEMA, 'HUB');
    expect(res.truncated).toBe(true);
    // 1000 rows read = 333 whole 3-column constraints + 1 column of FK0334, which is dropped
    expect(res.foreignKeys).toHaveLength(999);
    expect(new Set(res.foreignKeys.map((f) => f.constraint)).size).toBe(333);
    expect(res.foreignKeys.some((f) => f.constraint === 'FK0334')).toBe(false);
    const q = seen.find((x) => x.includes('QSYS2.SYSREFCST'))!;
    expect(q).toContain(`FETCH FIRST ${MAX_FOREIGN_KEY_ROWS + 1} ROWS ONLY`);
    expect(q).toContain('ORDER BY R.CONSTRAINT_SCHEMA, R.CONSTRAINT_NAME, K.ORDINAL_POSITION');
    // cached, flag included
    const reads = seen.length;
    expect((await svc.listForeignKeysResult('u1', SCHEMA, 'HUB')).truncated).toBe(true);
    expect(seen.length).toBe(reads);
    expect(await svc.listForeignKeys('u1', SCHEMA, 'HUB')).toHaveLength(999);
  });

  it('is not truncated with exactly MAX_FOREIGN_KEY_ROWS rows', async () => {
    const { svc } = service();
    const res = await svc.listForeignKeysResult('u1', SCHEMA, 'EVEN');
    expect(res.truncated).toBe(false);
    expect(res.foreignKeys).toHaveLength(MAX_FOREIGN_KEY_ROWS);
  });

  it('an unreadable foreign-key catalog yields no suggestions and no flag', async () => {
    const cfg = testConfig();
    const { factory } = fakeFactory((sql) =>
      sql.includes('__CONNECT__')
        ? { columns: [], rows: [] }
        : { columns: [], rows: [], error: { message: 'SQL0551 not authorized' } },
    );
    const svc = new CatalogService(cfg, new QueryExecutor(cfg, factory));
    expect(await svc.listForeignKeysResult('u1', SCHEMA, 'HUB')).toEqual({
      foreignKeys: [],
      truncated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

let app: ReturnType<typeof createApp>['app'];

beforeEach(() => {
  const db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  app = createApp({
    cfg: testConfig(),
    metadataDb: db,
    jobFactory: fakeFactory(catalogScript([])).factory,
  }).app;
});

async function login() {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username: 'alice', password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  return {
    agent,
    post: (url: string) => agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf),
  };
}

describe('GET /api/schema/tables/:schema/:table/columns truncation', () => {
  it('reports truncated: true and the cap for a table wider than MAX_COLUMNS', async () => {
    const { agent } = await login();
    const res = await agent.get(`/api/schema/tables/${SCHEMA}/WIDE/columns`);
    expect(res.status).toBe(200);
    expect(res.body.columns).toHaveLength(MAX_COLUMNS);
    expect(res.body.truncated).toBe(true);
    expect(res.body.maxColumns).toBe(MAX_COLUMNS);
  });

  it('reports truncated: false for a complete list', async () => {
    const { agent } = await login();
    for (const table of ['ORDERS', 'EXACT']) {
      const res = await agent.get(`/api/schema/tables/${SCHEMA}/${table}/columns`);
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(false);
      expect(res.body.columns).toHaveLength(WIDTH[table]);
    }
  });
});

describe('POST /api/schema/join-suggestions truncation', () => {
  it('reports foreignKeysTruncated when the foreign-key list hit its cap', async () => {
    const { post } = await login();
    const res = await post('/api/schema/join-suggestions').send({
      tables: [{ alias: 'T1', schema: SCHEMA, table: 'ORDERS' }],
      schema: SCHEMA,
      table: 'HUB',
    });
    expect(res.status).toBe(200);
    expect(res.body.foreignKeysTruncated).toBe(true);
    expect(res.body.maxForeignKeyRows).toBe(MAX_FOREIGN_KEY_ROWS);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  it('reports foreignKeysTruncated: false for a complete list', async () => {
    const { post } = await login();
    const res = await post('/api/schema/join-suggestions').send({
      tables: [{ alias: 'T1', schema: SCHEMA, table: 'ORDERS' }],
      schema: SCHEMA,
      table: 'EVEN',
    });
    expect(res.status).toBe(200);
    expect(res.body.foreignKeysTruncated).toBe(false);
  });
});
