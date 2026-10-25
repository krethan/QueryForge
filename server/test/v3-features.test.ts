import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import {
  JSON_SOURCE_TEXT_SUPPORTED,
  normalizeCell,
  toColumns,
  type ResultColumn,
} from '../src/sql/results.js';
import {
  TEXT_NUMBER_NOTE,
  XlsxResultWriter,
  canonicalDecimal,
  safeExcelNumber,
  toExcel,
} from '../src/export/xlsx.js';
import { ResultCursorStore } from '../src/sql/cursors.js';
import { diffShares } from '../src/sharing/access.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type FakeJob } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

const column = (type: string, precision: number, scale = 0): ResultColumn =>
  toColumns([{ name: 'V', label: 'V', type, precision, scale, nullable: 1 } as never], true)[0];

/** The reviver @ibm/mapepire-js 1.0.2 passes to JSON.parse for every server message. */
const mapepireReviver = (_k: string, v: unknown, ctx?: { source?: string }) =>
  ctx && typeof v === 'number' && String(v) !== ctx.source ? ctx.source : v;

describe('exact DECIMAL / NUMERIC / BIGINT values', () => {
  it('detects JSON.parse source-text access consistently with the runtime', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 22) expect(JSON_SOURCE_TEXT_SUPPORTED).toBe(true);
    expect(typeof JSON_SOURCE_TEXT_SUPPORTED).toBe('boolean');
  });
  it.runIf(JSON_SOURCE_TEXT_SUPPORTED)(
    "mapepire-js' reviver keeps lossy numbers as their exact source text",
    () => {
      const row = JSON.parse(
        '[12345678901234567890, 9223372036854775807, 1.50, 42, 0.1]',
        mapepireReviver as never,
      );
      expect(row).toEqual(['12345678901234567890', '9223372036854775807', '1.50', 42, 0.1]);
    },
  );
  it('keeps decimal strings untouched and pads safe numbers to the declared scale', () => {
    const d = column('DECIMAL', 31, 2);
    expect(normalizeCell('12345678901234567890123456789.01', d)).toBe(
      '12345678901234567890123456789.01',
    );
    expect(normalizeCell(12.5, column('DECIMAL', 11, 2))).toBe('12.50');
    expect(normalizeCell('-0.10', column('NUMERIC', 9, 2))).toBe('-0.10');
    expect(normalizeCell(null, d)).toBeNull();
  });
  it('always returns BIGINT as a string', () => {
    const b = column('BIGINT', 19);
    expect(normalizeCell('9223372036854775807', b)).toBe('9223372036854775807');
    expect(normalizeCell(42, b)).toBe('42');
    expect(normalizeCell(7, column('INTEGER', 10))).toBe(7);
  });
  it('flags wide columns as precision-at-risk only on runtimes without source text access', () => {
    const meta = [
      { name: 'B', label: 'B', type: 'BIGINT', precision: 19, scale: 0, nullable: 1 },
      { name: 'D', label: 'D', type: 'DECIMAL', precision: 31, scale: 2, nullable: 1 },
      { name: 'S', label: 'S', type: 'DECIMAL', precision: 11, scale: 2, nullable: 1 },
      { name: 'I', label: 'I', type: 'INTEGER', precision: 10, scale: 0, nullable: 1 },
    ] as never;
    expect(toColumns(meta, false).map((c) => !!c.precisionAtRisk)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(toColumns(meta, true).some((c) => c.precisionAtRisk)).toBe(false);
  });
});

describe('XLSX numeric safety', () => {
  it('canonicalises plain decimal strings', () => {
    expect(canonicalDecimal('+0012.5000')).toBe('12.5');
    expect(canonicalDecimal('-0.000')).toBe('0');
    expect(canonicalDecimal('1e5')).toBeNull();
    expect(canonicalDecimal('abc')).toBeNull();
  });
  it('writes a number only when a double round-trips it exactly', () => {
    expect(safeExcelNumber('123456789012.345')).toBe(123456789012.345);
    expect(safeExcelNumber('-0.10')).toBe(-0.1);
    expect(safeExcelNumber('1234567890123456')).toBeNull(); // 16 digits
    expect(safeExcelNumber('9223372036854775807')).toBeNull();
    expect(safeExcelNumber('0.1234567890123456789')).toBeNull();
  });
  it('flags exact text cells and leaves safe values numeric', () => {
    const d = column('DECIMAL', 31, 2);
    expect(toExcel('12345678901234567890.12', d, 'prefix')).toEqual({
      value: '12345678901234567890.12',
      numericAsText: true,
    });
    expect(toExcel('10.25', d, 'prefix')).toEqual({ value: 10.25, numericAsText: false });
    expect(toExcel('-5', column('BIGINT', 19), 'prefix')).toEqual({
      value: -5,
      numericAsText: false,
    });
  });
  it('adds a note to text cells and explains them on the Report Info sheet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qf-v3-'));
    try {
      const path = join(dir, 'x.xlsx');
      const w = new XlsxResultWriter(path, 'Big numbers', 'prefix');
      const cols = toColumns(
        [
          { name: 'ID', label: 'ID', type: 'BIGINT', precision: 19, scale: 0, nullable: 0 },
          { name: 'AMT', label: 'AMT', type: 'DECIMAL', precision: 31, scale: 2, nullable: 1 },
        ] as never,
        true,
      );
      w.setColumns(cols);
      w.addRows([
        ['9223372036854775807', '12345678901234567890.12'],
        ['42', '10.50'],
      ]);
      await w.finish({
        title: 'Big numbers',
        sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1',
        executedAt: '2026-10-24T00:00:00Z',
        executedBy: 'alice',
        dataSource: 'test',
        maxRows: 10,
      });
      expect(w.numericAsText).toBe(2);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(path);
      const s = wb.getWorksheet('Big numbers')!;
      expect(s.getCell('A2').value).toBe('9223372036854775807');
      expect(s.getCell('A2').note).toBe(TEXT_NUMBER_NOTE);
      expect(s.getCell('B2').value).toBe('12345678901234567890.12');
      expect(s.getCell('A3').value).toBe(42);
      expect(s.getCell('B3').value).toBe(10.5);
      expect(s.getCell('B3').note).toBeUndefined();
      expect(String(s.getCell('A1').note)).toMatch(/exact text/);
      const info = wb.getWorksheet('Report Info')!;
      const vals: string[] = [];
      info.eachRow((r) => vals.push(`${r.getCell(1).value}=${r.getCell(2).value}`));
      expect(vals.join('\n')).toMatch(/Numbers kept as text=2 value\(s\) in ID, AMT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
let db: FakeMetadataDb;
let jobs: FakeJob[];
const ROWS = 23;
function build(over: Record<string, string> = {}) {
  const f = fakeFactory(() => ({
    columns: [col('N', 'INTEGER'), col('BIG', 'BIGINT', 19), col('AMT', 'DECIMAL', 31, 2)],
    rows: Array.from({ length: ROWS }, (_, i) => [
      i + 1,
      `92233720368547758${String(i).padStart(2, '0')}`,
      `1234567890123456789.${String(i).padStart(2, '0')}`,
    ]),
  }));
  jobs = f.jobs;
  return createApp({
    cfg: testConfig({ RESULT_PAGE_SIZE: '10', MAX_RESULT_ROWS: '100', ...over }),
    metadataDb: db,
    jobFactory: f.factory,
  });
}
async function login(app: ReturnType<typeof createApp>['app'], username = 'alice') {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const send = (m: 'post' | 'put' | 'delete', url: string) =>
    agent[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return { agent, send };
}
const SQL = 'SELECT N, BIG, AMT FROM SALESLIB.BIGNUMS';

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-eve', username: 'eve', hash, displayName: 'Eve' });
});

describe('server-side paging with Query.fetchMore', () => {
  it('returns the first page with a cursor and pages to the end, then closes the job', async () => {
    const built = build();
    const a = await login(built.app);
    const first = await a.send('post', '/api/query/execute').send({ sql: SQL });
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(10);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.truncated).toBe(false);
    expect(first.body.cursor).toMatchObject({ pageSize: 10 });
    expect(first.body.rows[0]).toEqual([1, '9223372036854775800', '1234567890123456789.00']);
    const id = first.body.cursor.id as string;
    expect(jobs[0].closed).toBe(false); // held open for paging
    expect(built.executor.cursors.size).toBe(1);

    const p2 = await a.send('post', `/api/results/${id}/next`);
    expect(p2.status).toBe(200);
    expect(p2.body).toMatchObject({ rowCount: 20, hasMore: true });
    expect(p2.body.rows[0][0]).toBe(11);
    const p3 = await a.send('post', `/api/results/${id}/next`);
    expect(p3.body).toMatchObject({ rowCount: 23, hasMore: false, truncated: false });
    expect(p3.body.rows).toHaveLength(3);
    expect(jobs[0].closed).toBe(true);
    expect(built.executor.cursors.size).toBe(0);
    expect(jobs[0].fetchSizes).toEqual([10, 10, 10]);

    // the history row is finished again with the final row count
    const exec = [...db.executions.values()][0];
    expect(exec).toMatchObject({ STATUS: 'SUCCEEDED', ROW_COUNT: 23, TRUNCATED: 0 });
    expect((await a.send('post', `/api/results/${id}/next`)).status).toBe(410);
  });

  it('closes the job immediately when the first page is the whole result', async () => {
    const built = build({ RESULT_PAGE_SIZE: '50' });
    const a = await login(built.app);
    const r = await a.send('post', '/api/query/execute').send({ sql: SQL });
    expect(r.body).toMatchObject({ rowCount: 23, hasMore: false, truncated: false });
    expect(r.body.cursor).toBeUndefined();
    expect(jobs[0].closed).toBe(true);
  });

  it('stops at MAX_RESULT_ROWS and reports truncation', async () => {
    const built = build({ MAX_RESULT_ROWS: '15' });
    const a = await login(built.app);
    const r = await a.send('post', '/api/query/execute').send({ sql: SQL });
    const p = await a.send('post', `/api/results/${r.body.cursor.id}/next`);
    expect(p.body).toMatchObject({ rowCount: 15, hasMore: false, truncated: true });
    expect(p.body.rows).toHaveLength(5);
    expect(jobs[0].closed).toBe(true);
    expect([...db.executions.values()][0]).toMatchObject({ ROW_COUNT: 15, TRUNCATED: 1 });
  });

  it('binds cursors to their owner', async () => {
    const built = build();
    const a = await login(built.app);
    const b = await login(built.app, 'bob');
    const r = await a.send('post', '/api/query/execute').send({ sql: SQL });
    const id = r.body.cursor.id;
    expect((await b.send('post', `/api/results/${id}/next`)).status).toBe(404);
    expect((await b.send('delete', `/api/results/${id}`)).status).toBe(404);
    expect(jobs[0].closed).toBe(false);
    expect((await a.send('delete', `/api/results/${id}`)).status).toBe(204);
    expect(jobs[0].closed).toBe(true);
    expect((await a.send('post', `/api/results/${id}/next`)).status).toBe(410);
  });

  it('expires idle cursors and closes their job', async () => {
    const built = build({ CURSOR_IDLE_TTL_MS: '30' });
    const a = await login(built.app);
    const r = await a.send('post', '/api/query/execute').send({ sql: SQL });
    await new Promise((res) => setTimeout(res, 60));
    const p = await a.send('post', `/api/results/${r.body.cursor.id}/next`);
    expect(p.status).toBe(410);
    expect(p.body.error.code).toBe('CURSOR_EXPIRED');
    await built.executor.cursors.sweep();
    expect(jobs[0].closed).toBe(true);
  });

  it("evicts the user's oldest cursor at the per-user limit", async () => {
    const built = build({ MAX_OPEN_CURSORS_PER_USER: '1' });
    const a = await login(built.app);
    const r1 = await a.send('post', '/api/query/execute').send({ sql: SQL });
    const r2 = await a.send('post', '/api/query/execute').send({ sql: SQL });
    expect(r2.body.hasMore).toBe(true);
    expect(jobs[0].closed).toBe(true);
    expect(jobs[1].closed).toBe(false);
    expect((await a.send('post', `/api/results/${r1.body.cursor.id}/next`)).status).toBe(410);
  });

  it('falls back to a truncated first page when the global cursor limit is reached', async () => {
    const built = build({ MAX_OPEN_CURSORS: '1', MAX_OPEN_CURSORS_PER_USER: '1' });
    const a = await login(built.app);
    const b = await login(built.app, 'bob');
    await a.send('post', '/api/query/execute').send({ sql: SQL });
    const r = await b.send('post', '/api/query/execute').send({ sql: SQL });
    expect(r.body).toMatchObject({ hasMore: false, truncated: true, pagingUnavailable: true });
    expect(r.body.rows).toHaveLength(10);
    expect(jobs[1].closed).toBe(true);
    expect(jobs[0].closed).toBe(false);
  });

  it('closes every cursor on shutdown', async () => {
    const built = build();
    const a = await login(built.app);
    await a.send('post', '/api/query/execute').send({ sql: SQL });
    await built.executor.shutdown();
    expect(jobs[0].closed).toBe(true);
  });
});

describe('ResultCursorStore', () => {
  const fakeEntry = (ownerId: string) => {
    const state = { closed: 0 };
    return {
      state,
      e: {
        ownerId,
        executionId: 'x',
        job: { close: async () => void state.closed++ } as never,
        query: { close: async () => undefined } as never,
        columns: [],
        rowCount: 0,
        maxRows: 10,
      },
    };
  };
  it('caps sliding expiry at the maximum lifetime', async () => {
    let t = 0;
    const s = new ResultCursorStore(
      { idleTtlMs: 100, maxLifetimeMs: 150, maxOpen: 5, maxOpenPerUser: 5 },
      () => t,
    );
    const { e, state } = fakeEntry('u');
    const c = (await s.add(e))!;
    t = 90;
    s.checkin(s.checkout(c.id, 'u'));
    expect(c.expiresAt).toBe(150);
    t = 150;
    expect(() => s.checkout(c.id, 'u')).toThrow(/no longer available/);
    await s.sweep();
    expect(state.closed).toBe(1);
  });
  it('rejects concurrent fetches on one cursor', async () => {
    const s = new ResultCursorStore({
      idleTtlMs: 1000,
      maxLifetimeMs: 1000,
      maxOpen: 5,
      maxOpenPerUser: 5,
    });
    const c = (await s.add(fakeEntry('u').e))!;
    s.checkout(c.id, 'u');
    expect(() => s.checkout(c.id, 'u')).toThrow(/already being fetched/);
  });
});

describe('sharing audit', () => {
  it('diffs share lists into grant / change / revoke events', () => {
    expect(
      diffShares(
        [
          { type: 'USER', id: 'a', role: 'VIEWER' },
          { type: 'GROUP', id: 'g', role: 'EDITOR' },
        ],
        [
          { type: 'USER', id: 'a', role: 'EDITOR' },
          { type: 'USER', id: 'b', role: 'VIEWER' },
        ],
      ),
    ).toEqual([
      { action: 'CHANGE', type: 'USER', id: 'a', oldRole: 'VIEWER', newRole: 'EDITOR' },
      { action: 'GRANT', type: 'USER', id: 'b', oldRole: null, newRole: 'VIEWER' },
      { action: 'REVOKE', type: 'GROUP', id: 'g', oldRole: 'EDITOR', newRole: null },
    ]);
  });

  it('records events in Db2 metadata and shows them to the owner only', async () => {
    const built = build();
    const a = await login(built.app);
    const rep = (await a.send('post', '/api/reports').send({ name: 'Audited', sql: SQL })).body
      .report as { id: string };
    const put = (shares: unknown[]) =>
      a.send('put', `/api/reports/${rep.id}/shares`).send({ shares });
    expect((await put([{ type: 'USER', id: 'u-bob', role: 'VIEWER' }])).status).toBe(200);
    await put([
      { type: 'USER', id: 'u-bob', role: 'EDITOR' },
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
    ]);
    await put([{ type: 'GROUP', id: 'finance', role: 'VIEWER' }]);
    await put([{ type: 'GROUP', id: 'finance', role: 'VIEWER' }]); // no-op: no event

    const res = await a.agent.get(`/api/reports/${rep.id}/access`);
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ id: 'u-alice', displayName: 'Alice' });
    expect(res.body.shares).toEqual([
      expect.objectContaining({ type: 'GROUP', id: 'finance', role: 'VIEWER' }),
    ]);
    const ev = res.body.events.map(
      (e: { action: string; principalId: string; oldRole: string; newRole: string }) =>
        `${e.action}:${e.principalId}:${e.oldRole ?? '-'}>${e.newRole ?? '-'}`,
    );
    expect(ev).toEqual([
      'REVOKE:u-bob:EDITOR>-',
      'GRANT:finance:->VIEWER',
      'CHANGE:u-bob:VIEWER>EDITOR',
      'GRANT:u-bob:->VIEWER',
    ]);
    expect(res.body.events[0]).toMatchObject({
      actorId: 'u-alice',
      actorName: 'Alice',
      principalName: 'Bob',
    });
    expect(res.body.events[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // all statements are parameterised (FakeMetadataDb asserts no value is inlined)
    expect(db.statements.some((s) => s.sql.includes('QF_SHARE_AUDIT'))).toBe(true);

    await put([{ type: 'USER', id: 'u-eve', role: 'EDITOR' }]);
    const eve = await login(built.app, 'eve');
    expect((await eve.agent.get(`/api/reports/${rep.id}/access`)).status).toBe(403);
    const bob = await login(built.app, 'bob');
    expect((await bob.agent.get(`/api/reports/${rep.id}/access`)).status).toBe(404);
  });

  it('rolls the audit back with a failed share change', async () => {
    const built = build();
    const a = await login(built.app);
    const rep = (await a.send('post', '/api/reports').send({ name: 'R', sql: SQL })).body
      .report as { id: string };
    const r = await a
      .send('put', `/api/reports/${rep.id}/shares`)
      .send({ shares: [{ type: 'USER', id: 'u-missing', role: 'VIEWER' }] });
    expect(r.status).toBe(400);
    expect(db.shareAudit).toHaveLength(0);
  });

  it('ships migration 003 with the audit table and protects it from reporting SQL', async () => {
    const m = loadMigrations('QFMETA').find((x) => x.version === 3)!;
    expect(m.file).toBe('003_share_audit.sql');
    expect(m.statements.join('\n')).toContain('CREATE TABLE QFMETA.QF_SHARE_AUDIT');
    const built = build();
    const a = await login(built.app);
    const r = await a
      .send('post', '/api/query/execute')
      .send({ sql: 'SELECT * FROM QFMETA.QF_SHARE_AUDIT' });
    expect(r.status).toBe(400);
  });
});
