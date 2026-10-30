import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  ALIAS_PATTERN,
  buildJoinedReportSql,
  comparability,
  suggestJoinConditions,
  suggestJoinedReportName,
  type ForeignKeyColumn,
  type JoinedReportSpec,
  type ResolvedSource,
} from '../src/catalog/join-builder.js';
import type { CatalogColumn } from '../src/catalog/sql-builder.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// ---------------------------------------------------------------------------
// Fixtures: the demo catalog (ORDERS → CUSTOMERS, ORDER_LINES → ORDERS / INVENTORY)
// ---------------------------------------------------------------------------

type ColDef = [string, string, number | null, number | null];
const cols = (defs: ColDef[]): CatalogColumn[] =>
  defs.map(([name, type, precision, scale], i) => ({
    name,
    type,
    length: precision,
    precision,
    scale,
    nullable: true,
    text: null,
    ordinal: i + 1,
  }));

const DEFS: Record<string, ColDef[]> = {
  ORDERS: [
    ['ORDER_ID', 'INTEGER', 10, 0],
    ['CUSTNO', 'INTEGER', 10, 0],
    ['REGION', 'CHAR', 5, null],
    ['AMOUNT', 'DECIMAL', 11, 2],
    ['ORDER_DATE', 'DATE', null, null],
  ],
  CUSTOMERS: [
    ['CUSTNO', 'INTEGER', 10, 0],
    ['NAME', 'VARCHAR', 40, null],
    ['REGION', 'CHAR', 5, null],
  ],
  ORDER_LINES: [
    ['LINE_ID', 'INTEGER', 10, 0],
    ['ORDER_ID', 'INTEGER', 10, 0],
    ['ITEM', 'CHAR', 8, null],
    ['QTY', 'INTEGER', 10, 0],
  ],
  INVENTORY: [
    ['ITEM', 'CHAR', 8, null],
    ['DESCRIPTION', 'VARCHAR', 40, null],
    ['ON_HAND', 'INTEGER', 10, 0],
  ],
  EMPLOYEES: [
    ['EMPNO', 'INTEGER', 10, 0],
    ['NAME', 'VARCHAR', 40, null],
    ['MANAGER', 'INTEGER', 10, 0],
    ['EMP_CODE', 'CHAR', 6, null],
    ['STAMP', 'TIMESTAMP', null, null],
  ],
};

const src = (name: string): ResolvedSource => ({
  table: { schema: 'DEMOLIB', name, type: 'T', text: null },
  columns: cols(DEFS[name]),
});

const FKS: ForeignKeyColumn[] = [
  ['ORDERS_FK_CUSTOMER', 'ORDERS', 'CUSTNO', 'CUSTOMERS', 'CUSTNO'],
  ['ORDER_LINES_FK_ORDER', 'ORDER_LINES', 'ORDER_ID', 'ORDERS', 'ORDER_ID'],
  ['ORDER_LINES_FK_ITEM', 'ORDER_LINES', 'ITEM', 'INVENTORY', 'ITEM'],
].map(([constraint, childTable, childColumn, parentTable, parentColumn]) => ({
  constraint,
  childSchema: 'DEMOLIB',
  childTable,
  childColumn,
  parentSchema: 'DEMOLIB',
  parentTable,
  parentColumn,
  ordinal: 1,
}));

const on = (table: string, left: string, right = left) => [
  { left: { table, column: left }, right: { column: right } },
];

const ordersCustomers = (over: Partial<JoinedReportSpec> = {}): JoinedReportSpec => ({
  schema: 'DEMOLIB',
  table: 'ORDERS',
  joins: [{ schema: 'DEMOLIB', table: 'CUSTOMERS', type: 'INNER', on: on('T1', 'CUSTNO') }],
  columns: ['ORDER_ID', { table: 'T2', column: 'NAME' }],
  ...over,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('buildJoinedReportSql', () => {
  it('builds a two-table INNER JOIN with generated aliases and qualified columns', () => {
    const out = buildJoinedReportSql(ordersCustomers(), [src('ORDERS'), src('CUSTOMERS')]);
    expect(out.sql).toBe(
      'SELECT "T1"."ORDER_ID",\n       "T2"."NAME"\n' +
        'FROM "DEMOLIB"."ORDERS" AS "T1"\n' +
        'INNER JOIN "DEMOLIB"."CUSTOMERS" AS "T2"\n  ON "T1"."CUSTNO" = "T2"."CUSTNO"',
    );
    expect(out.aliases).toEqual(['T1', 'T2']);
    expect(out.warnings).toEqual([]);
  });

  it('builds a three-table chain and sorts on a column of any table', () => {
    const out = buildJoinedReportSql(
      {
        schema: 'DEMOLIB',
        table: 'ORDER_LINES',
        alias: 'L',
        joins: [
          {
            schema: 'DEMOLIB',
            table: 'ORDERS',
            alias: 'O',
            type: 'INNER',
            on: on('L', 'ORDER_ID'),
          },
          { schema: 'DEMOLIB', table: 'INVENTORY', alias: 'I', type: 'LEFT', on: on('L', 'ITEM') },
        ],
        columns: [
          'LINE_ID',
          { table: 'O', column: 'AMOUNT' },
          { table: 'I', column: 'DESCRIPTION' },
        ],
        sort: [
          { table: 'O', column: 'ORDER_DATE', direction: 'DESC' },
          { column: 'LINE_ID', direction: 'ASC' },
        ],
      },
      [src('ORDER_LINES'), src('ORDERS'), src('INVENTORY')],
    );
    expect(out.sql).toBe(
      'SELECT "L"."LINE_ID",\n       "O"."AMOUNT",\n       "I"."DESCRIPTION"\n' +
        'FROM "DEMOLIB"."ORDER_LINES" AS "L"\n' +
        'INNER JOIN "DEMOLIB"."ORDERS" AS "O"\n  ON "L"."ORDER_ID" = "O"."ORDER_ID"\n' +
        'LEFT OUTER JOIN "DEMOLIB"."INVENTORY" AS "I"\n  ON "L"."ITEM" = "I"."ITEM"\n' +
        'ORDER BY "O"."ORDER_DATE" DESC, "L"."LINE_ID" ASC',
    );
  });

  it('emits every join type and AND-ed multi-column conditions', () => {
    for (const [type, sql] of [
      ['LEFT', 'LEFT OUTER JOIN'],
      ['RIGHT', 'RIGHT OUTER JOIN'],
      ['FULL', 'FULL OUTER JOIN'],
    ] as const) {
      const out = buildJoinedReportSql(
        ordersCustomers({
          joins: [
            {
              schema: 'DEMOLIB',
              table: 'CUSTOMERS',
              type,
              on: [...on('T1', 'CUSTNO'), ...on('T1', 'REGION')],
            },
          ],
        }),
        [src('ORDERS'), src('CUSTOMERS')],
      );
      expect(out.sql).toContain(
        `${sql} "DEMOLIB"."CUSTOMERS" AS "T2"\n  ON "T1"."CUSTNO" = "T2"."CUSTNO"\n  AND "T1"."REGION" = "T2"."REGION"`,
      );
    }
  });

  it('supports a self-join under two aliases', () => {
    const out = buildJoinedReportSql(
      {
        schema: 'DEMOLIB',
        table: 'EMPLOYEES',
        alias: 'E',
        joins: [
          {
            schema: 'DEMOLIB',
            table: 'EMPLOYEES',
            alias: 'MGR',
            type: 'LEFT',
            on: on('E', 'MANAGER', 'EMPNO'),
          },
        ],
        columns: ['NAME', { table: 'MGR', column: 'NAME' }],
      },
      [src('EMPLOYEES'), src('EMPLOYEES')],
    );
    expect(out.sql).toBe(
      'SELECT "E"."NAME" AS "EMPLOYEES_NAME",\n       "MGR"."NAME" AS "MGR_NAME"\n' +
        'FROM "DEMOLIB"."EMPLOYEES" AS "E"\n' +
        'LEFT OUTER JOIN "DEMOLIB"."EMPLOYEES" AS "MGR"\n  ON "E"."MANAGER" = "MGR"."EMPNO"',
    );
    expect(out.columns.map((c) => c.name)).toEqual(['EMPLOYEES_NAME', 'MGR_NAME']);
  });

  it('generates unique output names for duplicate column names', () => {
    const out = buildJoinedReportSql(
      ordersCustomers({
        columns: [
          'ORDER_ID',
          'REGION',
          { table: 'T2', column: 'REGION' },
          { table: 'T2', column: 'NAME' },
        ],
      }),
      [src('ORDERS'), src('CUSTOMERS')],
    );
    expect(out.sql).toContain('"T1"."REGION" AS "ORDERS_REGION"');
    expect(out.sql).toContain('"T2"."REGION" AS "CUSTOMERS_REGION"');
    expect(out.sql).toContain('"T2"."NAME"\n');
    expect(out.columns.map((c) => c.name)).toEqual([
      'ORDER_ID',
      'ORDERS_REGION',
      'CUSTOMERS_REGION',
      'NAME',
    ]);
    expect(suggestJoinedReportName(ordersCustomers(), out.columns)).toBe(
      'ORDERS + CUSTOMERS: ORDER_ID, ORDERS_REGION, CUSTOMERS_REGION, NAME',
    );
  });

  it('rejects injection attempts in aliases and column names', () => {
    const s = [src('ORDERS'), src('CUSTOMERS')];
    for (const alias of ['T1"; DROP TABLE X; --', 't2', '1A', 'A B', 'TOOLONGALIAS1', 'A"'])
      expect(code(() => buildJoinedReportSql(ordersCustomers({ alias }), s))).toBe('INVALID_ALIAS');
    expect(
      code(() =>
        buildJoinedReportSql(
          ordersCustomers({ columns: [{ table: 'T2', column: 'NAME" FROM QSYS2.SYSTABLES --' }] }),
          s,
        ),
      ),
    ).toBe('UNKNOWN_COLUMN');
    expect(
      code(() =>
        buildJoinedReportSql(
          ordersCustomers({
            joins: [
              {
                schema: 'DEMOLIB',
                table: 'CUSTOMERS',
                type: 'INNER',
                on: on('T1', 'CUSTNO OR 1=1', 'CUSTNO'),
              },
            ],
          }),
          s,
        ),
      ),
    ).toBe('UNKNOWN_COLUMN');
    expect(
      code(() =>
        buildJoinedReportSql(
          ordersCustomers({
            joins: [
              {
                schema: 'DEMOLIB',
                table: 'CUSTOMERS',
                type: 'CROSS' as never,
                on: on('T1', 'CUSTNO'),
              },
            ],
          }),
          s,
        ),
      ),
    ).toBe('INVALID_JOIN_TYPE');
    expect(ALIAS_PATTERN.test('T1')).toBe(true);
  });

  it('rejects invalid ON references, missing conditions and duplicate aliases', () => {
    const s3 = [src('ORDERS'), src('CUSTOMERS'), src('ORDER_LINES')];
    const three = (
      j2: Partial<JoinedReportSpec['joins'] extends (infer J)[] | undefined ? J : never>,
    ) =>
      ordersCustomers({
        joins: [
          { schema: 'DEMOLIB', table: 'CUSTOMERS', type: 'INNER', on: on('T1', 'CUSTNO') },
          {
            schema: 'DEMOLIB',
            table: 'ORDER_LINES',
            type: 'INNER',
            on: on('T1', 'ORDER_ID'),
            ...j2,
          },
        ],
      });
    // references a table added later
    expect(
      code(() =>
        buildJoinedReportSql(
          ordersCustomers({
            joins: [
              {
                schema: 'DEMOLIB',
                table: 'CUSTOMERS',
                type: 'INNER',
                on: on('T3', 'ORDER_ID', 'CUSTNO'),
              },
              { schema: 'DEMOLIB', table: 'ORDER_LINES', type: 'INNER', on: on('T1', 'ORDER_ID') },
            ],
          }),
          s3,
        ),
      ),
    ).toBe('INVALID_JOIN_REFERENCE');
    // references itself
    expect(code(() => buildJoinedReportSql(three({ on: on('T3', 'ORDER_ID') }), s3))).toBe(
      'INVALID_JOIN_REFERENCE',
    );
    // unknown alias
    expect(code(() => buildJoinedReportSql(three({ on: on('NOPE', 'ORDER_ID') }), s3))).toBe(
      'INVALID_JOIN_REFERENCE',
    );
    expect(code(() => buildJoinedReportSql(three({ on: [] }), s3))).toBe('JOIN_WITHOUT_CONDITION');
    expect(code(() => buildJoinedReportSql(three({ alias: 'T1' }), s3))).toBe('DUPLICATE_ALIAS');
    expect(
      code(() =>
        buildJoinedReportSql(three({ on: [...on('T1', 'ORDER_ID'), ...on('T1', 'ORDER_ID')] }), s3),
      ),
    ).toBe('DUPLICATE_CONDITION');
    // a column that belongs to another table
    expect(code(() => buildJoinedReportSql(three({ on: on('T2', 'ORDER_ID') }), s3))).toBe(
      'UNKNOWN_COLUMN',
    );
    // the resolved source must be the table the spec names
    expect(
      code(() => buildJoinedReportSql(ordersCustomers(), [src('ORDERS'), src('INVENTORY')])),
    ).toBe('UNKNOWN_TABLE');
    expect(
      code(() =>
        buildJoinedReportSql(
          ordersCustomers({ columns: [{ table: 'X9', column: 'NAME' }] }),
          s3.slice(0, 2),
        ),
      ),
    ).toBe('UNKNOWN_ALIAS');
  });

  it('rejects numeric-vs-character comparisons and warns on date vs timestamp', () => {
    const s = [src('ORDERS'), src('EMPLOYEES')];
    const spec = (left: string, right: string) => ({
      schema: 'DEMOLIB',
      table: 'ORDERS',
      joins: [
        {
          schema: 'DEMOLIB',
          table: 'EMPLOYEES',
          type: 'INNER' as const,
          on: on('T1', left, right),
        },
      ],
      columns: ['ORDER_ID'],
    });
    expect(code(() => buildJoinedReportSql(spec('ORDER_ID', 'EMP_CODE'), s))).toBe(
      'INCOMPATIBLE_JOIN_TYPES',
    );
    const out = buildJoinedReportSql(spec('ORDER_DATE', 'STAMP'), s);
    expect(out.warnings).toHaveLength(1);
    expect(comparability(src('ORDERS').columns[0], src('ORDERS').columns[3])).toBe('ok');
  });

  it('caps the number of joins at 8', () => {
    const joins = Array.from({ length: 9 }, () => ({
      schema: 'DEMOLIB',
      table: 'CUSTOMERS',
      type: 'INNER' as const,
      on: on('T1', 'CUSTNO'),
    }));
    expect(
      code(() =>
        buildJoinedReportSql(ordersCustomers({ joins }), [
          src('ORDERS'),
          ...joins.map(() => src('CUSTOMERS')),
        ]),
      ),
    ).toBe('TOO_MANY_JOINS');
  });
});

describe('suggestJoinConditions', () => {
  it('uses catalog foreign keys in either direction', () => {
    const child = suggestJoinConditions(
      [{ alias: 'T1', source: src('ORDERS') }],
      src('CUSTOMERS'),
      FKS,
    );
    expect(child).toEqual([
      {
        source: 'foreign-key',
        constraint: 'ORDERS_FK_CUSTOMER',
        label: 'ORDERS_FK_CUSTOMER: T1.CUSTNO = CUSTNO',
        on: on('T1', 'CUSTNO'),
      },
    ]);
    const parent = suggestJoinConditions(
      [
        { alias: 'T1', source: src('ORDERS') },
        { alias: 'T2', source: src('INVENTORY') },
      ],
      src('ORDER_LINES'),
      FKS,
    );
    expect(parent.map((s) => s.constraint)).toEqual([
      'ORDER_LINES_FK_ORDER',
      'ORDER_LINES_FK_ITEM',
    ]);
    expect(parent[1].on).toEqual(on('T2', 'ITEM'));
  });

  it('falls back to same-name columns with comparable types', () => {
    const out = suggestJoinConditions(
      [{ alias: 'T1', source: src('ORDERS') }],
      src('CUSTOMERS'),
      [],
    );
    expect(out.map((s) => s.source)).toEqual(['column-name', 'column-name']);
    expect(out.map((s) => s.on[0].left.column)).toEqual(['CUSTNO', 'REGION']);
  });
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

let app: ReturnType<typeof createApp>['app'];
let executed: string[];
let fkQueries: number;

beforeEach(() => {
  const db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  executed = [];
  fkQueries = 0;
  const script = (sql: string, parameters?: unknown[]): Scripted => {
    const s = sql.toUpperCase();
    const p = (parameters ?? []).map(String);
    if (s.includes('__CONNECT__')) return { columns: [], rows: [] };
    if (s.includes('QSYS2.SYSREFCST')) {
      fkQueries++;
      return {
        columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => col(n, 'VARCHAR', 128)),
        rows: FKS.filter((f) => f.childTable === p[1] || f.parentTable === p[1]).map((f) => [
          f.childSchema,
          f.childTable,
          f.childColumn,
          f.parentSchema,
          f.parentTable,
          f.parentColumn,
          f.constraint,
          f.ordinal,
        ]),
      };
    }
    if (s.includes('QSYS2.SYSTABLES')) {
      const [schema, table] = p.slice(-2);
      return {
        columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'TABLE_TEXT', 'TABLE_OWNER'].map(
          (n) => col(n, 'VARCHAR', 128),
        ),
        rows: schema === 'DEMOLIB' && DEFS[table] ? [['DEMOLIB', table, 'T', null, 'QSECOFR']] : [],
      };
    }
    if (s.includes('QSYS2.SYSCOLUMNS'))
      return {
        columns: ['N', 'T', 'L', 'P', 'S', 'NUL', 'TXT', 'O'].map((n) => col(n, 'VARCHAR', 128)),
        rows: (DEFS[p[1]] ?? []).map(([n, t, pr, sc], i) => [n, t, pr, pr, sc, 'Y', null, i + 1]),
      };
    executed.push(sql);
    return {
      columns: [col('ORDER_ID', 'INTEGER'), col('NAME', 'VARCHAR', 40)],
      rows: Array.from({ length: 5 }, (_, i) => [i + 1, `Customer ${i}`]),
    };
  };
  app = createApp({
    cfg: testConfig(),
    metadataDb: db,
    jobFactory: fakeFactory(script).factory,
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
  return (url: string) => agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
}

describe('POST /api/schema/join-suggestions', () => {
  it('requires authentication', async () => {
    expect(
      (await request(app).post('/api/schema/join-suggestions').set('Origin', ORIGIN)).status,
    ).toBe(401);
  });

  it('suggests the catalog foreign key', async () => {
    const post = await login();
    const res = await post('/api/schema/join-suggestions').send({
      tables: [{ alias: 'T1', schema: 'DEMOLIB', table: 'ORDERS' }],
      schema: 'DEMOLIB',
      table: 'CUSTOMERS',
    });
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0]).toMatchObject({
      source: 'foreign-key',
      on: on('T1', 'CUSTNO'),
    });
    expect(fkQueries).toBe(1);
  });

  it('404s for a table the reporting profile cannot read', async () => {
    const post = await login();
    const res = await post('/api/schema/join-suggestions').send({
      tables: [{ alias: 'T1', schema: 'DEMOLIB', table: 'ORDERS' }],
      schema: 'DEMOLIB',
      table: 'SECRET',
    });
    expect(res.status).toBe(404);
  });
});

describe('joined preview and run', () => {
  const body = {
    schema: 'DEMOLIB',
    table: 'ORDERS',
    joins: [{ schema: 'DEMOLIB', table: 'CUSTOMERS', type: 'LEFT', on: on('T1', 'CUSTNO') }],
    columns: ['ORDER_ID', 'REGION', { table: 'T2', column: 'REGION' }],
    sort: [{ table: 'T2', column: 'NAME', direction: 'ASC' }],
  };

  it('previews the JOIN built on the server', async () => {
    const post = await login();
    const res = await post('/api/schema/sql').send(body);
    expect(res.status).toBe(200);
    expect(res.body.sql).toContain('LEFT OUTER JOIN "DEMOLIB"."CUSTOMERS" AS "T2"');
    expect(res.body.sql).toContain('"T2"."REGION" AS "CUSTOMERS_REGION"');
    expect(res.body.aliases).toEqual(['T1', 'T2']);
    expect(res.body.warnings).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('runs the joined statement with normal paging fields', async () => {
    const post = await login();
    const res = await post('/api/schema/run').send(body);
    expect(res.status).toBe(200);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatch(/^SELECT "T1"\."ORDER_ID"/);
    expect(res.body.rowCount).toBe(5);
    expect(res.body).toHaveProperty('hasMore');
    expect(res.body.builder.sql).toBe(executed[0]);
  });

  it('rejects raw SQL, bad aliases, unknown join tables and missing conditions', async () => {
    const post = await login();
    const bad = async (patch: object, status = 400) => {
      const res = await post('/api/schema/sql').send({ ...body, ...patch });
      expect(res.status).toBe(status);
      return res.body.error.code as string;
    };
    expect(await bad({ sql: 'SELECT * FROM QSYS2.USER_INFO', columns: [] })).toBe(
      'VALIDATION_ERROR',
    );
    expect(await bad({ alias: 'x"y' })).toBe('INVALID_ALIAS');
    expect(await bad({ joins: [{ ...body.joins[0], table: 'SECRET' }] }, 404)).toBe(
      'UNKNOWN_TABLE',
    );
    expect(await bad({ joins: [{ ...body.joins[0], on: [] }] })).toBe('JOIN_WITHOUT_CONDITION');
    expect(executed).toEqual([]);
  });
});
