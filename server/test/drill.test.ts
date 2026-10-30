import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  buildJoinedReportSql,
  type JoinedReportSpec,
  type ResolvedSource,
} from '../src/catalog/join-builder.js';
import type { CatalogColumn } from '../src/catalog/sql-builder.js';
import {
  defaultDetailColumns,
  deriveDetailSpec,
  drillLabel,
  groupFields,
  mapTargetValues,
  parsePresentation,
  presentationJson,
  type DrillDef,
} from '../src/reports/drill.js';
import { resolveParameters } from '../src/reports/parameters.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

type ColDef = [string, string, number | null, number | null];
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

/** Build the grouped report, derive the drill, and build the detail. */
function drill(spec: JoinedReportSpec, keys: Record<string, string | number | null>) {
  const sources = [src('ORDERS'), ...(spec.joins ?? []).map((j) => src(j.table))];
  const grouped = buildJoinedReportSql(spec, sources);
  const fields = groupFields(spec, grouped.columns);
  const columns = defaultDetailColumns(spec, grouped.aliases, sources, fields);
  const d = deriveDetailSpec(spec, fields, keys, columns);
  return { fields, columns, ...d, built: buildJoinedReportSql(d.spec, sources) };
}

const byRegion: JoinedReportSpec = {
  schema: 'DEMOLIB',
  table: 'ORDERS',
  columns: ['REGION'],
  groupBy: [{ column: 'REGION' }],
  aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Revenue' }],
  having: [{ aggregate: 'Revenue', op: '>', value: 10 }],
  sort: [{ aggregate: 'Revenue', direction: 'DESC' }],
};

describe('derived detail query', () => {
  it('adds one bound equality filter and drops grouping, totals and HAVING', () => {
    const r = drill(byRegion, { REGION: 'WEST' });
    expect(r.fields.map((f) => f.name)).toEqual(['REGION']);
    expect(r.built.sql).toContain('WHERE "T1"."REGION" = ?');
    expect(r.built.sql).not.toMatch(/GROUP BY|HAVING|SUM\(/);
    expect(r.built.sql).not.toContain('WEST');
    expect(resolveParameters(r.built.sql, r.built.parameters, {}).bound).toEqual(['WEST']);
    // group field, the total's column, then base-table columns
    expect(r.columns.slice(0, 2)).toEqual([
      { table: 'T1', column: 'REGION' },
      { table: 'T1', column: 'AMOUNT' },
    ]);
    expect(r.columns.map((c) => c.column)).toEqual(
      expect.arrayContaining(['ORDER_ID', 'ORDER_DATE']),
    );
    expect(drillLabel(r.applied)).toBe('WEST');
  });

  it('handles two group fields and keeps column sorts', () => {
    const spec: JoinedReportSpec = {
      ...byRegion,
      columns: ['REGION', 'ORDER_DATE'],
      groupBy: [{ column: 'REGION' }, { column: 'ORDER_DATE' }],
      sort: [
        { column: 'ORDER_DATE', direction: 'ASC' },
        { aggregate: 'Revenue', direction: 'DESC' },
      ],
    };
    const r = drill(spec, { REGION: 'EAST', ORDER_DATE: '2026-01-02' });
    expect(r.built.sql).toContain('"T1"."REGION" = ?\n  AND "T1"."ORDER_DATE" = ?');
    expect(r.built.sql).toContain('ORDER BY "T1"."ORDER_DATE" ASC');
    expect(resolveParameters(r.built.sql, r.built.parameters, {}).bound).toEqual([
      'EAST',
      '2026-01-02',
    ]);
    expect(drillLabel(r.applied)).toBe('EAST / 2026-01-02');
    // a chart click on only one of the fields is allowed too
    expect(drill(spec, { REGION: 'EAST' }).built.sql).not.toContain('ORDER_DATE" = ?');
  });

  it('turns a NULL group value into IS NULL', () => {
    const r = drill(byRegion, { REGION: null });
    expect(r.built.sql).toContain('WHERE "T1"."REGION" IS NULL');
    expect(r.built.parameters).toHaveLength(0);
    expect(drillLabel(r.applied)).toBe('(empty)');
  });

  it('preserves joins, filters and ask-when-run parameters', () => {
    const spec: JoinedReportSpec = {
      schema: 'DEMOLIB',
      table: 'ORDERS',
      alias: 'O',
      joins: [
        {
          schema: 'DEMOLIB',
          table: 'CUSTOMERS',
          alias: 'C',
          type: 'LEFT',
          on: [{ left: { table: 'O', column: 'CUSTNO' }, right: { column: 'CUSTNO' } }],
        },
      ],
      columns: [{ table: 'C', column: 'NAME' }],
      groupBy: [{ table: 'C', column: 'NAME' }],
      filters: [
        { table: 'O', column: 'AMOUNT', op: '>', value: 5 },
        {
          table: 'O',
          column: 'ORDER_DATE',
          op: '>=',
          ask: { name: 'SINCE', label: 'Since', defaultValue: '2026-01-01' },
        },
      ],
      aggregates: [{ fn: 'COUNT', name: 'Orders' }],
    };
    const r = drill(spec, { NAME: 'Acme' });
    expect(r.built.sql).toContain('LEFT OUTER JOIN "DEMOLIB"."CUSTOMERS" AS "C"');
    expect(r.built.sql).toContain(
      'WHERE "O"."AMOUNT" > ?\n  AND "O"."ORDER_DATE" >= ?\n  AND "C"."NAME" = ?',
    );
    const ask = r.built.parameters.filter((p) => !p.fixed);
    expect(ask).toEqual([expect.objectContaining({ name: 'SINCE' })]);
    expect(
      resolveParameters(r.built.sql, r.built.parameters, { SINCE: '2026-05-01' }).bound,
    ).toEqual(['5', '2026-05-01', 'Acme']);
  });

  it('wraps top-level OR filters so the drill still narrows the rows', () => {
    const r = drill(
      {
        ...byRegion,
        filters: [
          { column: 'AMOUNT', op: '>', value: 100 },
          { column: 'ORDER_ID', op: '<', value: 3 },
        ],
        filterLogic: 'OR',
      },
      { REGION: 'WEST' },
    );
    expect(r.built.sql).toContain(
      'WHERE ("T1"."AMOUNT" > ? OR "T1"."ORDER_ID" < ?)\n  AND "T1"."REGION" = ?',
    );
  });

  it('rejects fields that are not group fields, and bad values', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { code: string }).code;
      }
      return 'OK';
    };
    expect(code(() => drill(byRegion, { AMOUNT: 1 }))).toBe('INVALID_DRILL_FIELD');
    expect(code(() => drill(byRegion, { Revenue: 1 }))).toBe('INVALID_DRILL_FIELD');
    expect(code(() => drill(byRegion, { REGION: 'x'.repeat(10) }))).toBe('OK'); // bound, not inlined
    expect(code(() => drill(byRegion, { REGION: { a: 1 } as never }))).toBe('INVALID_DRILL_VALUE');
    expect(code(() => drill(byRegion, { REGION: Number.NaN }))).toBe('INVALID_DRILL_VALUE');
    const plain = { schema: 'DEMOLIB', table: 'ORDERS', columns: ['REGION'] } as JoinedReportSpec;
    expect(code(() => drill(plain, {}))).toBe('NOT_DRILLABLE');
  });
});

describe('drill settings storage (CHART_DEF envelope)', () => {
  const chart = { version: 1 as const, type: 'bar' as const, x: 'REGION', y: ['Revenue'] };
  const target: DrillDef = {
    version: 1,
    targetReportId: '00000000-0000-4000-8000-000000000001',
    mapping: [{ field: 'REGION', parameter: 'REGION' }],
  };
  it('reads version 1 charts unchanged and round-trips the version 2 envelope', () => {
    expect(parsePresentation(JSON.stringify(chart))).toEqual({ chart, drill: null });
    expect(presentationJson(chart, null)).toBe(JSON.stringify(chart));
    const env = presentationJson(chart, target)!;
    expect(JSON.parse(env).version).toBe(2);
    expect(parsePresentation(env)).toEqual({ chart, drill: target });
    expect(parsePresentation(presentationJson(null, target))).toEqual({
      chart: null,
      drill: target,
    });
  });
  it('disables tampered drill settings without losing the chart', () => {
    const p = parsePresentation(
      JSON.stringify({ version: 2, chart, drill: { version: 1, targetReportId: 'x' } }),
    );
    expect(p.chart).toEqual(chart);
    expect(p.drill).toBeNull();
    expect(p.drillError).toMatch(/invalid/);
  });
  it('maps clicked fields to target parameters', () => {
    expect(mapTargetValues(target, { REGION: 'WEST' }, [{ name: 'REGION' }])).toEqual({
      REGION: 'WEST',
    });
    expect(() => mapTargetValues(target, { OTHER: 1 }, [{ name: 'REGION' }])).toThrow(/not mapped/);
    expect(() => mapTargetValues(target, { REGION: 'W' }, [{ name: 'X' }])).toThrow(
      /no longer has/,
    );
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

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
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
    return { columns: [col('REGION', 'CHAR', 5)], rows: [['WEST']] };
  };
  app = createApp({
    cfg: testConfig(),
    metadataDb: db,
    jobFactory: fakeFactory(script).factory,
  }).app;
});

async function login(username = 'alice') {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const w = <T extends request.Test>(t: T) => t.set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return {
    post: (url: string) => w(agent.post(url)),
    put: (url: string) => w(agent.put(url)),
    get: (url: string) => agent.get(url).set('Origin', ORIGIN),
  };
}

const groupedSpec = {
  schema: 'DEMOLIB',
  table: 'ORDERS',
  columns: ['REGION'],
  groupBy: [{ column: 'REGION' }],
  filters: [
    {
      column: 'ORDER_DATE',
      op: '>=',
      ask: { name: 'SINCE', label: 'Since', defaultValue: '2026-01-01' },
    },
  ],
  aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Revenue' }],
};

async function saveBuilderReport(api: Awaited<ReturnType<typeof login>>, name = 'By region') {
  const res = await api.post('/api/reports').send({
    name,
    sql: 'x',
    parameters: [],
    builderDef: { version: 1, spec: groupedSpec },
  });
  expect(res.status).toBe(201);
  return res.body.report as { id: string };
}

describe('drill API', () => {
  it('reports drill fields, runs the derived query with bound values', async () => {
    const api = await login();
    const rep = await saveBuilderReport(api);
    const info = await api.get(`/api/reports/${rep.id}`);
    expect(info.body.drill).toEqual({
      builder: { fields: ['REGION'] },
      target: null,
      targetUnavailable: false,
    });
    const res = await api
      .post(`/api/reports/${rep.id}/drill`)
      .send({ keys: { REGION: 'WEST' }, values: { SINCE: '2026-02-01' } });
    expect(res.status).toBe(200);
    expect(runs.at(-1)!.sql).toContain('WHERE "T1"."ORDER_DATE" >= ?\n  AND "T1"."REGION" = ?');
    expect(runs.at(-1)!.sql).not.toContain('GROUP BY');
    expect(runs.at(-1)!.params).toEqual(['2026-02-01', 'WEST']);
    expect(res.body.drill).toMatchObject({
      mode: 'builder',
      label: 'WEST',
      sourceName: 'By region',
    });
    expect(res.body.drill.available.length).toBe(DEFS.ORDERS.length);

    const picked = await api
      .post(`/api/reports/${rep.id}/drill`)
      .send({ keys: { REGION: null }, columns: [{ column: 'ORDER_ID' }] });
    expect(picked.status).toBe(200);
    expect(runs.at(-1)!.sql).toMatch(/^SELECT "T1"."ORDER_ID"\n/);
    expect(runs.at(-1)!.sql).toContain('"T1"."REGION" IS NULL');
  });

  it('rejects tampered fields, values, SQL and columns', async () => {
    const api = await login();
    const rep = await saveBuilderReport(api);
    const n = runs.length;
    const send = (body: unknown) => api.post(`/api/reports/${rep.id}/drill`).send(body as object);
    expect((await send({ keys: { AMOUNT: 1 } })).body.error.code).toBe('INVALID_DRILL_FIELD');
    expect((await send({ keys: { 'REGION" OR 1=1 --': 'x' } })).status).toBe(400);
    expect((await send({ keys: { REGION: { $: 1 } } })).status).toBe(400);
    expect((await send({ keys: { REGION: 'W' }, sql: 'DELETE FROM X' })).status).toBe(400);
    expect((await send({ keys: {}, columns: [{ column: 'NOPE' }] })).status).toBe(400);
    expect((await send({ keys: { REGION: 'W' }, mode: 'target' })).body.error.code).toBe(
      'NO_DRILL_TARGET',
    );
    expect(runs.length).toBe(n);
  });

  it('hides builder drill for SQL-only reports', async () => {
    const api = await login();
    const res = await api
      .post('/api/reports')
      .send({ name: 'Raw', sql: 'SELECT REGION FROM DEMOLIB.ORDERS', parameters: [] });
    const id = res.body.report.id;
    expect((await api.get(`/api/reports/${id}`)).body.drill).toEqual({
      builder: null,
      target: null,
      targetUnavailable: false,
    });
    const d = await api.post(`/api/reports/${id}/drill`).send({ keys: { REGION: 'W' } });
    expect(d.body.error.code).toBe('NOT_DRILLABLE');
  });

  it('drills to a configured target with mapped parameters and re-checks access', async () => {
    const alice = await login();
    const source = (
      await alice.post('/api/reports').send({
        name: 'Raw totals',
        sql: 'SELECT REGION, SUM(AMOUNT) FROM DEMOLIB.ORDERS GROUP BY REGION',
        parameters: [],
      })
    ).body.report;
    const target = (
      await alice.post('/api/reports').send({
        name: 'Orders in region',
        sql: 'SELECT * FROM DEMOLIB.ORDERS WHERE REGION = ?',
        parameters: [{ name: 'REGION', label: 'Region', type: 'string', required: true }],
      })
    ).body.report;

    const list = await alice.get(`/api/reports/${source.id}/drill-targets`);
    expect(list.body.targets).toEqual([
      {
        id: target.id,
        name: 'Orders in region',
        parameters: [expect.objectContaining({ name: 'REGION' })],
      },
    ]);
    const def = {
      version: 1,
      targetReportId: target.id,
      mapping: [{ field: 'REGION', parameter: 'REGION' }],
    };
    const badParam = await alice
      .put(`/api/reports/${source.id}/drill`)
      .send({ drillDef: { ...def, mapping: [{ field: 'REGION', parameter: 'NOPE' }] } });
    expect(badParam.status).toBe(400);
    const self = await alice
      .put(`/api/reports/${source.id}/drill`)
      .send({ drillDef: { ...def, targetReportId: source.id } });
    expect(self.status).toBe(400);
    const saved = await alice.put(`/api/reports/${source.id}/drill`).send({ drillDef: def });
    expect(saved.status).toBe(200);
    expect(saved.body.report.drillDef).toEqual(def);
    expect(saved.body.drill.target).toEqual({
      id: target.id,
      name: target.name,
      fields: ['REGION'],
    });

    const res = await alice
      .post(`/api/reports/${source.id}/drill`)
      .send({ keys: { REGION: 'WEST' } });
    expect(res.status).toBe(200);
    expect(runs.at(-1)).toEqual({ sql: target.sql, params: ['WEST'] });
    expect(res.body.drill).toMatchObject({
      mode: 'target',
      label: 'WEST',
      target: { id: target.id },
      values: { REGION: 'WEST' },
    });
    expect(
      (await alice.post(`/api/reports/${source.id}/drill`).send({ keys: { OTHER: 'x' } })).body
        .error.code,
    ).toBe('INVALID_DRILL_FIELD');

    // Bob can see the source but not the target: no drill offered, server refuses.
    await alice
      .put(`/api/reports/${source.id}/shares`)
      .send({ shares: [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }] });
    const bob = await login('bob');
    expect((await bob.get(`/api/reports/${source.id}`)).body.drill).toEqual({
      builder: null,
      target: null,
      targetUnavailable: true,
    });
    const n = runs.length;
    const denied = await bob
      .post(`/api/reports/${source.id}/drill`)
      .send({ keys: { REGION: 'W' } });
    expect(denied.status).toBe(404);
    expect(runs.length).toBe(n);
    // and a viewer cannot change the drill settings
    expect((await bob.put(`/api/reports/${source.id}/drill`).send({ drillDef: null })).status).toBe(
      403,
    );
  });

  it('keeps the chart when the drill target changes, and vice versa', async () => {
    const api = await login();
    const rep = await saveBuilderReport(api);
    const tgt = await saveBuilderReport(api, 'Other');
    const chart = { version: 1, type: 'bar', x: 'REGION', y: ['Revenue'] };
    await api.put(`/api/reports/${rep.id}/chart`).send({ chartDef: chart });
    await api.put(`/api/reports/${rep.id}/drill`).send({
      drillDef: {
        version: 1,
        targetReportId: tgt.id,
        mapping: [{ field: 'REGION', parameter: 'SINCE' }],
      },
    });
    let r = (await api.get(`/api/reports/${rep.id}`)).body.report;
    expect(r.chartDef).toMatchObject({ type: 'bar' });
    expect(r.drillDef.targetReportId).toBe(tgt.id);
    await api.put(`/api/reports/${rep.id}/chart`).send({ chartDef: null });
    r = (await api.get(`/api/reports/${rep.id}`)).body.report;
    expect(r.chartDef).toBeNull();
    expect(r.drillDef.targetReportId).toBe(tgt.id);
    await api.put(`/api/reports/${rep.id}/drill`).send({ drillDef: null });
    expect((await api.get(`/api/reports/${rep.id}`)).body.report.drillDef).toBeNull();
  });

  it('exports the drilled detail', async () => {
    const api = await login();
    const rep = await saveBuilderReport(api);
    const res = await api
      .post(`/api/reports/${rep.id}/drill/export`)
      .send({ keys: { REGION: 'WEST' } })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('By region - WEST');
    expect(runs.at(-1)!.sql).toContain('"T1"."REGION" = ?');
    expect(runs.at(-1)!.params).toEqual(['2026-01-01', 'WEST']);
  });
});
