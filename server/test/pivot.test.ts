import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  buildJoinedReportSql,
  type JoinedReportSpec,
  type ResolvedSource,
} from '../src/catalog/join-builder.js';
import type { CatalogColumn } from '../src/catalog/sql-builder.js';
import { deriveDetailSpec, groupFields } from '../src/reports/drill.js';
import {
  MAX_PIVOT_COLUMNS,
  NULL_LABEL,
  expandPivot,
  pivotRows,
  pivotTable,
  type PivotSpec,
} from '../src/reports/pivot.js';
import type { Cell, ResultColumn } from '../src/sql/results.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ColDef = [string, string, number | null, number | null];
const DEFS: Record<string, ColDef[]> = {
  ORDER_LINES: [
    ['LINE_ID', 'INTEGER', 10, 0],
    ['ORDER_ID', 'INTEGER', 10, 0],
    ['ITEM', 'CHAR', 8, null],
    ['QTY', 'INTEGER', 10, 0],
    ['UNITPRICE', 'DECIMAL', 9, 2],
  ],
  ORDERS: [
    ['ORDER_ID', 'INTEGER', 10, 0],
    ['REGION', 'CHAR', 5, null],
    ['ORDER_DATE', 'DATE', null, null],
  ],
};
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
const src = (name: string): ResolvedSource => ({
  table: { schema: 'DEMOLIB', name, type: 'T', text: null },
  columns: cols(DEFS[name]),
});
const JOIN = {
  schema: 'DEMOLIB',
  table: 'ORDERS',
  alias: 'O',
  type: 'INNER' as const,
  on: [{ left: { table: 'T1', column: 'ORDER_ID' }, right: { column: 'ORDER_ID' } }],
};
const pivot: PivotSpec = {
  rows: [{ column: 'ITEM' }],
  column: { table: 'O', column: 'REGION' },
  value: { fn: 'SUM', column: 'UNITPRICE' },
};
const spec = {
  schema: 'DEMOLIB',
  table: 'ORDER_LINES',
  joins: [JOIN],
  columns: [],
  filters: [{ table: 'O', column: 'ORDER_DATE', op: '>=' as const, value: '2026-01-01' }],
};

const rc = (name: string, kind: ResultColumn['kind'], scale = 0): ResultColumn => ({
  key: name,
  name,
  label: name,
  type: kind === 'decimal' ? 'DECIMAL' : kind === 'integer' ? 'INTEGER' : 'CHAR',
  kind,
  precision: 15,
  scale,
  nullable: true,
});

// ---------------------------------------------------------------------------
// Expansion to grouped SQL
// ---------------------------------------------------------------------------

describe('pivot expansion', () => {
  it('builds ordinary GROUP BY SQL with bound filters and no dynamic columns', () => {
    const exp = expandPivot({ ...spec, pivot } as JoinedReportSpec & { pivot: PivotSpec });
    const built = buildJoinedReportSql(exp, [src('ORDER_LINES'), src('ORDERS')]);
    expect(built.sql).toContain('GROUP BY "T1"."ITEM", "O"."REGION"');
    expect(built.sql).toContain('SUM("T1"."UNITPRICE") AS "PIVOT_VALUE"');
    expect(built.sql).toContain('ORDER BY "T1"."ITEM" ASC, "O"."REGION" ASC');
    expect(built.sql).toContain('"O"."ORDER_DATE" >= ?');
    expect(built.sql).not.toContain('2026-01-01');
    expect(built.sql).not.toMatch(/CASE|PIVOT\s*\(/);
    expect(built.columns.map((c) => c.name)).toEqual(['ITEM', 'REGION', 'PIVOT_VALUE']);
  });

  it('adds hidden SUM and COUNT for AVG so totals are exact', () => {
    const exp = expandPivot({
      ...spec,
      pivot: { ...pivot, value: { fn: 'AVG', column: 'QTY' } },
    } as JoinedReportSpec & { pivot: PivotSpec });
    expect(exp.aggregates!.map((a) => `${a.fn}:${a.name}`)).toEqual([
      'AVG:PIVOT_VALUE',
      'SUM:PIVOT_SUM',
      'COUNT:PIVOT_COUNT',
    ]);
  });

  it('works on calculated fields in every position', () => {
    const calculated = [
      { id: 'c1', name: 'Line value', expression: 'UNITPRICE * QTY' },
      { id: 'c2', name: 'Item group', expression: 'SUBSTR(ITEM, 1, 2)' },
      { id: 'c3', name: 'Year', expression: 'YEAR(O.ORDER_DATE)' },
    ];
    const exp = expandPivot({
      ...spec,
      calculated,
      pivot: {
        rows: [{ table: '@CALC', column: 'c2' }],
        column: { table: '@CALC', column: 'c3' },
        value: { fn: 'SUM', table: '@CALC', column: 'c1' },
      },
    } as unknown as JoinedReportSpec & { pivot: PivotSpec });
    const built = buildJoinedReportSql(exp, [src('ORDER_LINES'), src('ORDERS')]);
    expect(built.sql).toMatch(
      /SUM\(\(\("T1"\."UNITPRICE"\) \* \("T1"\."QTY"\)\)\) AS "PIVOT_VALUE"/,
    );
    expect(built.columns.map((c) => c.name)).toEqual(['Item group', 'Year', 'PIVOT_VALUE']);
  });

  it('rejects conflicting or invalid definitions', () => {
    const go =
      (extra: object, p: object = pivot) =>
      () =>
        expandPivot({ ...spec, ...extra, pivot: p } as JoinedReportSpec & { pivot: PivotSpec });
    expect(go({ columns: ['ITEM'] })).toThrow(/PIVOT|remove the selected/);
    expect(go({ aggregates: [{ fn: 'COUNT' }] })).toThrow(/remove/);
    expect(go({}, { ...pivot, rows: [] })).toThrow(/between 1 and 5/);
    expect(go({}, { ...pivot, rows: [{ table: 'O', column: 'REGION' }] })).toThrow(
      /cannot also be a row field/,
    );
    expect(go({}, { ...pivot, value: { fn: 'SUM' } })).toThrow(/needs a value field/);
    expect(go({}, { ...pivot, value: { fn: 'MEDIAN', column: 'QTY' } })).toThrow(/SUM, COUNT/);
  });

  it('drills from a cell on the row and column fields; {} is the grand total', () => {
    const exp = expandPivot({ ...spec, pivot } as JoinedReportSpec & { pivot: PivotSpec });
    const built = buildJoinedReportSql(exp, [src('ORDER_LINES'), src('ORDERS')]);
    const fields = groupFields(exp, built.columns);
    expect(fields.map((f) => f.name)).toEqual(['ITEM', 'REGION']);
    const cell = deriveDetailSpec(exp, fields, { ITEM: 'BOLT', REGION: null }, [
      { column: 'LINE_ID' },
    ]);
    const detail = buildJoinedReportSql(cell.spec as JoinedReportSpec, [
      src('ORDER_LINES'),
      src('ORDERS'),
    ]);
    expect(detail.sql).toContain('"T1"."ITEM" = ?');
    expect(detail.sql).toContain('"O"."REGION" IS NULL');
    expect(detail.sql).not.toContain('GROUP BY');
    const all = deriveDetailSpec(exp, fields, {}, [{ column: 'LINE_ID' }]);
    expect(all.applied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Server-side pivoting and totals
// ---------------------------------------------------------------------------

describe('pivotRows', () => {
  const C = [rc('ITEM', 'text'), rc('REGION', 'text'), rc('PIVOT_VALUE', 'decimal', 2)];

  it('spreads groups into columns with row, column and grand totals', () => {
    const p = pivotRows(
      C,
      [
        ['BOLT', 'EAST', '0.10'],
        ['BOLT', 'WEST', '0.20'],
        ['NUT', 'EAST', '1.05'],
        ['NUT', null, '2.00'],
      ],
      1,
      'SUM',
      'Sum of UNITPRICE',
    );
    expect(p.columns.map((c) => c.label)).toEqual(['EAST', 'WEST', NULL_LABEL]);
    expect(p.columns.at(-1)!.value).toBeNull();
    expect(p.rows.map((r) => r.labels[0])).toEqual(['BOLT', 'NUT']);
    expect(p.rows[0].cells).toEqual(['0.10', '0.20', null]);
    expect(p.rows[0].present).toEqual([true, true, false]);
    // exact decimal arithmetic (0.1 + 0.2 is not 0.30000000000000004)
    expect(p.rows[0].total).toBe('0.30');
    expect(p.rows[1].total).toBe('3.05');
    expect(p.columnTotals).toEqual(['1.15', '0.20', '2.00']);
    expect(p.grandTotal).toBe('3.35');
    expect(p.exact).toBe(true);
    expect(p.long.columns.map((c) => c.name)).toEqual(['ITEM', 'REGION', 'PIVOT_VALUE']);
  });

  it('keeps JS numbers as numbers and sorts numeric column values numerically', () => {
    const p = pivotRows(
      [rc('ITEM', 'text'), rc('YEAR', 'integer'), rc('PIVOT_VALUE', 'integer')],
      [
        ['A', 10, 1],
        ['A', 9, 2],
        ['B', 100, 3],
      ],
      1,
      'COUNT',
      'Count of rows',
    );
    expect(p.columns.map((c) => c.value)).toEqual([9, 10, 100]);
    expect(p.rows[0].total).toBe(3);
    expect(p.grandTotal).toBe(6);
  });

  it('computes AVG totals from the hidden SUM and COUNT, not by averaging averages', () => {
    const p = pivotRows(
      [
        ...C.slice(0, 2),
        rc('PIVOT_VALUE', 'decimal', 2),
        rc('S', 'decimal', 2),
        rc('N', 'integer'),
      ],
      [
        ['A', 'E', '10.00', '10.00', 1],
        ['A', 'W', '2.00', '6.00', 3],
      ],
      1,
      'AVG',
      'Average of X',
    );
    expect(p.rows[0].total).toBe('4.00'); // 16 / 4, not (10 + 2) / 2
    expect(p.long.columns).toHaveLength(3); // hidden columns are not charted
  });

  it('takes MIN and MAX across cells', () => {
    const rows: Cell[][] = [
      ['A', 'E', '5.00'],
      ['A', 'W', '-1.50'],
      ['B', 'E', '7.25'],
    ];
    expect(pivotRows(C, rows, 1, 'MIN', 'Min').grandTotal).toBe('-1.50');
    expect(pivotRows(C, rows, 1, 'MAX', 'Max').columnTotals).toEqual(['7.25', '-1.50']);
  });

  it('supports several row fields', () => {
    const p = pivotRows(
      [rc('A', 'text'), rc('B', 'text'), rc('R', 'text'), rc('PIVOT_VALUE', 'integer')],
      [
        ['x', '1', 'E', 1],
        ['x', '2', 'E', 2],
        ['y', '1', 'W', 3],
      ],
      2,
      'SUM',
      'Sum',
    );
    expect(p.rowFields.map((f) => f.name)).toEqual(['A', 'B']);
    expect(p.rows.map((r) => r.keys)).toEqual([
      ['x', '1'],
      ['x', '2'],
      ['y', '1'],
    ]);
    const t = pivotTable(p);
    expect(t.columns.map((c) => c.label)).toEqual(['A', 'B', 'E', 'W', 'Total']);
    expect(t.rows.at(-1)).toEqual(['Total', null, 3, 3, 6]);
  });

  it('caps distinct column values with a message suggesting a filter', () => {
    const rows = Array.from({ length: MAX_PIVOT_COLUMNS + 1 }, (_, i) => ['A', `R${i}`, '1.00']);
    expect(() => pivotRows(C, rows, 1, 'SUM', 'Sum')).toThrow(
      /REGION has more than 50 distinct values.*Add a filter on REGION/,
    );
    expect(() => pivotRows(C, rows.slice(0, MAX_PIVOT_COLUMNS), 1, 'SUM', 'Sum')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
let app: ReturnType<typeof createApp>['app'];
let db: FakeMetadataDb;
let runs: { sql: string; params: unknown[] }[];
let grouped: Scripted;

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  runs = [];
  grouped = {
    columns: [
      col('ITEM', 'CHAR', 8),
      col('REGION', 'CHAR', 5),
      col('PIVOT_VALUE', 'DECIMAL', 15, 2),
    ],
    rows: [
      ['BOLT', 'EAST', '1.10'],
      ['BOLT', null, '2.20'],
      ['NUT', 'EAST', '3.30'],
    ],
  };
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
    if (s.includes('GROUP BY')) return grouped;
    return { columns: [col('LINE_ID', 'INTEGER')], rows: [[1]] };
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
    get: (url: string) => agent.get(url).set('Origin', ORIGIN),
  };
}

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

const apiSpec = { ...spec, pivot };

describe('pivot API', () => {
  it('runs the server-built grouped SQL and returns the grid with totals', async () => {
    const api = await login();
    const res = await api.post('/api/schema/pivot').send(apiSpec);
    expect(res.status).toBe(200);
    expect(runs.at(-1)!.sql).toContain('GROUP BY');
    expect(runs.at(-1)!.params).toEqual(['2026-01-01']);
    expect(res.body.pivot.columns.map((c: { label: string }) => c.label)).toEqual([
      'EAST',
      '(null)',
    ]);
    expect(res.body.pivot.rows[0]).toMatchObject({ labels: ['BOLT'], total: '3.30' });
    expect(res.body.pivot.grandTotal).toBe('6.60');
    expect(res.body.pivot.value.label).toBe('Sum of UNITPRICE');
    // SQL from the browser is ignored; only the definition is used
    await api.post('/api/schema/pivot').send({ ...apiSpec, sql: 'DELETE FROM X' });
    expect(runs.at(-1)!.sql).not.toContain('DELETE');
  });

  it('rejects too many distinct column values with a clear message', async () => {
    grouped = {
      ...grouped,
      rows: Array.from({ length: 60 }, (_, i) => ['BOLT', `R${i}`, '1.00']),
    };
    const api = await login();
    const res = await api.post('/api/schema/pivot').send(apiSpec);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PIVOT_TOO_MANY_COLUMNS');
    expect(res.body.error.message).toMatch(/Add a filter on REGION/);
  });

  it('rejects a pivot combined with columns or totals', async () => {
    const api = await login();
    const res = await api
      .post('/api/schema/pivot')
      .send({ ...apiSpec, aggregates: [{ fn: 'COUNT' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PIVOT_CONFLICT');
    expect(
      (await api.post('/api/schema/pivot').send({ ...spec, columns: ['ITEM'] })).body.error.code,
    ).toBe('NOT_PIVOT');
  });

  it('stores pivots as version 3; version 1 and 2 cannot carry one', async () => {
    const api = await login();
    const res = await api
      .post('/api/reports')
      .send({ name: 'Pivot', sql: 'x', builderDef: { version: 3, spec: apiSpec } });
    expect(res.status).toBe(201);
    const stored = JSON.parse(String(db.reports.get(res.body.report.id)!.BUILDER_DEF));
    expect(stored.version).toBe(3);
    expect(stored.spec.pivot).toEqual(pivot);
    // the saved SQL is the ordinary grouped query, so plain runs and schedules still work
    expect(res.body.report.sql).toContain('GROUP BY');
    for (const version of [1, 2]) {
      const bad = await api
        .post('/api/reports')
        .send({ name: 'Old', sql: 'x', builderDef: { version, spec: apiSpec } });
      expect(bad.body.error.code).toBe('INVALID_BUILDER_DEF');
      expect(bad.body.error.message).toMatch(/version 3/);
    }
    const v1 = { version: 1, spec: { schema: 'DEMOLIB', table: 'ORDER_LINES', columns: ['ITEM'] } };
    const old = await api.post('/api/reports').send({ name: 'Old', sql: 'x', builderDef: v1 });
    expect(JSON.parse(String(db.reports.get(old.body.report.id)!.BUILDER_DEF))).toEqual(v1);
  });

  it('runs, drills and exports a saved pivot', async () => {
    const api = await login();
    const id = (
      await api
        .post('/api/reports')
        .send({ name: 'Pivot', sql: 'x', builderDef: { version: 3, spec: apiSpec } })
    ).body.report.id;
    const run = await api.post(`/api/reports/${id}/pivot`).send({});
    expect(run.status).toBe(200);
    expect(run.body.pivot.grandTotal).toBe('6.60');
    const info = await api.get(`/api/reports/${id}`);
    expect(info.body.drill.builder.fields).toEqual(['ITEM', 'REGION']);
    const drill = await api
      .post(`/api/reports/${id}/drill`)
      .send({ keys: { ITEM: 'BOLT', REGION: null } });
    expect(drill.status).toBe(200);
    expect(runs.at(-1)!.sql).toContain('"O"."REGION" IS NULL');
    expect(runs.at(-1)!.sql).not.toContain('GROUP BY');
    const total = await api.post(`/api/reports/${id}/drill`).send({ keys: {} });
    expect(total.status).toBe(200);

    const x = await binary(api.post(`/api/reports/${id}/pivot/export`).send({}));
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as unknown as ArrayBuffer);
    const s = wb.worksheets[0];
    const row = (n: number) => (s.getRow(n).values as unknown[]).slice(1);
    expect(row(1)).toEqual(['ITEM', 'EAST', '(null)', 'Total']);
    expect(row(2)).toEqual(['BOLT', 1.1, 2.2, 3.3]);
    expect(row(4)).toEqual(['Total', 4.4, 2.2, 6.6]);
    s.eachRow((r) => r.eachCell((c) => expect(c.formula).toBeUndefined()));
  });
});
