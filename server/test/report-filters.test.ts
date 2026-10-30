import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  buildJoinedReportSql,
  type JoinedReportSpec,
  type ResolvedSource,
} from '../src/catalog/join-builder.js';
import { MAX_IN_VALUES, parameterTypeFor } from '../src/catalog/filter-builder.js';
import type { CatalogColumn } from '../src/catalog/sql-builder.js';
import {
  countMarkers,
  likePattern,
  parameterListSchema,
  resolveParameters,
} from '../src/reports/parameters.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

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
    ['STAMP', 'TIMESTAMP', null, null],
    ['PHOTO', 'BLOB', 1000, null],
  ],
  CUSTOMERS: [
    ['CUSTNO', 'INTEGER', 10, 0],
    ['NAME', 'VARCHAR', 40, null],
    ['REGION', 'CHAR', 5, null],
  ],
};
const src = (name: string): ResolvedSource => ({
  table: { schema: 'DEMOLIB', name, type: 'T', text: null },
  columns: cols(DEFS[name]),
});
const base = { schema: 'DEMOLIB', table: 'ORDERS', columns: ['ORDER_ID'] };
const build = (patch: Partial<JoinedReportSpec>) =>
  buildJoinedReportSql({ ...base, ...patch } as JoinedReportSpec, [src('ORDERS')]);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'OK';
};

describe('filters (WHERE)', () => {
  it.each([
    ['=', 'AMOUNT', 10, '"T1"."AMOUNT" = ?'],
    ['<>', 'REGION', 'WEST', '"T1"."REGION" <> ?'],
    ['<', 'AMOUNT', 10, '"T1"."AMOUNT" < ?'],
    ['<=', 'AMOUNT', 10, '"T1"."AMOUNT" <= ?'],
    ['>', 'ORDER_DATE', '2026-01-01', '"T1"."ORDER_DATE" > ?'],
    ['>=', 'ORDER_ID', 5, '"T1"."ORDER_ID" >= ?'],
  ])('%s binds its value', (op, column, value, sql) => {
    const b = build({ filters: [{ column, op: op as never, value }] });
    expect(b.sql).toContain(`WHERE ${sql}`);
    expect(b.parameters).toHaveLength(1);
    expect(b.parameters[0]).toMatchObject({ fixed: true, defaultValue: String(value) });
    expect(b.sql).not.toContain(String(value));
  });

  it('builds BETWEEN, IN, LIKE and NULL tests', () => {
    const b = build({
      filters: [
        { column: 'AMOUNT', op: 'BETWEEN', value: 1, value2: 99.5 },
        { column: 'REGION', op: 'IN', values: ['EAST', 'WEST', 'EAST'] },
        { column: 'REGION', op: 'CONTAINS', value: 'AS' },
        { column: 'REGION', op: 'STARTS_WITH', value: 'E' },
        { column: 'REGION', op: 'ENDS_WITH', value: 'T' },
        { column: 'ORDER_DATE', op: 'IS_NULL' },
        { column: 'STAMP', op: 'IS_NOT_NULL' },
      ],
      filterLogic: 'OR',
    });
    expect(b.sql).toContain('"T1"."AMOUNT" BETWEEN ? AND ?');
    expect(b.sql).toContain('"T1"."REGION" IN (?, ?)'); // duplicate dropped
    expect(b.sql).toContain(`"T1"."REGION" LIKE ? ESCAPE '\\'`);
    expect(b.sql).toContain('"T1"."ORDER_DATE" IS NULL');
    expect(b.sql).toContain('"T1"."STAMP" IS NOT NULL');
    expect(b.sql).toContain('\n  OR ');
    expect(countMarkers(b.sql)).toBe(b.parameters.length);
    expect(b.parameters.map((p) => p.match).filter(Boolean)).toEqual([
      'contains',
      'startsWith',
      'endsWith',
    ]);
    const r = resolveParameters(b.sql, b.parameters, {});
    expect(r.bound).toEqual(['1', '99.5', 'EAST', 'WEST', '%AS%', 'E%', '%T']);
  });

  it('supports one level of groups', () => {
    const b = build({
      filters: [
        { column: 'AMOUNT', op: '>', value: 0 },
        {
          logic: 'OR',
          filters: [
            { column: 'REGION', op: '=', value: 'EAST' },
            { column: 'REGION', op: '=', value: 'WEST' },
          ],
        },
      ],
    });
    expect(b.sql).toContain(
      'WHERE "T1"."AMOUNT" > ?\n  AND ("T1"."REGION" = ? OR "T1"."REGION" = ?)',
    );
    expect(
      code(() =>
        build({
          filters: [{ logic: 'OR', filters: [{ logic: 'AND', filters: [] } as never] }],
        }),
      ),
    ).toBe('INVALID_FILTER');
  });

  it('never puts values in the SQL, whatever they contain', () => {
    const evil = ["x' OR '1'='1", '1; DROP TABLE QFMETA.QF_USERS --', '%', '_\\', '"T1"."X"'];
    for (const value of evil) {
      const b = build({ filters: [{ column: 'REGION', op: 'CONTAINS', value }] });
      expect(b.sql).not.toContain(value);
      expect(b.sql.match(/'/g)).toHaveLength(2); // only ESCAPE '\'
    }
    expect(likePattern('50%_a\\b', 'contains')).toBe('%50\\%\\_a\\\\b%');
    // numeric and date filters reject non-numbers instead of binding them
    expect(code(() => build({ filters: [{ column: 'AMOUNT', op: '=', value: '1 OR 1=1' }] }))).toBe(
      'INVALID_FILTER_VALUE',
    );
    expect(
      code(() => build({ filters: [{ column: 'ORDER_DATE', op: '=', value: '2026-02-30' }] })),
    ).toBe('INVALID_FILTER_VALUE');
    expect(code(() => build({ filters: [{ column: 'STAMP', op: '>', value: 'now' }] }))).toBe(
      'INVALID_FILTER_VALUE',
    );
  });

  it('checks operators, columns and types against the catalog', () => {
    expect(code(() => build({ filters: [{ column: 'NOPE', op: '=', value: 1 }] }))).toBe(
      'UNKNOWN_COLUMN',
    );
    expect(
      code(() => build({ filters: [{ column: 'AMOUNT', op: 'OR 1=1' as never, value: 1 }] })),
    ).toBe('INVALID_FILTER_OPERATOR');
    expect(code(() => build({ filters: [{ column: 'AMOUNT', op: 'CONTAINS', value: '1' }] }))).toBe(
      'INVALID_FILTER_OPERATOR',
    );
    expect(code(() => build({ filters: [{ column: 'PHOTO', op: '=', value: 'a' }] }))).toBe(
      'UNSUPPORTED_FILTER_TYPE',
    );
    expect(code(() => build({ filters: [{ column: 'PHOTO', op: 'IS_NULL' }] }))).toBe('OK');
    expect(code(() => build({ filters: [{ table: 'ZZ', column: 'REGION', op: 'IS_NULL' }] }))).toBe(
      'UNKNOWN_ALIAS',
    );
    expect(
      code(() => build({ filters: [{ column: 'AMOUNT', op: '=' }], filterLogic: 'XOR' as never })),
    ).toBe('INVALID_FILTER_LOGIC');
  });

  it('handles nulls: a missing value is an error, IS NULL needs none', () => {
    for (const value of [null, undefined, '', '   '])
      expect(code(() => build({ filters: [{ column: 'REGION', op: '=', value }] }))).toBe(
        'MISSING_FILTER_VALUE',
      );
    expect(code(() => build({ filters: [{ column: 'REGION', op: 'IN', values: [] }] }))).toBe(
      'MISSING_FILTER_VALUE',
    );
    expect(code(() => build({ filters: [{ column: 'AMOUNT', op: 'BETWEEN', value: 1 }] }))).toBe(
      'MISSING_FILTER_VALUE',
    );
    const b = build({ filters: [{ column: 'REGION', op: 'IS_NULL', value: 'ignored' }] });
    expect(b.parameters).toHaveLength(0);
  });

  it('limits IN lists', () => {
    const values = Array.from({ length: MAX_IN_VALUES }, (_, i) => i);
    expect(build({ filters: [{ column: 'ORDER_ID', op: 'IN', values }] }).parameters).toHaveLength(
      MAX_IN_VALUES,
    );
    expect(
      code(() => build({ filters: [{ column: 'ORDER_ID', op: 'IN', values: [...values, 999] }] })),
    ).toBe('TOO_MANY_VALUES');
    // generated (fixed) parameters do not count against the 20 prompt limit
    const b = build({ filters: [{ column: 'ORDER_ID', op: 'IN', values }] });
    expect(parameterListSchema.safeParse(b.parameters).success).toBe(true);
  });

  it('maps column types to parameter types', () => {
    const c = (name: string) => cols(DEFS.ORDERS).find((x) => x.name === name)!;
    expect(parameterTypeFor(c('ORDER_ID'))).toBe('integer');
    expect(parameterTypeFor(c('AMOUNT'))).toBe('decimal');
    expect(parameterTypeFor(c('ORDER_DATE'))).toBe('date');
    expect(parameterTypeFor(c('REGION'))).toBe('string');
    expect(parameterTypeFor(c('PHOTO'))).toBeNull();
  });
});

describe('ask-when-run filters', () => {
  it('become report parameters with defaults; fixed values cannot be overridden', () => {
    const b = build({
      filters: [
        { column: 'REGION', op: '=', value: 'EAST' },
        {
          column: 'ORDER_DATE',
          op: 'BETWEEN',
          ask: {
            name: 'PERIOD',
            label: 'Order date',
            defaultValue: '2026-01-01',
            defaultValue2: '2026-12-31',
          },
        },
        {
          column: 'REGION',
          op: 'STARTS_WITH',
          ask: { name: 'PREFIX', label: 'Region starts with' },
        },
      ],
    });
    const visible = b.parameters.filter((p) => !p.fixed);
    expect(visible.map((p) => [p.name, p.type, p.label])).toEqual([
      ['PERIOD_FROM', 'date', 'Order date (from)'],
      ['PERIOD_TO', 'date', 'Order date (to)'],
      ['PREFIX', 'string', 'Region starts with'],
    ]);
    const r = resolveParameters(b.sql, b.parameters, {
      [b.parameters[0].name]: 'WEST', // fixed: ignored
      PERIOD_TO: '2026-06-30',
      PREFIX: 'W_',
    });
    expect(r.bound).toEqual(['EAST', '2026-01-01', '2026-06-30', 'W\\_%']);
    expect(() => resolveParameters(b.sql, b.parameters, { PERIOD_FROM: 'soon' })).toThrow(/date/);
    expect(() => resolveParameters(b.sql, b.parameters, {})).toThrow(/required/); // PREFIX
  });

  it('validates parameter names and where asking is allowed', () => {
    const ask = (name: string) => ({ name, label: 'x' });
    expect(code(() => build({ filters: [{ column: 'REGION', op: '=', ask: ask('1BAD') }] }))).toBe(
      'INVALID_PARAMETER_NAME',
    );
    expect(code(() => build({ filters: [{ column: 'REGION', op: '=', ask: ask('QF_X') }] }))).toBe(
      'INVALID_PARAMETER_NAME',
    );
    expect(
      code(() =>
        build({
          filters: [
            { column: 'REGION', op: '=', ask: ask('R') },
            { column: 'ORDER_ID', op: '=', ask: ask('r') },
          ],
        }),
      ),
    ).toBe('DUPLICATE_PARAMETER');
    expect(code(() => build({ filters: [{ column: 'REGION', op: 'IN', ask: ask('R') }] }))).toBe(
      'INVALID_FILTER',
    );
    expect(
      code(() =>
        build({
          filters: [{ column: 'AMOUNT', op: '=', ask: { ...ask('A'), defaultValue: 'x' } }],
        }),
      ),
    ).toBe('INVALID_FILTER_VALUE');
    const many = Array.from({ length: 21 }, (_, i) => ({
      column: 'ORDER_ID',
      op: '=' as const,
      ask: ask(`P${i}`),
    }));
    expect(code(() => build({ filters: many }))).toBe('TOO_MANY_PARAMETERS');
  });
});

describe('grouping and totals', () => {
  it('groups by selected columns and adds totals', () => {
    const b = build({
      columns: ['REGION'],
      groupBy: [{ column: 'REGION' }],
      aggregates: [
        { fn: 'COUNT', name: 'Orders' },
        { fn: 'SUM', column: 'AMOUNT', name: 'Total amount' },
        { fn: 'AVG', column: 'AMOUNT' },
        { fn: 'COUNT_DISTINCT', column: 'CUSTNO', name: 'Customers' },
        { fn: 'MIN', column: 'ORDER_DATE', name: 'First' },
        { fn: 'MAX', column: 'REGION', name: 'Last region' },
      ],
      sort: [{ aggregate: 'Total amount', direction: 'DESC' }],
    });
    expect(b.sql).toBe(
      [
        'SELECT "T1"."REGION",',
        '       COUNT(*) AS "Orders",',
        '       SUM("T1"."AMOUNT") AS "Total amount",',
        '       AVG("T1"."AMOUNT") AS "AVG_AMOUNT",',
        '       COUNT(DISTINCT "T1"."CUSTNO") AS "Customers",',
        '       MIN("T1"."ORDER_DATE") AS "First",',
        '       MAX("T1"."REGION") AS "Last region"',
        'FROM "DEMOLIB"."ORDERS" AS "T1"',
        'GROUP BY "T1"."REGION"',
        'ORDER BY SUM("T1"."AMOUNT") DESC',
      ].join('\n'),
    );
    expect(b.columns.map((c) => c.name)).toEqual([
      'REGION',
      'Orders',
      'Total amount',
      'AVG_AMOUNT',
      'Customers',
      'First',
      'Last region',
    ]);
  });

  it('adds selected non-aggregated columns to GROUP BY automatically', () => {
    const b = build({
      columns: ['REGION', 'CUSTNO'],
      groupBy: [{ column: 'REGION' }],
      aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Total' }],
    });
    expect(b.sql).toContain('GROUP BY "T1"."REGION", "T1"."CUSTNO"');
    expect(b.warnings.join()).toMatch(/T1\.CUSTNO was added to GROUP BY/);
    // group-by columns that were not selected are still shown
    const c = build({
      columns: [],
      groupBy: [{ column: 'REGION' }],
      aggregates: [{ fn: 'COUNT' }],
    });
    expect(c.sql.startsWith('SELECT "T1"."REGION",\n       COUNT(*) AS "COUNT_ROWS"')).toBe(true);
    // totals only: no GROUP BY at all
    const d = build({ columns: [], aggregates: [{ fn: 'COUNT' }] });
    expect(d.sql).not.toContain('GROUP BY');
  });

  it('validates aggregates', () => {
    const agg = (a: object) => code(() => build({ aggregates: [a as never] }));
    expect(agg({ fn: 'SUM', column: 'REGION' })).toBe('INVALID_AGGREGATE');
    expect(agg({ fn: 'AVG', column: 'ORDER_DATE' })).toBe('INVALID_AGGREGATE');
    expect(agg({ fn: 'MAX', column: 'PHOTO' })).toBe('INVALID_AGGREGATE');
    expect(agg({ fn: 'SUM' })).toBe('INVALID_AGGREGATE');
    expect(agg({ fn: 'MEDIAN', column: 'AMOUNT' })).toBe('INVALID_AGGREGATE');
    expect(agg({ fn: 'SUM', column: 'AMOUNT', name: 'X" FROM QSYS2.USER_INFO --' })).toBe(
      'INVALID_OUTPUT_NAME',
    );
    expect(agg({ fn: 'SUM', column: 'AMOUNT', name: 'ORDER_ID' })).toBe('DUPLICATE_OUTPUT_NAME');
    expect(agg({ fn: 'SUM', column: 'NOPE' })).toBe('UNKNOWN_COLUMN');
  });

  it('only sorts grouped results by group columns or totals', () => {
    const g = { columns: ['REGION'], aggregates: [{ fn: 'COUNT' as const, name: 'N' }] };
    expect(code(() => build({ ...g, sort: [{ column: 'AMOUNT', direction: 'ASC' }] }))).toBe(
      'INVALID_SORT_COLUMN',
    );
    expect(code(() => build({ ...g, sort: [{ column: 'REGION', direction: 'ASC' }] }))).toBe('OK');
    expect(code(() => build({ ...g, sort: [{ aggregate: 'Nope', direction: 'ASC' }] }))).toBe(
      'UNKNOWN_AGGREGATE',
    );
  });
});

describe('HAVING', () => {
  const g = {
    columns: ['REGION'],
    filters: [{ column: 'AMOUNT', op: '>' as const, value: 0 }],
    aggregates: [
      { fn: 'COUNT' as const, name: 'Orders' },
      { fn: 'SUM' as const, column: 'AMOUNT', name: 'Total' },
    ],
  };
  it('binds values and orders markers WHERE first, then HAVING', () => {
    const b = build({
      ...g,
      having: [
        { aggregate: 'Orders', op: '>=', value: 2 },
        { aggregate: 'total', op: 'BETWEEN', value: '10.5', value2: 1000 },
      ],
    });
    expect(b.sql).toContain('HAVING COUNT(*) >= ?\n   AND SUM("T1"."AMOUNT") BETWEEN ? AND ?');
    expect(resolveParameters(b.sql, b.parameters, {}).bound).toEqual(['0', 2, '10.5', '1000']);
  });
  it('rejects unknown totals, bad values and HAVING without grouping', () => {
    expect(code(() => build({ ...g, having: [{ aggregate: 'X', op: '>', value: 1 }] }))).toBe(
      'UNKNOWN_AGGREGATE',
    );
    expect(
      code(() => build({ ...g, having: [{ aggregate: 'Orders', op: '>', value: '1.5' }] })),
    ).toBe('INVALID_FILTER_VALUE');
    expect(
      code(() => build({ ...g, having: [{ aggregate: 'Orders', op: 'LIKE' as never, value: 1 }] })),
    ).toBe('INVALID_FILTER_OPERATOR');
    expect(code(() => build({ having: [{ aggregate: 'Orders', op: '>', value: 1 }] }))).toBe(
      'INVALID_HAVING',
    );
  });
});

describe('migration 004', () => {
  it('adds a nullable BUILDER_DEF CLOB to QF_REPORTS', () => {
    const m = loadMigrations('QFMETA').find((x) => x.version === 4)!;
    expect(m).toBeDefined();
    const sql = m.statements.join('\n');
    expect(sql).toContain(
      'ALTER TABLE QFMETA.QF_REPORTS ADD COLUMN BUILDER_DEF CLOB(1M) CCSID 1208',
    );
    expect(sql).not.toMatch(/BUILDER_DEF[^\n]*NOT NULL/);
    expect(sql).toContain('LABEL ON COLUMN QFMETA.QF_REPORTS.BUILDER_DEF');
  });
});

// ---------------------------------------------------------------------------
// API: preview, run, save / reopen builder definitions
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
let app: ReturnType<typeof createApp>['app'];
let db: FakeMetadataDb;
let runs: { sql: string; params: unknown[] }[];

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  runs = [];
  const script = (sql: string, parameters?: unknown[]): Scripted => {
    const s = sql.toUpperCase();
    const p = (parameters ?? []).map(String);
    if (s.includes('__CONNECT__')) return { columns: [], rows: [] };
    if (s.includes('QSYS2.SYSREFCST')) return { columns: [], rows: [] };
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
    runs.push({ sql, params: parameters ?? [] });
    return { columns: [col('REGION', 'CHAR', 5)], rows: [['EAST']] };
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
  const w = <T extends request.Test>(t: T) => t.set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return {
    post: (url: string) => w(agent.post(url)),
    put: (url: string) => w(agent.put(url)),
    get: (url: string) => agent.get(url).set('Origin', ORIGIN),
  };
}

const spec = {
  schema: 'DEMOLIB',
  table: 'ORDERS',
  columns: ['REGION'],
  filters: [
    { column: 'AMOUNT', op: '>', value: 5 },
    {
      column: 'ORDER_DATE',
      op: '>=',
      ask: { name: 'SINCE', label: 'Since', defaultValue: '2026-01-01' },
    },
  ],
  aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Total' }],
  having: [{ aggregate: 'Total', op: '>', value: 100 }],
  sort: [{ aggregate: 'Total', direction: 'DESC' }],
};

describe('builder API', () => {
  it('previews filtered, grouped SQL with its parameters', async () => {
    const api = await login();
    const res = await api.post('/api/schema/sql').send(spec);
    expect(res.status).toBe(200);
    expect(res.body.sql).toContain('WHERE "T1"."AMOUNT" > ?');
    expect(res.body.sql).toContain('GROUP BY "T1"."REGION"');
    expect(res.body.parameters.filter((p: { fixed?: boolean }) => !p.fixed)).toEqual([
      expect.objectContaining({ name: 'SINCE', type: 'date', defaultValue: '2026-01-01' }),
    ]);
  });

  it('runs with ask-when-run values bound and fixed values kept', async () => {
    const api = await login();
    const res = await api
      .post('/api/schema/run')
      .send({ ...spec, values: { SINCE: '2026-03-01', QF_F1: '0' } });
    expect(res.status).toBe(200);
    expect(runs.at(-1)!.params).toEqual(['5', '2026-03-01', '100']);
    expect(runs.at(-1)!.sql).not.toContain('2026-03-01');
    const bad = await api.post('/api/schema/run').send({ ...spec, values: { SINCE: "1' OR 1=1" } });
    expect(bad.status).toBe(400);
  });

  it('saves the definition, regenerates SQL, and reopens it', async () => {
    const api = await login();
    const res = await api.post('/api/reports').send({
      name: 'Regional totals',
      sql: 'SELECT * FROM QSYS2.USER_INFO', // ignored: regenerated from the definition
      parameters: [],
      builderDef: { version: 1, spec },
    });
    expect(res.status).toBe(201);
    const report = res.body.report;
    expect(report.sql).toContain('SUM("T1"."AMOUNT") AS "Total"');
    expect(report.sql).not.toContain('USER_INFO');
    expect(report.builderDef).toMatchObject({ version: 1, spec: { table: 'ORDERS' } });
    expect(report.parameters.filter((p: { fixed?: boolean }) => !p.fixed)).toHaveLength(1);
    const stored = db.reports.get(report.id)!;
    expect(JSON.parse(String(stored.BUILDER_DEF)).version).toBe(1);

    const got = await api.get(`/api/reports/${report.id}`);
    expect(got.body.builder).toEqual({ valid: true });

    const run = await api
      .post(`/api/reports/${report.id}/execute`)
      .send({ values: { SINCE: '2026-05-01' } });
    expect(run.status).toBe(200);
    expect(runs.at(-1)!.params).toEqual(['5', '2026-05-01', '100']);

    // update from the builder: SQL follows the new definition
    const upd = await api.put(`/api/reports/${report.id}`).send({
      name: 'Regional totals',
      sql: 'ignored',
      version: report.version,
      builderDef: { version: 1, spec: { ...spec, having: [] } },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.report.sql).not.toContain('HAVING');

    // a description-only edit from the SQL editor keeps the definition
    const keep = await api.put(`/api/reports/${report.id}`).send({
      name: 'Regional totals',
      description: 'Now with a description',
      sql: upd.body.report.sql,
      parameters: upd.body.report.parameters,
      version: upd.body.report.version,
    });
    expect(keep.body.report.builderDef).not.toBeNull();

    // editing the SQL by hand detaches it from the builder
    const detach = await api.put(`/api/reports/${report.id}`).send({
      name: 'Regional totals',
      sql: 'SELECT REGION FROM DEMOLIB.ORDERS',
      parameters: [],
      version: keep.body.report.version,
    });
    expect(detach.body.report.builderDef).toBeNull();
    expect((await api.get(`/api/reports/${report.id}`)).body.builder).toBeUndefined();
  });

  it('rejects tampered definitions', async () => {
    const api = await login();
    const save = (builderDef: unknown) =>
      api.post('/api/reports').send({ name: `R${Math.random()}`, sql: 'x', builderDef });
    expect((await save({ version: 2, spec })).body.error.code).toBe('INVALID_BUILDER_DEF');
    expect((await save({ spec })).body.error.code).toBe('INVALID_BUILDER_DEF');
    expect((await save({ version: 1, spec: { ...spec, table: 'SECRET' } })).status).toBe(404);
    expect(
      (await save({ version: 1, spec: { ...spec, columns: ['REGION" FROM QSYS2.USER_INFO --'] } }))
        .body.error.code,
    ).toBe('UNKNOWN_COLUMN');
    expect(
      (
        await save({
          version: 1,
          spec: { ...spec, filters: [{ column: 'AMOUNT', op: '; DROP', value: 1 }] },
        })
      ).body.error.code,
    ).toBe('INVALID_BUILDER_DEF');
    expect(db.reports.size).toBe(0);
  });

  it('flags a stored definition that no longer matches the catalog', async () => {
    const api = await login();
    const res = await api
      .post('/api/reports')
      .send({ name: 'Regional totals', sql: 'x', builderDef: { version: 1, spec } });
    const stored = db.reports.get(res.body.report.id)!;
    stored.BUILDER_DEF = JSON.stringify({ version: 1, spec: { ...spec, columns: ['GONE'] } });
    const got = await api.get(`/api/reports/${res.body.report.id}`);
    expect(got.body.builder.valid).toBe(false);
    expect(got.body.builder.error).toMatch(/GONE/);
    // the stored, server-generated SQL still runs
    const run = await api.post(`/api/reports/${res.body.report.id}/execute`).send({});
    expect(run.status).toBe(200);
  });

  it('keeps SQL-only reports unchanged', async () => {
    const api = await login();
    const res = await api
      .post('/api/reports')
      .send({ name: 'Plain', sql: 'SELECT REGION FROM DEMOLIB.ORDERS', parameters: [] });
    expect(res.status).toBe(201);
    expect(res.body.report.builderDef).toBeNull();
    expect(db.reports.get(res.body.report.id)!.BUILDER_DEF).toBeNull();
    expect((await api.get(`/api/reports/${res.body.report.id}`)).body.builder).toBeUndefined();
  });
});
