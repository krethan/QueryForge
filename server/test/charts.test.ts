import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  CHART_DEF_VERSION,
  chartDefSchema,
  parseChartDef,
  prepareChart,
  type ChartDef,
} from '../src/charts/chart-def.js';
import { chartSvg, renderChartPng } from '../src/charts/render.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const bar: ChartDef = chartDefSchema.parse({
  version: 1,
  type: 'bar',
  x: 'REGION',
  y: ['REVENUE'],
});
const COLS = [
  { name: 'REGION', kind: 'string' },
  { name: 'REVENUE', kind: 'decimal' },
];

describe('chart settings validation', () => {
  it('accepts a minimal bar chart and fills defaults', () => {
    expect(bar).toEqual({ version: CHART_DEF_VERSION, type: 'bar', x: 'REGION', y: ['REVENUE'] });
    expect(
      chartDefSchema.safeParse({ ...bar, showOnDashboard: true, dashboardAutoLoad: true }).success,
    ).toBe(true);
  });
  it.each([
    [{ version: 2 }, 'unknown version'],
    [{ type: 'radar' }, 'unknown type'],
    [{ y: [] }, 'no value field'],
    [{ y: ['A', 'A'] }, 'duplicate Y'],
    [{ y: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }, 'too many Y'],
    [{ type: 'pie', y: ['A', 'B'] }, 'pie with 2 values'],
    [{ type: 'donut', series: 'S' }, 'donut with series'],
    [{ y: ['A', 'B'], series: 'S' }, 'series + many Y'],
    [{ series: 'REGION' }, 'series = X'],
    [{ y: ['REGION'] }, 'X as Y'],
    [{ topN: 0 }, 'topN 0'],
    [{ topN: 1000 }, 'topN too big'],
    [{ title: 'x'.repeat(121) }, 'title too long'],
    [{ dashboardAutoLoad: true }, 'auto-load without dashboard'],
    [{ evil: '<script>' }, 'unknown key'],
  ] as Array<[Record<string, unknown>, string]>)('rejects %j (%s)', (patch) => {
    const r = chartDefSchema.safeParse({ ...bar, ...patch });
    expect(r.success).toBe(false);
  });
  it('treats tampered stored JSON as "no chart" with an error instead of throwing', () => {
    expect(parseChartDef(null)).toEqual({ def: null });
    expect(parseChartDef('{not json').def).toBeNull();
    expect(parseChartDef('{not json').error).toBeTruthy();
    expect(parseChartDef(JSON.stringify({ ...bar, type: 'radar' })).error).toBeTruthy();
    expect(parseChartDef(JSON.stringify(bar)).def).toEqual(bar);
  });
});

describe('prepareChart', () => {
  it('disables the chart with a message when a field is missing or not numeric', () => {
    const r = prepareChart({ ...bar, x: 'GONE' }, COLS, []);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/GONE/);
    const t = prepareChart({ ...bar, y: ['REGION'], x: 'REVENUE' }, COLS, []);
    expect(t.ok).toBe(false);
  });
  it('matches columns case-insensitively, sums duplicates and converts decimal strings', () => {
    const r = prepareChart({ ...bar, x: 'region', y: ['revenue'] }, COLS, [
      ['East', '10.50'],
      ['East', '2.25'],
      ['West', 7],
      ['West', null],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points).toEqual([
      expect.objectContaining({ key: 'East', value: 12.75 }),
      expect.objectContaining({ key: 'West', value: 7 }),
    ]);
    expect(r.precisionLoss).toBe(false);
  });
  it('flags values that lose precision as JavaScript numbers', () => {
    const r = prepareChart(bar, COLS, [['East', '12345678901234567.89']]);
    expect(r.ok && r.precisionLoss).toBe(true);
  });
  it('keeps the top N categories by total', () => {
    const rows = [
      ['A', 1],
      ['B', 5],
      ['C', 3],
      ['D', 4],
    ];
    const r = prepareChart({ ...bar, topN: 2 }, COLS, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points.map((p) => p.key)).toEqual(['B', 'D']);
    expect(r.categoriesDropped).toBe(2);
  });
  it('splits by series', () => {
    const cols = [...COLS, { name: 'YEAR', kind: 'string' }];
    const r = prepareChart({ ...bar, type: 'groupedBar', series: 'YEAR' }, cols, [
      ['East', 1, '2025'],
      ['East', 2, '2026'],
    ]);
    expect(r.ok && r.groups).toEqual(['2025', '2026']);
  });
});

describe('server-side chart rendering', () => {
  const prep = prepareChart(bar, COLS, [
    ['East', 10],
    ['<West & "co">', 7],
  ]);
  it('escapes labels in the SVG', () => {
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const svg = chartSvg(prep, 'Revenue <by> region');
    expect(svg).toContain('&#60;West &#38;');
    expect(svg).not.toContain('<West');
    expect(svg).toContain('Revenue &#60;by&#62; region');
  });
  it.each(['bar', 'barHorizontal', 'stackedBar', 'line', 'area', 'pie', 'donut'] as const)(
    'renders a %s chart to PNG',
    async (type) => {
      const p = prepareChart({ ...bar, type }, COLS, [
        ['East', 10],
        ['West', 7],
      ]);
      if (!p.ok) throw new Error(p.message);
      const png = await renderChartPng(p, 'T');
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.length).toBeGreaterThan(1000);
    },
  );
});

describe('migration 005', () => {
  it('adds a nullable CHART_DEF CLOB to QF_REPORTS, separate from BUILDER_DEF', () => {
    const m = loadMigrations('QFMETA').find((x) => x.version === 5)!;
    expect(m).toBeDefined();
    const sql = m.statements.join('\n');
    expect(sql).toContain(
      'ALTER TABLE QFMETA.QF_REPORTS ADD COLUMN CHART_DEF CLOB(64K) CCSID 1208',
    );
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).not.toMatch(/BUILDER_DEF/);
    expect(sql).toContain('LABEL ON COLUMN QFMETA.QF_REPORTS.CHART_DEF');
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
let db: FakeMetadataDb;
let mailer: MemoryMailer;
let built: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  mailer = new MemoryMailer();
  const f = fakeFactory(() => ({
    columns: [col('REGION', 'CHAR', 5), col('REVENUE', 'DECIMAL', 11, 2)],
    rows: [
      ['East', '1200.50'],
      ['West', '900.25'],
      ['North', '450.00'],
    ],
  }));
  built = createApp({
    cfg: testConfig({ SCHEDULE_RECIPIENT_DOMAINS: 'example.com' }),
    metadataDb: db,
    jobFactory: f.factory,
    mailer,
  });
});

async function login(username = 'alice') {
  const agent = request.agent(built.app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const send = (m: 'post' | 'put', url: string) =>
    agent[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).buffer(true);
  return { agent, send };
}
const SQL = 'SELECT REGION, REVENUE FROM SALES.TOTALS';
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('chart API', () => {
  it('saves chart settings with a new report and returns them on reopen', async () => {
    const a = await login();
    const res = await a
      .send('post', '/api/reports')
      .send({ name: 'Revenue', sql: SQL, chartDef: { ...bar, title: 'Revenue by region' } });
    expect(res.status).toBe(201);
    const id = res.body.report.id;
    const got = (await a.agent.get(`/api/reports/${id}`)).body.report;
    expect(got.chartDef).toMatchObject({ type: 'bar', x: 'REGION', title: 'Revenue by region' });
    expect(JSON.parse(String(db.reports.get(id)!.CHART_DEF))).toMatchObject({ version: 1 });
  });

  it('rejects invalid chart settings', async () => {
    const a = await login();
    const res = await a
      .send('post', '/api/reports')
      .send({ name: 'Bad', sql: SQL, chartDef: { ...bar, type: 'radar' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/chart/i);
  });

  it('updates and clears the chart with PUT /reports/:id/chart without bumping the version', async () => {
    const a = await login();
    const rep = (await a.send('post', '/api/reports').send({ name: 'R', sql: SQL })).body.report;
    const put = await a
      .send('put', `/api/reports/${rep.id}/chart`)
      .send({ chartDef: { ...bar, type: 'pie', showOnDashboard: true } });
    expect(put.status).toBe(200);
    let got = (await a.agent.get(`/api/reports/${rep.id}`)).body.report;
    expect(got.chartDef).toMatchObject({ type: 'pie', showOnDashboard: true });
    expect(got.version).toBe(rep.version);
    expect((await a.send('put', `/api/reports/${rep.id}/chart`).send({})).status).toBe(400);
    expect(
      (await a.send('put', `/api/reports/${rep.id}/chart`).send({ chartDef: { type: 'pie' } }))
        .status,
    ).toBe(400);
    await a.send('put', `/api/reports/${rep.id}/chart`).send({ chartDef: null });
    got = (await a.agent.get(`/api/reports/${rep.id}`)).body.report;
    expect(got.chartDef).toBeNull();
  });

  it('needs edit access to change a chart', async () => {
    const a = await login();
    const rep = (await a.send('post', '/api/reports').send({ name: 'R', sql: SQL })).body.report;
    const b = await login('bob');
    expect(
      (await b.send('put', `/api/reports/${rep.id}/chart`).send({ chartDef: bar })).status,
    ).toBe(404);
    await a
      .send('put', `/api/reports/${rep.id}/shares`)
      .send({ shares: [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }] });
    expect(
      (await b.send('put', `/api/reports/${rep.id}/chart`).send({ chartDef: bar })).status,
    ).toBe(403);
  });

  it('reports a tampered stored chart as an error instead of failing', async () => {
    const a = await login();
    const rep = (await a.send('post', '/api/reports').send({ name: 'R', sql: SQL, chartDef: bar }))
      .body.report;
    db.reports.get(rep.id)!.CHART_DEF = '{"version":1,"type":"bar","x":"R","y":[],"hack":1}';
    const res = await a.agent.get(`/api/reports/${rep.id}`);
    expect(res.status).toBe(200);
    expect(res.body.report.chartDef).toBeNull();
    expect(res.body.report.chartError).toBeTruthy();
    const run = await a.send('post', `/api/reports/${rep.id}/execute`).send({});
    expect(run.status).toBe(200);
  });

  it('adds a Chart sheet with a PNG to the XLSX export', async () => {
    const a = await login();
    const rep = (
      await a
        .send('post', '/api/reports')
        .send({ name: 'Revenue', sql: SQL, chartDef: { ...bar, title: 'Revenue by region' } })
    ).body.report;
    const res = await a.send('post', '/api/export').send({ reportId: rep.id }).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['x-qf-chart']).toBe('included');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ArrayBuffer);
    const sheet = wb.getWorksheet('Chart')!;
    expect(sheet).toBeTruthy();
    expect(String(sheet.getCell('A1').value)).toBe('Revenue by region');
    expect(sheet.getImages()).toHaveLength(1);
    const media = (wb.model as unknown as { media: { extension: string; buffer: Buffer }[] }).media;
    expect(media[0].extension).toBe('png');
    const info = wb.getWorksheet('Report Info')!;
    const vals: string[] = [];
    info.eachRow((r) => vals.push(r.values!.toString()));
    expect(vals.join('\n')).toMatch(/Chart.*See the Chart sheet/);
  });

  it('uses an unsaved chart from the request and skips the sheet when the chart cannot be drawn', async () => {
    const a = await login();
    const ok = await a
      .send('post', '/api/export')
      .send({ sql: SQL, chart: { ...bar, type: 'line' } })
      .parse(binary);
    expect(ok.headers['x-qf-chart']).toBe('included');
    const bad = await a
      .send('post', '/api/export')
      .send({ sql: SQL, chart: { ...bar, x: 'MISSING' } })
      .parse(binary);
    expect(bad.status).toBe(200);
    expect(decodeURIComponent(String(bad.headers['x-qf-chart']))).toMatch(/MISSING/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bad.body as ArrayBuffer);
    expect(wb.getWorksheet('Chart')).toBeUndefined();
    const none = await a.send('post', '/api/export').send({ sql: SQL }).parse(binary);
    expect(none.headers['x-qf-chart']).toBe('none');
    expect(
      (await a.send('post', '/api/export').send({ sql: SQL, chart: { type: 'bar' } })).status,
    ).toBe(400);
  });

  it('includes the chart PNG inline in scheduled emails', async () => {
    const a = await login();
    const rep = (
      await a.send('post', '/api/reports').send({ name: 'Revenue', sql: SQL, chartDef: bar })
    ).body.report;
    const s = (
      await a.send('post', `/api/reports/${rep.id}/schedules`).send({
        cron: '0 7 * * 1',
        timezone: 'America/Edmonton',
        recipients: ['ops@example.com'],
      })
    ).body.schedule;
    expect((await a.send('post', `/api/schedules/${s.id}/run`).send({})).status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.attachments.map((x) => x.filename)).toEqual([
      expect.stringMatching(/\.xlsx$/),
      'chart.png',
    ]);
    expect(m.attachments[1].cid).toBeTruthy();
    expect(m.html).toContain(`cid:${m.attachments[1].cid}`);
    expect(m.text).toMatch(/chart/i);
    expect(m.attachmentData[1].subarray(1, 4).toString()).toBe('PNG');
  });

  it('sends plain emails when the report has no chart', async () => {
    const a = await login();
    const rep = (await a.send('post', '/api/reports').send({ name: 'R', sql: SQL })).body.report;
    const s = (
      await a.send('post', `/api/reports/${rep.id}/schedules`).send({
        cron: '0 7 * * 1',
        timezone: 'UTC',
        recipients: ['ops@example.com'],
      })
    ).body.schedule;
    await a.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(mailer.sent[0].attachments).toHaveLength(1);
    expect(mailer.sent[0].html).toBeUndefined();
  });
});
