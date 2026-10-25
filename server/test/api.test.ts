import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

let db: FakeMetadataDb;
let app: ReturnType<typeof createApp>['app'];
let jobs: ReturnType<typeof fakeFactory>['jobs'];
let script: (sql: string) => Scripted;

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  let counter = 0;
  script = (sql) => ({
    columns: [col('N', 'INTEGER'), col('TXT', 'VARCHAR', 20)],
    rows: [
      [sql === '__connect__' ? 0 : ++counter, '=2+2'],
      [null, ''],
    ],
  });
  const f = fakeFactory((sql) => script(sql));
  jobs = f.jobs;
  app = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
});

async function login(username = 'alice') {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const send = (method: 'post' | 'put' | 'delete', url: string) =>
    agent[method](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return { agent, csrf, send };
}

describe('authentication', () => {
  it('rejects unauthenticated API access', async () => {
    expect((await request(app).get('/api/reports')).status).toBe(401);
    expect(
      (await request(app).post('/api/query/execute').send({ sql: 'SELECT 1 FROM T' })).status,
    ).toBe(401);
  });
  it('rejects bad credentials without revealing which part was wrong', async () => {
    const a = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'nope-nope-nope' });
    const b = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'nope-nope-nope' });
    expect(a.status).toBe(401);
    expect(b.body).toEqual(a.body);
  });
  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++)
      await request(app)
        .post('/api/auth/login')
        .send({ username: 'bob', password: 'wrong-password-x' });
    const res = await request(app).post('/api/auth/login').send({ username: 'bob', password: PW });
    expect(res.status).toBe(423);
  });
  it('sets HttpOnly SameSite session cookie and returns the user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ALICE', password: PW });
    expect(String(res.headers['set-cookie'])).toMatch(
      /qf_session=[^;]+;.*HttpOnly.*SameSite=Strict/,
    );
    expect(res.body.user).toMatchObject({ username: 'alice', displayName: 'Alice' });
    expect(JSON.stringify(res.body)).not.toContain('hash');
  });
  it('requires CSRF token and same origin for unsafe requests', async () => {
    const { agent, csrf } = await login();
    expect(
      (await agent.post('/api/reports').send({ name: 'x', sql: 'SELECT 1 FROM T' })).status,
    ).toBe(403);
    expect(
      (
        await agent
          .post('/api/reports')
          .set('X-CSRF-Token', 'wrong')
          .send({ name: 'x', sql: 'SELECT 1 FROM T' })
      ).status,
    ).toBe(403);
    expect(
      (
        await agent
          .post('/api/reports')
          .set('Origin', 'https://evil.example')
          .set('X-CSRF-Token', csrf)
          .send({ name: 'x', sql: 'SELECT 1 FROM T' })
      ).status,
    ).toBe(403);
  });
  it('logs out', async () => {
    const { agent, send } = await login();
    expect((await send('post', '/api/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('ad-hoc execution', () => {
  it('runs read-only SQL and returns columns, rows, NULLs and timing', async () => {
    const { send } = await login();
    const res = await send('post', '/api/query/execute').send({
      sql: 'SELECT N, TXT FROM SALESLIB.T',
    });
    expect(res.status).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual(['N', 'TXT']);
    expect(res.body.rows).toEqual([
      [1, '=2+2'],
      [null, ''],
    ]);
    expect(res.body).toMatchObject({
      rowCount: 2,
      truncated: false,
      dataSource: expect.any(String),
    });
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
    expect(jobs[0].options.access).toBe('read only');
  });
  it('rejects prohibited SQL with 400 and does not connect', async () => {
    const { send } = await login();
    const res = await send('post', '/api/query/execute').send({ sql: 'DROP TABLE SALESLIB.T' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STATEMENT_NOT_ALLOWED');
    expect(jobs).toHaveLength(0);
  });
  it('returns sanitized Db2 errors with SQLSTATE', async () => {
    script = () => ({
      columns: [],
      rows: [],
      error: {
        message: '[SQL0204] T in SALESLIB type *FILE not found.',
        sqlState: '42704',
        sqlCode: -204,
      },
    });
    const { send, agent } = await login();
    const res = await send('post', '/api/query/execute').send({ sql: 'SELECT * FROM SALESLIB.T' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ sqlState: '42704', sqlCode: -204 });
    const hist = await agent.get('/api/history');
    expect(hist.body.executions[0]).toMatchObject({ status: 'FAILED', sqlState: '42704' });
  });
});

describe('saved reports', () => {
  const body = {
    name: 'Open Orders',
    description: 'Orders not shipped',
    category: 'Sales',
    sql: 'SELECT N, TXT FROM SALESLIB.ORDERS',
  };

  it('supports create, read, update, list and delete', async () => {
    const { agent, send } = await login();
    const c = await send('post', '/api/reports').send(body);
    expect(c.status).toBe(201);
    const id = c.body.report.id;
    expect(c.body.report).toMatchObject({ name: 'Open Orders', version: 1, lastStatus: 'NEVER' });
    expect((await agent.get(`/api/reports/${id}`)).body.report.sql).toBe(body.sql);
    const u = await send('put', `/api/reports/${id}`).send({
      ...body,
      name: 'Open Orders v2',
      version: 1,
    });
    expect(u.body.report).toMatchObject({ name: 'Open Orders v2', version: 2 });
    expect((await send('put', `/api/reports/${id}`).send({ ...body, version: 1 })).status).toBe(
      409,
    );
    expect((await agent.get('/api/reports?search=v2')).body.reports).toHaveLength(1);
    expect((await agent.get('/api/reports?search=zzz')).body.reports).toHaveLength(0);
    expect((await send('delete', `/api/reports/${id}`)).status).toBe(204);
    expect((await agent.get(`/api/reports/${id}`)).status).toBe(404);
  });

  it('validates input and rejects duplicate names (case-insensitive)', async () => {
    const { send } = await login();
    expect((await send('post', '/api/reports').send({ ...body, name: '  ' })).status).toBe(400);
    await send('post', '/api/reports').send(body);
    const dup = await send('post', '/api/reports').send({ ...body, name: 'OPEN ORDERS' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_NAME');
  });

  it('isolates reports between users', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const id = (await alice.send('post', '/api/reports').send(body)).body.report.id;
    expect((await bob.agent.get('/api/reports')).body.reports).toHaveLength(0);
    expect((await bob.agent.get(`/api/reports/${id}`)).status).toBe(404);
    expect((await bob.send('put', `/api/reports/${id}`).send(body)).status).toBe(404);
    expect((await bob.send('delete', `/api/reports/${id}`)).status).toBe(404);
    expect((await bob.send('post', `/api/reports/${id}/execute`).send({})).status).toBe(404);
    expect((await bob.send('post', '/api/export').send({ reportId: id })).status).toBe(404);
    expect((await alice.agent.get(`/api/reports/${id}`)).status).toBe(200);
  });

  it('re-executes saved SQL against the database every time and records history', async () => {
    const { agent, send } = await login();
    const id = (await send('post', '/api/reports').send(body)).body.report.id;
    const r1 = await send('post', `/api/reports/${id}/execute`).send({});
    const r2 = await send('post', `/api/reports/${id}/execute`).send({});
    expect(r1.body.rows[0][0]).toBe(1);
    expect(r2.body.rows[0][0]).toBe(2); // fresh result, not cached
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.queries.includes(body.sql) && j.closed)).toBe(true);
    const rep = (await agent.get(`/api/reports/${id}`)).body.report;
    expect(rep).toMatchObject({ lastStatus: 'SUCCEEDED', lastRowCount: 2 });
    expect(rep.lastExecutedAt).toMatch(/Z$/);
    const hist = (await agent.get(`/api/reports/${id}/history`)).body.executions;
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ status: 'SUCCEEDED', rowCount: 2, kind: 'RUN' });
  });

  it('records history for timeouts', async () => {
    script = (sql) =>
      sql === '__connect__'
        ? { columns: [], rows: [] }
        : { columns: [col('N', 'INTEGER')], rows: [[1]], delayMs: 3000 };
    const { agent, send } = await login();
    const id = (await send('post', '/api/reports').send(body)).body.report.id;
    const res = await send('post', `/api/reports/${id}/execute`).send({});
    expect(res.status).toBe(504);
    expect((await agent.get(`/api/reports/${id}`)).body.report.lastStatus).toBe('TIMED_OUT');
  }, 10000);

  it('uses parameterised metadata SQL only', async () => {
    const { send } = await login();
    await send('post', '/api/reports').send({ ...body, name: "O'Brien'); DROP TABLE X; --" });
    expect(db.statements.some((s) => s.sql.includes("O'Brien"))).toBe(false);
  });
});

describe('XLSX export', () => {
  it('exports a saved report as a valid workbook with formula escaping', async () => {
    const { send } = await login();
    const id = (
      await send('post', '/api/reports').send({ name: 'Export Me', sql: 'SELECT N, TXT FROM T' })
    ).body.report.id;
    const res = await send('post', '/api/export')
      .send({ reportId: id })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('Export Me.xlsx');
    expect(res.headers['x-qf-row-count']).toBe('2');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const s = wb.worksheets[0];
    expect(s.getCell('A1').value).toBe('N');
    expect(s.getCell('B2').value).toBe("'=2+2");
    expect(s.getCell('A3').value).toBeNull();
  });
});
