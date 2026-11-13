import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PROTECTED_METADATA_OBJECTS } from '../src/db/schema.js';
import { applyTileOrder, MAX_TILE_ORDER } from '../src/reports/tile-order.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT N FROM SALESLIB.NUMS';
const MISSING = '00000000-0000-4000-8000-00000000dead';

let db: FakeMetadataDb;
function build() {
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  return createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory });
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
type Client = Awaited<ReturnType<typeof login>>;
type Listed = { id: string; name: string; tilePos: number | null };
const newReport = async (c: Client, name: string) =>
  (await c.send('post', '/api/reports').send({ name, sql: SQL })).body.report as { id: string };
const list = async (c: Client, sort = 'custom') =>
  (await c.agent.get(`/api/reports?sort=${sort}`)).body as { reports: Listed[]; shared: Listed[] };
const names = (xs: Listed[]) => xs.map((x) => x.name);
const saveOrder = (c: Client, reportIds: string[]) =>
  c.send('put', '/api/dashboard/tile-order').send({ reportIds });
const share = (c: Client, id: string, shares: { type: string; id: string; role: string }[]) =>
  c.send('put', `/api/reports/${id}/shares`).send({ shares });

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-carol', username: 'carol', hash, displayName: 'Carol' });
  db.addUser({ id: 'u-admin', username: 'root', hash, displayName: 'Root', role: 'ADMIN' });
  db.addGroup('u-carol', 'finance');
});

describe('migration 008: dashboard tile order', () => {
  const migs = loadMigrations('QFMETA');
  const m8 = migs.find((m) => m.version === 8)!;
  const sql = m8.statements.join('\n');
  it('is additive: one new QF_ table and nothing altered or dropped', () => {
    expect(migs.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sql).toContain('CREATE TABLE QFMETA.QF_TILE_ORDER');
    for (const st of m8.statements)
      expect(st).toMatch(/^(CREATE TABLE|LABEL ON TABLE) QFMETA\.QF_TILE_ORDER\b/);
    expect(sql).not.toMatch(/\b(ALTER|DROP)\b/);
    expect(sql).not.toContain('{{SCHEMA}}');
  });
  it('keys order by user and report and cascades with both', () => {
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*USER_ID\s*,\s*REPORT_ID\s*\)/);
    expect(sql).toMatch(
      /FOREIGN KEY \(USER_ID\) REFERENCES QFMETA\.QF_USERS \(USER_ID\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(REPORT_ID\) REFERENCES QFMETA\.QF_REPORTS \(REPORT_ID\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(/CHECK \(TILE_POS >= 0\)/);
  });
  it('keeps the new table out of reach of reporting SQL', () => {
    expect(PROTECTED_METADATA_OBJECTS).toContain('QF_TILE_ORDER');
  });
});

describe('applyTileOrder', () => {
  const r = (id: string) => ({ id });
  it('puts saved positions first and keeps the rest in their incoming order', () => {
    const out = applyTileOrder(
      [r('a'), r('b'), r('c'), r('d')],
      new Map([
        ['c', 0],
        ['a', 5],
      ]),
    );
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('never adds a report that is not in the input list', () => {
    expect(applyTileOrder([r('a')], new Map([['zzz', 0]])).map((x) => x.id)).toEqual(['a']);
  });
  it('is the identity with no saved order', () => {
    const xs = [r('b'), r('a')];
    expect(applyTileOrder(xs, new Map())).toEqual(xs);
  });
});

describe('saving and applying tile order', () => {
  it('uses the default (name) order when nothing is saved', async () => {
    const a = await login(build().app);
    for (const n of ['Costs', 'Revenue', 'Backlog']) await newReport(a, n);
    const l = await list(a);
    expect(names(l.reports)).toEqual(['Backlog', 'Costs', 'Revenue']);
    expect(l.reports.every((x) => x.tilePos === null)).toBe(true);
    expect((await a.agent.get('/api/dashboard/tile-order')).body).toEqual({ reportIds: [] });
  });

  it('saves an order and applies it on the next load (survives reload)', async () => {
    const app = build().app;
    const a = await login(app);
    const costs = await newReport(a, 'Costs');
    const rev = await newReport(a, 'Revenue');
    const back = await newReport(a, 'Backlog');
    const res = await saveOrder(a, [rev.id, back.id, costs.id]);
    expect(res.status).toBe(200);
    expect(res.body.reportIds).toEqual([rev.id, back.id, costs.id]);
    // a brand-new session (reload) sees the same order from the server
    const again = await login(app);
    const l = await list(again);
    expect(names(l.reports)).toEqual(['Revenue', 'Backlog', 'Costs']);
    expect(l.reports.map((x) => x.tilePos)).toEqual([0, 1, 2]);
    expect((await again.agent.get('/api/dashboard/tile-order')).body.reportIds).toEqual([
      rev.id,
      back.id,
      costs.id,
    ]);
    // other sort keys ignore the custom order but still report positions
    const byName = await list(a, 'name');
    expect(names(byName.reports)).toEqual(['Backlog', 'Costs', 'Revenue']);
    expect(byName.reports.find((x) => x.id === rev.id)!.tilePos).toBe(0);
  });

  it('places new reports after the ordered tiles, in name order', async () => {
    const a = await login(build().app);
    const z = await newReport(a, 'Zeta');
    const y = await newReport(a, 'Yak');
    await saveOrder(a, [z.id, y.id]);
    await newReport(a, 'Beta');
    await newReport(a, 'Alpha');
    const l = await list(a);
    expect(names(l.reports)).toEqual(['Zeta', 'Yak', 'Alpha', 'Beta']);
    expect(l.reports.map((x) => x.tilePos)).toEqual([0, 1, null, null]);
  });

  it('replaces the whole order on save and can reset to default', async () => {
    const a = await login(build().app);
    const x = await newReport(a, 'X report');
    const w = await newReport(a, 'W report');
    await saveOrder(a, [x.id, w.id]);
    await saveOrder(a, [w.id]);
    expect(db.tileOrder.size).toBe(1);
    expect(names((await list(a)).reports)).toEqual(['W report', 'X report']);
    const del = await a.send('delete', '/api/dashboard/tile-order');
    expect(del.status).toBe(200);
    expect(db.tileOrder.size).toBe(0);
    expect(names((await list(a)).reports)).toEqual(['W report', 'X report']);
  });

  it('applies the order to owned and shared tiles and keeps search filtering', async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    const mine1 = await newReport(b, 'Bob one');
    const mine2 = await newReport(b, 'Bob two');
    const s1 = await newReport(a, 'Alice shared A');
    const s2 = await newReport(a, 'Alice shared B');
    for (const s of [s1, s2]) await share(a, s.id, [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }]);
    await saveOrder(b, [s2.id, mine2.id, s1.id, mine1.id]);
    const l = await list(b);
    expect(names(l.reports)).toEqual(['Bob two', 'Bob one']);
    expect(names(l.shared)).toEqual(['Alice shared B', 'Alice shared A']);
    expect(l.shared.map((x) => x.tilePos)).toEqual([0, 2]);
    const searched = (await b.agent.get('/api/reports?sort=custom&search=shared')).body;
    expect(names(searched.reports)).toEqual([]);
    expect(names(searched.shared)).toEqual(['Alice shared B', 'Alice shared A']);
    // each user's order is their own
    expect(names((await list(a)).reports)).toEqual(['Alice shared A', 'Alice shared B']);
  });

  it('validates the body', async () => {
    const a = await login(build().app);
    const r = await newReport(a, 'Revenue');
    const put = (body: unknown) => a.send('put', '/api/dashboard/tile-order').send(body as object);
    expect((await put({})).status).toBe(400);
    expect((await put({ reportIds: ['not-a-uuid'] })).status).toBe(400);
    expect((await put({ reportIds: [r.id, r.id] })).status).toBe(400);
    expect((await put({ reportIds: [r.id], userId: 'u-bob' })).status).toBe(400);
    const tooMany = Array.from(
      { length: MAX_TILE_ORDER + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect((await put({ reportIds: tooMany })).status).toBe(400);
    expect(db.tileOrder.size).toBe(0);
  });

  it('requires a signed-in session and CSRF token', async () => {
    const app = build().app;
    expect((await request(app).get('/api/dashboard/tile-order')).status).toBe(401);
    const a = await login(app);
    const r = await newReport(a, 'Revenue');
    const noCsrf = await a.agent
      .put('/api/dashboard/tile-order')
      .set('Origin', ORIGIN)
      .send({ reportIds: [r.id] });
    expect(noCsrf.status).toBe(403);
    expect(db.tileOrder.size).toBe(0);
  });
});

describe('access control: tile order never exposes or keeps unreadable reports', () => {
  it("silently drops reports the user cannot see (another user's, or unknown)", async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    const secret = await newReport(a, 'Alice secret');
    const mine = await newReport(b, 'Bob report');
    const res = await saveOrder(b, [secret.id, MISSING, mine.id]);
    expect(res.status).toBe(200);
    // the same answer for "exists but not yours" and "does not exist"
    expect(res.body.reportIds).toEqual([mine.id]);
    expect([...db.tileOrder.values()].map((x) => x.REPORT_ID)).toEqual([mine.id]);
    const l = await list(b);
    expect(names([...l.reports, ...l.shared])).toEqual(['Bob report']);
  });

  it('ignores, then prunes, entries for a report whose share was revoked', async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    const shared = await newReport(a, 'Was shared');
    const mine = await newReport(b, 'Bob report');
    await share(a, shared.id, [{ type: 'USER', id: 'u-bob', role: 'EDITOR' }]);
    await saveOrder(b, [shared.id, mine.id]);
    expect((await list(b)).shared.map((x) => x.tilePos)).toEqual([0]);
    await share(a, shared.id, []);
    const l = await list(b);
    expect(l.shared).toEqual([]);
    // positions are re-ranked over visible reports only
    expect(l.reports.map((x) => [x.name, x.tilePos])).toEqual([['Bob report', 0]]);
    expect((await b.agent.get('/api/dashboard/tile-order')).body.reportIds).toEqual([mine.id]);
    // the stale row is still in QF_TILE_ORDER until Bob saves again, and is never shown
    expect(db.tileOrder.has(`u-bob|${shared.id}`)).toBe(true);
    await saveOrder(b, [mine.id]);
    expect(db.tileOrder.has(`u-bob|${shared.id}`)).toBe(false);
    // re-sharing does not resurrect a pruned position: it lands after ordered tiles
    await share(a, shared.id, [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }]);
    const back = await list(b);
    expect(back.shared.map((x) => x.tilePos)).toEqual([null]);
  });

  it('honours group shares: a group member can order, and loses it with the group', async () => {
    const app = build().app;
    const a = await login(app);
    const c = await login(app, 'carol');
    const fin = await newReport(a, 'Finance pack');
    const own = await newReport(c, 'Carol own');
    await share(a, fin.id, [{ type: 'GROUP', id: 'finance', role: 'VIEWER' }]);
    expect((await saveOrder(c, [fin.id, own.id])).body.reportIds).toEqual([fin.id, own.id]);
    expect(names((await list(c)).shared)).toEqual(['Finance pack']);
    db.userGroups.delete('u-carol|finance');
    const l = await list(c);
    expect(l.shared).toEqual([]);
    expect(names(l.reports)).toEqual(['Carol own']);
    expect((await saveOrder(c, [fin.id, own.id])).body.reportIds).toEqual([own.id]);
  });

  it('lets a global admin order every report, still only ones that exist', async () => {
    const app = build().app;
    const a = await login(app);
    const root = await login(app, 'root');
    const r1 = await newReport(a, 'Alice one');
    const r2 = await newReport(a, 'Alice two');
    const res = await saveOrder(root, [r2.id, MISSING, r1.id]);
    expect(res.body.reportIds).toEqual([r2.id, r1.id]);
    expect(names((await list(root)).shared)).toEqual(['Alice two', 'Alice one']);
    // the admin's order does not change Alice's view
    expect(names((await list(a)).reports)).toEqual(['Alice one', 'Alice two']);
  });

  it('removes order rows when the report is deleted', async () => {
    const a = await login(build().app);
    const r = await newReport(a, 'Revenue');
    await saveOrder(a, [r.id]);
    expect(db.tileOrder.size).toBe(1);
    expect((await a.send('delete', `/api/reports/${r.id}`)).status).toBe(204);
    expect(db.tileOrder.size).toBe(0);
  });

  it('scopes every statement by user and binds every value as a parameter', async () => {
    const a = await login(build().app);
    const r = await newReport(a, 'Revenue');
    db.statements = [];
    await saveOrder(a, [r.id]);
    await list(a);
    await a.send('delete', '/api/dashboard/tile-order');
    const mine = db.statements.filter((s) => /QF_TILE_ORDER/.test(s.sql));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    for (const s of mine) {
      expect(s.params).toContain('u-alice');
      expect(s.sql).not.toContain('u-alice');
      expect(s.sql).not.toContain(r.id);
    }
  });
});
