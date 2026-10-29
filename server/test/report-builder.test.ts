import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CatalogService, displayType, likePattern } from '../src/catalog/catalog.js';
import {
  buildReportSql,
  quoteIdentifier,
  suggestReportName,
  type CatalogColumn,
  type CatalogTable,
} from '../src/catalog/sql-builder.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// ---------------------------------------------------------------------------
// Fixtures: catalog metadata exactly as the catalog service caches it
// ---------------------------------------------------------------------------

const orders: CatalogTable = {
  schema: 'SALESLIB',
  name: 'ORDERS',
  type: 'T',
  text: 'Customer orders',
  owner: 'QSECOFR',
};

const ordersColumns: CatalogColumn[] = [
  {
    name: 'ORDER_ID',
    type: 'INTEGER',
    length: 4,
    precision: 10,
    scale: 0,
    nullable: false,
    text: 'Order number',
    ordinal: 1,
  },
  {
    name: 'CUSTOMER',
    type: 'VARCHAR',
    length: 40,
    precision: 40,
    scale: null,
    nullable: true,
    text: 'Customer name',
    ordinal: 2,
  },
  {
    name: 'AMOUNT',
    type: 'DECIMAL',
    length: 11,
    precision: 11,
    scale: 2,
    nullable: true,
    text: 'Order total',
    ordinal: 3,
  },
  {
    name: 'NOTE',
    type: 'VARCHAR',
    length: 60,
    precision: 60,
    scale: null,
    nullable: true,
    text: null,
    ordinal: 4,
  },
];

describe('quoteIdentifier', () => {
  it('wraps a plain IBM i name in double quotes', () => {
    expect(quoteIdentifier('ORDER_ID')).toBe('"ORDER_ID"');
    expect(quoteIdentifier('Sales Total')).toBe('"Sales Total"');
  });
  it('doubles embedded double quotes so they cannot end the identifier', () => {
    expect(quoteIdentifier('A"B')).toBe('"A""B"');
    expect(quoteIdentifier('""')).toBe('""""""');
    expect(quoteIdentifier('X" FROM QSYS2.SYSTABLES --')).toBe('"X"" FROM QSYS2.SYSTABLES --"');
  });
  it('rejects empty, over-long and control-character names', () => {
    expect(() => quoteIdentifier('')).toThrow(/empty/i);
    expect(() => quoteIdentifier('   ')).toThrow(/empty/i);
    expect(() => quoteIdentifier('A'.repeat(129))).toThrow(/128/);
    expect(() => quoteIdentifier('A\nB')).toThrow(/control character/i);
  });
});

describe('buildReportSql', () => {
  it('emits a schema-qualified SELECT with a quoted list and no sort', () => {
    expect(
      buildReportSql(
        { schema: 'SALESLIB', table: 'ORDERS', columns: ['ORDER_ID', 'CUSTOMER'] },
        orders,
        ordersColumns,
      ),
    ).toBe('SELECT "ORDER_ID", "CUSTOMER"\nFROM "SALESLIB"."ORDERS"');
  });

  it('keeps the client column order and appends ORDER BY with directions', () => {
    expect(
      buildReportSql(
        {
          schema: 'SALESLIB',
          table: 'ORDERS',
          columns: ['CUSTOMER', 'ORDER_ID'],
          sort: [
            { column: 'AMOUNT', direction: 'DESC' },
            { column: 'CUSTOMER', direction: 'ASC' },
          ],
        },
        orders,
        ordersColumns,
      ),
    ).toBe(
      'SELECT "CUSTOMER", "ORDER_ID"\nFROM "SALESLIB"."ORDERS"\nORDER BY "AMOUNT" DESC, "CUSTOMER" ASC',
    );
  });

  it('uses the catalog spelling and accepts a unique case-insensitive match', () => {
    const mixed: CatalogTable = { ...orders, name: 'MixedCase' };
    const cols: CatalogColumn[] = [{ ...ordersColumns[0], name: 'Cust No' }];
    expect(
      buildReportSql({ schema: 'saleslib', table: 'mixedcase', columns: ['cust no'] }, mixed, cols),
    ).toBe('SELECT "Cust No"\nFROM "SALESLIB"."MixedCase"');
  });

  it('rejects an empty selection', () => {
    expect(() =>
      buildReportSql({ schema: 'SALESLIB', table: 'ORDERS', columns: [] }, orders, ordersColumns),
    ).toThrow(/at least one column/i);
  });

  it('rejects duplicate selected columns', () => {
    expect(() =>
      buildReportSql(
        { schema: 'SALESLIB', table: 'ORDERS', columns: ['ORDER_ID', 'order_id'] },
        orders,
        ordersColumns,
      ),
    ).toThrow(/more than once/i);
  });

  it('rejects duplicate sort columns', () => {
    expect(() =>
      buildReportSql(
        {
          schema: 'SALESLIB',
          table: 'ORDERS',
          columns: ['ORDER_ID'],
          sort: [
            { column: 'ORDER_ID', direction: 'ASC' },
            { column: 'order_id', direction: 'DESC' },
          ],
        },
        orders,
        ordersColumns,
      ),
    ).toThrow(/more than once in the sort/i);
  });

  it('rejects an invalid sort direction', () => {
    for (const direction of ['UP', '', 'asc desc', 'DESC; DROP TABLE']) {
      expect(() =>
        buildReportSql(
          {
            schema: 'SALESLIB',
            table: 'ORDERS',
            columns: ['ORDER_ID'],
            // deliberately wrong types: the builder must not trust the client
            sort: [{ column: 'ORDER_ID', direction: direction as 'ASC' }],
          },
          orders,
          ordersColumns,
        ),
      ).toThrow(/ASC or DESC/);
    }
  });

  it('rejects sort columns that are not in the catalog', () => {
    expect(() =>
      buildReportSql(
        {
          schema: 'SALESLIB',
          table: 'ORDERS',
          columns: ['ORDER_ID'],
          sort: [{ column: 'NOT_A_COLUMN', direction: 'ASC' }],
        },
        orders,
        ordersColumns,
      ),
    ).toThrow(/not in the cached catalog/i);
  });

  it('rejects injection attempts in column and table names', () => {
    const evil = [
      'ORDER_ID"',
      'ORDER_ID; DROP TABLE SALESLIB.ORDERS',
      'ORDER_ID FROM QSYS2.SYSTABLES --',
      'SALESLIB.ORDERS.ORDER_ID',
      '"ORDER_ID"',
      'ORDER_ID, CUSTOMER',
      'ORDER_ID/**/',
    ];
    for (const name of evil) {
      expect(() =>
        buildReportSql(
          { schema: 'SALESLIB', table: 'ORDERS', columns: [name] },
          orders,
          ordersColumns,
        ),
      ).toThrow(/catalog/i);
    }
    expect(() =>
      buildReportSql(
        { schema: 'SALESLIB', table: 'ORDERS" OR "1"="1', columns: ['ORDER_ID'] },
        orders,
        ordersColumns,
      ),
    ).toThrow(/catalogued table/i);
    expect(() =>
      buildReportSql(
        { schema: 'QSYS2', table: 'SYSTABLES', columns: ['ORDER_ID'] },
        orders,
        ordersColumns,
      ),
    ).toThrow(/catalogued table/i);
  });

  it('rejects ambiguous case-insensitive matches', () => {
    const cols: CatalogColumn[] = [
      { ...ordersColumns[0], name: 'Order' },
      { ...ordersColumns[1], name: 'ORDER' },
    ];
    expect(() =>
      buildReportSql({ schema: 'SALESLIB', table: 'ORDERS', columns: ['order'] }, orders, cols),
    ).toThrow(/more than one object/i);
  });

  it('quotes a catalog name that itself contains a double quote', () => {
    const cols: CatalogColumn[] = [{ ...ordersColumns[0], name: 'WEIRD"COL' }];
    expect(
      buildReportSql({ schema: 'SALESLIB', table: 'ORDERS', columns: ['WEIRD"COL'] }, orders, cols),
    ).toBe('SELECT "WEIRD""COL"\nFROM "SALESLIB"."ORDERS"');
  });
});

describe('suggestReportName', () => {
  it('names the report from the table, fields and sort', () => {
    expect(
      suggestReportName({
        schema: 'SALESLIB',
        table: 'ORDERS',
        columns: ['ORDER_ID', 'CUSTOMER'],
        sort: [{ column: 'ORDER_ID', direction: 'DESC' }],
      }),
    ).toBe('ORDERS: ORDER_ID, CUSTOMER sorted by ORDER_ID DESC');
  });
  it('shortens long selections and caps the name at 128 characters', () => {
    const long = suggestReportName({
      schema: 'S',
      table: 'T',
      columns: ['A', 'B', 'C', 'D', 'E', 'F'],
    });
    expect(long).toBe('T: A, B, C, D +2 more');
    const caps = suggestReportName({
      schema: 'S',
      table: 'T'.repeat(128),
      columns: Array.from({ length: 40 }, (_, i) => `COLUMN_${i}`),
    });
    expect(caps.length).toBe(128);
  });
});

describe('catalog helpers', () => {
  it('formats Db2 for i types for display', () => {
    expect(
      displayType({
        name: 'A',
        type: 'DECIMAL',
        length: 11,
        precision: 11,
        scale: 2,
        nullable: true,
        text: null,
      }),
    ).toBe('DECIMAL(11, 2)');
    expect(
      displayType({
        name: 'A',
        type: 'VARCHAR',
        length: 40,
        precision: 40,
        scale: null,
        nullable: true,
        text: null,
      }),
    ).toBe('VARCHAR(40)');
    expect(
      displayType({
        name: 'A',
        type: 'TIMESTMP',
        length: 26,
        precision: null,
        scale: null,
        nullable: true,
        text: null,
      }),
    ).toBe('TIMESTAMP');
    expect(
      displayType({
        name: 'A',
        type: 'INTEGER',
        length: 4,
        precision: 10,
        scale: 0,
        nullable: true,
        text: null,
      }),
    ).toBe('INTEGER');
  });
  it('strips LIKE wildcards from a search term', () => {
    expect(likePattern(' ord%ers_ ')).toBe('%ORDERS%');
  });
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

const TABLE_COLUMNS = [
  col('TABLE_SCHEMA', 'VARCHAR', 128),
  col('TABLE_NAME', 'VARCHAR', 128),
  col('TABLE_TYPE', 'CHAR', 1),
  col('TABLE_TEXT', 'VARCHAR', 50),
  col('TABLE_OWNER', 'VARCHAR', 128),
];

const COLUMN_COLUMNS = [
  col('COLUMN_NAME', 'VARCHAR', 128),
  col('DATA_TYPE', 'VARCHAR', 8),
  col('LENGTH', 'INTEGER'),
  col('NUMERIC_PRECISION', 'INTEGER'),
  col('NUMERIC_SCALE', 'INTEGER'),
  col('IS_NULLABLE', 'CHAR', 1),
  col('COLUMN_TEXT', 'VARCHAR', 50),
  col('ORDINAL_POSITION', 'INTEGER'),
];

const tableRow = (name: string, type = 'T', text: string | null = null) => [
  'SALESLIB',
  name,
  type,
  text,
  'QSECOFR',
];

const columnRow = (
  name: string,
  type: string,
  length: number,
  precision: number | null = null,
  scale: number | null = null,
  nullable = 'Y',
  text: string | null = null,
  ordinal = 1,
) => [name, type, length, precision, scale, nullable, text, ordinal];

interface Seen {
  sql: string;
  parameters?: unknown[];
}

let db: FakeMetadataDb;
let app: ReturnType<typeof createApp>['app'];
let seen: Seen[];
let catalogTables: unknown[][];

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  seen = [];
  catalogTables = [
    tableRow('ORDERS', 'T', 'Customer orders'),
    tableRow('CUSTOMERS', 'T', 'Customers'),
    tableRow('OPEN_ORDERS', 'V', 'Orders not shipped'),
  ];
  const script = (sql: string, parameters?: unknown[]): Scripted => {
    seen.push({ sql, parameters });
    const s = sql.toUpperCase();
    if (s.includes('__CONNECT__')) return { columns: [], rows: [] };
    if (s.includes('QSYS2.SYSTABLES')) {
      // Honour the bound schema/table equality predicates the way Db2 for i would.
      let rows = catalogTables;
      if (s.includes('UPPER(TABLE_SCHEMA) = ?')) {
        const [schema, table] = (parameters ?? []).slice(-2).map((p) => String(p));
        rows = catalogTables.filter((r) => r[0] === schema && r[1] === table);
      }
      return { columns: TABLE_COLUMNS, rows };
    }
    if (s.includes('QSYS2.SYSCOLUMNS'))
      return {
        columns: COLUMN_COLUMNS,
        rows: [
          columnRow('ORDER_ID', 'INTEGER', 4, 10, 0, 'N', 'Order number', 1),
          columnRow('CUSTOMER', 'VARCHAR', 40, 40, null, 'Y', 'Customer name', 2),
          columnRow('AMOUNT', 'DECIMAL', 11, 11, 2, 'Y', 'Order total', 3),
        ],
      };
    return {
      columns: [col('ORDER_ID', 'INTEGER'), col('CUSTOMER', 'VARCHAR', 40)],
      rows: [
        [1, 'Acme'],
        [2, 'Globex'],
      ],
    };
  };
  const f = fakeFactory(script);
  app = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
});

async function login() {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username: 'alice', password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const send = (method: 'post', url: string) =>
    agent[method](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return { agent, send };
}

const catalogQueries = (needle: string) => seen.filter((q) => q.sql.toUpperCase().includes(needle));

describe('GET /api/schema/tables', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/schema/tables')).status).toBe(401);
  });

  it('lists catalogued tables with type labels', async () => {
    const { agent } = await login();
    const res = await agent.get('/api/schema/tables');
    expect(res.status).toBe(200);
    expect(res.body.tables).toEqual([
      {
        schema: 'SALESLIB',
        name: 'ORDERS',
        type: 'T',
        typeLabel: 'Table',
        text: 'Customer orders',
      },
      { schema: 'SALESLIB', name: 'CUSTOMERS', type: 'T', typeLabel: 'Table', text: 'Customers' },
      {
        schema: 'SALESLIB',
        name: 'OPEN_ORDERS',
        type: 'V',
        typeLabel: 'View',
        text: 'Orders not shipped',
      },
    ]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.maxTables).toBe(500);
    expect(new Date(res.body.cachedAt).toString()).not.toBe('Invalid Date');
  });

  it('binds the search term as a parameter instead of inlining it', async () => {
    const { agent } = await login();
    const res = await agent.get('/api/schema/tables?search=zz%25_x');
    expect(res.status).toBe(200);
    const [query] = catalogQueries('QSYS2.SYSTABLES');
    expect(query.sql).not.toContain('ZZ');
    expect(query.sql).toContain('UPPER(TABLE_NAME) LIKE ?');
    expect(query.parameters).toContain('%ZZX%'); // wildcards stripped, uppercased
  });

  it('respects limit and reports truncation', async () => {
    const { agent } = await login();
    const res = await agent.get('/api/schema/tables?limit=2');
    expect(res.body.tables).toHaveLength(2);
    expect(res.body.truncated).toBe(true);
  });

  it('serves repeat searches from the in-memory cache', async () => {
    const { agent } = await login();
    await agent.get('/api/schema/tables?search=ord');
    const before = catalogQueries('QSYS2.SYSTABLES').length;
    const again = await agent.get('/api/schema/tables?search=ord');
    expect(again.status).toBe(200);
    expect(again.body.tables).toHaveLength(3);
    expect(catalogQueries('QSYS2.SYSTABLES').length).toBe(before);
  });

  it('turns catalog failures into a 503 with the app error shape', async () => {
    const f = fakeFactory(() => ({ columns: [], rows: [], error: { message: 'no route' } }));
    const failing = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
    const agent = request.agent(failing);
    const loginRes = await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'alice', password: PW });
    expect(loginRes.status).toBe(200);
    const res = await agent.get('/api/schema/tables');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_UNAVAILABLE');
  });
});

describe('GET /api/schema/tables/:schema/:table/columns', () => {
  it('returns column metadata with display types', async () => {
    const { agent } = await login();
    const res = await agent.get('/api/schema/tables/SALESLIB/ORDERS/columns');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'SALESLIB', table: 'ORDERS', type: 'T' });
    expect(res.body.columns).toEqual([
      {
        name: 'ORDER_ID',
        type: 'INTEGER',
        displayType: 'INTEGER',
        length: 4,
        precision: 10,
        scale: 0,
        nullable: false,
        text: 'Order number',
        ordinal: 1,
      },
      {
        name: 'CUSTOMER',
        type: 'VARCHAR',
        displayType: 'VARCHAR(40)',
        length: 40,
        precision: 40,
        scale: null,
        nullable: true,
        text: 'Customer name',
        ordinal: 2,
      },
      {
        name: 'AMOUNT',
        type: 'DECIMAL',
        displayType: 'DECIMAL(11, 2)',
        length: 11,
        precision: 11,
        scale: 2,
        nullable: true,
        text: 'Order total',
        ordinal: 3,
      },
    ]);
  });

  it('404s for a table the catalog does not list', async () => {
    const { agent } = await login();
    const res = await agent.get('/api/schema/tables/SALESLIB/NOPE/columns');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_TABLE');
  });

  it('never inlines the requested names into the catalog SQL', async () => {
    const { agent } = await login();
    await agent.get('/api/schema/tables/SALESLIB/ORDERS/columns');
    const [q] = catalogQueries('QSYS2.SYSCOLUMNS');
    expect(q.sql).not.toContain('SALESLIB');
    expect(q.parameters).toEqual(['SALESLIB', 'ORDERS']);
  });
});

describe('POST /api/schema/sql', () => {
  it('returns the server-built SELECT for a valid selection', async () => {
    const { send } = await login();
    const res = await send('post', '/api/schema/sql').send({
      schema: 'SALESLIB',
      table: 'ORDERS',
      columns: ['ORDER_ID', 'CUSTOMER'],
      sort: [{ column: 'AMOUNT', direction: 'DESC' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sql: 'SELECT "ORDER_ID", "CUSTOMER"\nFROM "SALESLIB"."ORDERS"\nORDER BY "AMOUNT" DESC',
      name: 'ORDERS: ORDER_ID, CUSTOMER sorted by AMOUNT DESC',
      schema: 'SALESLIB',
      table: 'ORDERS',
    });
  });

  it('rejects injected identifiers with a 400 and nothing is executed', async () => {
    const { send } = await login();
    const res = await send('post', '/api/schema/sql').send({
      schema: 'SALESLIB',
      table: 'ORDERS',
      columns: ['ORDER_ID"; DROP TABLE SALESLIB.ORDERS; --'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_COLUMN');
    expect(seen.some((q) => q.sql.includes('DROP'))).toBe(false);
  });

  it('rejects an empty selection at the schema layer', async () => {
    const { send } = await login();
    const res = await send('post', '/api/schema/sql').send({
      schema: 'SALESLIB',
      table: 'ORDERS',
      columns: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a bad sort direction at the schema layer', async () => {
    const { send } = await login();
    const res = await send('post', '/api/schema/sql').send({
      schema: 'SALESLIB',
      table: 'ORDERS',
      columns: ['ORDER_ID'],
      sort: [{ column: 'ORDER_ID', direction: 'SIDEWAYS' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires a CSRF token', async () => {
    const { agent } = await login();
    const res = await agent
      .post('/api/schema/sql')
      .set('Origin', ORIGIN)
      .send({ schema: 'SALESLIB', table: 'ORDERS', columns: ['ORDER_ID'] });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/schema/run', () => {
  it('builds the SELECT server-side and returns results plus the builder metadata', async () => {
    const { send } = await login();
    const res = await send('post', '/api/schema/run').send({
      schema: 'SALESLIB',
      table: 'ORDERS',
      columns: ['ORDER_ID', 'CUSTOMER'],
      sort: [{ column: 'ORDER_ID', direction: 'DESC' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.builder).toEqual({
      name: 'ORDERS: ORDER_ID, CUSTOMER sorted by ORDER_ID DESC',
      sql: 'SELECT "ORDER_ID", "CUSTOMER"\nFROM "SALESLIB"."ORDERS"\nORDER BY "ORDER_ID" DESC',
    });
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual(['ORDER_ID', 'CUSTOMER']);
    expect(res.body.rows).toEqual([
      [1, 'Acme'],
      [2, 'Globex'],
    ]);
    // The statement the fake job saw is the server-built one, not anything from the client.
    expect(seen.some((q) => q.sql === res.body.builder.sql)).toBe(true);
  });

  it('rejects an unknown table before executing anything', async () => {
    const { send } = await login();
    const res = await send('post', '/api/schema/run').send({
      schema: 'SALESLIB',
      table: 'NOT_THERE',
      columns: ['ORDER_ID'],
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_TABLE');
    expect(seen.some((q) => q.sql.startsWith('SELECT "ORDER_ID"'))).toBe(false);
  });
});

describe('CatalogService', () => {
  it('caches per search key and can be invalidated', async () => {
    const f = fakeFactory((sql) => {
      seen.push({ sql });
      const s = sql.toUpperCase();
      if (s.includes('QSYS2.SYSTABLES'))
        return { columns: TABLE_COLUMNS, rows: [tableRow('ORDERS')] };
      if (s.includes('QSYS2.SYSCOLUMNS'))
        return { columns: COLUMN_COLUMNS, rows: [columnRow('ORDER_ID', 'INTEGER', 4)] };
      return { columns: [], rows: [] };
    });
    const cfg = testConfig({ CATALOG_CACHE_TTL_MS: '60000' });
    const appBundle = createApp({ cfg, metadataDb: db, jobFactory: f.factory });
    const svc = new CatalogService(cfg, appBundle.executor, { ttlMs: 60000 });
    const a = await svc.listTables('u-alice', { search: 'ord' });
    const b = await svc.listTables('u-alice', { search: 'ORD' });
    expect(b.cachedAt).toBe(a.cachedAt);
    expect(seen.filter((q) => q.sql.includes('QSYS2.SYSTABLES'))).toHaveLength(1);
    svc.invalidate();
    await svc.listTables('u-alice', { search: 'ord' });
    expect(seen.filter((q) => q.sql.includes('QSYS2.SYSTABLES'))).toHaveLength(2);
  });

  it('reads columns for the catalogued spelling of the table', async () => {
    const f = fakeFactory((sql, parameters) => {
      seen.push({ sql, parameters });
      const s = sql.toUpperCase();
      if (s.includes('QSYS2.SYSTABLES'))
        return { columns: TABLE_COLUMNS, rows: [tableRow('ORDERS')] };
      if (s.includes('QSYS2.SYSCOLUMNS'))
        return { columns: COLUMN_COLUMNS, rows: [columnRow('ORDER_ID', 'INTEGER', 4, 10, 0, 'N')] };
      return { columns: [], rows: [] };
    });
    const cfg = testConfig();
    const bundle = createApp({ cfg, metadataDb: db, jobFactory: f.factory });
    const svc = new CatalogService(cfg, bundle.executor);
    const resolved = await svc.resolveTable('u-alice', 'saleslib', 'orders');
    expect(resolved.table.name).toBe('ORDERS');
    expect(resolved.columns.map((c) => c.name)).toEqual(['ORDER_ID']);
    expect(seen.filter((q) => q.sql.includes('QSYS2.SYSCOLUMNS')).at(-1)?.parameters).toEqual([
      'SALESLIB',
      'ORDERS',
    ]);
  });
});
