import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PROTECTED_METADATA_OBJECTS } from '../src/db/schema.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT N FROM SALESLIB.NUMS';

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
const newReport = async (c: Client, name: string) =>
  (await c.send('post', '/api/reports').send({ name, sql: SQL })).body.report as { id: string };
const newFolder = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string; name: string };
};
const listReports = async (c: Client) =>
  (await c.agent.get('/api/reports')).body as {
    reports: { id: string; name: string; folderId: string | null; favorite: boolean }[];
    shared: { id: string; name: string; folderId: string | null; favorite: boolean }[];
  };

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
});

describe('migration 006: folders and favorites', () => {
  const migs = loadMigrations('QFMETA');
  const m6 = migs.find((m) => m.version === 6)!;
  const sql = m6.statements.join('\n');
  it('comes after 005 and creates the QF_ tables in the metadata schema', () => {
    expect(migs.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(sql).toContain('CREATE TABLE QFMETA.QF_FOLDERS');
    expect(sql).toContain('CREATE TABLE QFMETA.QF_REPORT_PREFS');
    expect(sql).not.toContain('{{SCHEMA}}');
  });
  it('makes folder names unique per user and keys preferences by user and report', () => {
    expect(sql).toMatch(/UNIQUE\s*\(\s*OWNER_ID\s*,\s*FOLDER_NAME_KEY\s*\)/);
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*USER_ID\s*,\s*REPORT_ID\s*\)/);
  });
  it('moves reports to Unfiled when a folder is deleted, never deleting reports', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(FOLDER_ID\) REFERENCES QFMETA\.QF_FOLDERS \(FOLDER_ID\) ON DELETE SET NULL/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(REPORT_ID\) REFERENCES QFMETA\.QF_REPORTS \(REPORT_ID\) ON DELETE CASCADE/,
    );
    expect(sql).not.toMatch(/REFERENCES QFMETA\.QF_REPORT_PREFS/);
    expect(sql).toMatch(/CHECK \(IS_FAVORITE IN \(0, 1\)\)/);
  });
  it('keeps the new tables out of reach of reporting SQL', () => {
    expect(PROTECTED_METADATA_OBJECTS).toEqual(
      expect.arrayContaining(['QF_FOLDERS', 'QF_REPORT_PREFS']),
    );
  });
});

describe('folder routes', () => {
  it('creates, lists, renames and deletes folders', async () => {
    const a = await login(build().app);
    const f = await newFolder(a, '  Finance  ');
    expect(f.name).toBe('Finance');
    await newFolder(a, 'Archive');
    expect(
      (await a.agent.get('/api/folders')).body.folders.map((x: { name: string }) => x.name),
    ).toEqual(['Archive', 'Finance']);
    const ren = await a.send('put', `/api/folders/${f.id}`).send({ name: 'Money' });
    expect(ren.status).toBe(200);
    expect(ren.body.folder).toMatchObject({ id: f.id, name: 'Money' });
    const del = await a.send('delete', `/api/folders/${f.id}`);
    expect(del.status).toBe(200);
    expect((await a.agent.get('/api/folders')).body.folders).toHaveLength(1);
  });

  it('rejects duplicate (case-insensitive), empty and reserved names', async () => {
    const a = await login(build().app);
    const f = await newFolder(a, 'Finance');
    expect((await a.send('post', '/api/folders').send({ name: 'FINANCE' })).status).toBe(409);
    expect((await a.send('post', '/api/folders').send({ name: '   ' })).status).toBe(400);
    expect((await a.send('post', '/api/folders').send({ name: 'Unfiled' })).status).toBe(400);
    expect((await a.send('post', '/api/folders').send({ name: 'x'.repeat(129) })).status).toBe(400);
    const g = await newFolder(a, 'Ops');
    expect((await a.send('put', `/api/folders/${g.id}`).send({ name: 'finance' })).status).toBe(
      409,
    );
    expect((await a.send('put', `/api/folders/${f.id}`).send({ name: 'finance' })).status).toBe(
      200,
    ); // same folder
  });

  it('lets two users have folders with the same name', async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    await newFolder(a, 'Finance');
    await newFolder(b, 'Finance');
    expect((await b.agent.get('/api/folders')).body.folders).toHaveLength(1);
  });

  it('deleting a folder moves its reports to Unfiled and keeps the reports', async () => {
    const a = await login(build().app);
    const f = await newFolder(a, 'Finance');
    const r1 = await newReport(a, 'Revenue');
    const r2 = await newReport(a, 'Costs');
    await a.send('put', `/api/reports/${r1.id}/prefs`).send({ folderId: f.id, favorite: true });
    await a.send('put', `/api/reports/${r2.id}/prefs`).send({ folderId: f.id });
    const del = await a.send('delete', `/api/folders/${f.id}`);
    expect(del.body).toEqual({ moved: 2 });
    const list = await listReports(a);
    expect(list.reports.map((x) => x.name).sort()).toEqual(['Costs', 'Revenue']);
    expect(list.reports.every((x) => x.folderId === null)).toBe(true);
    expect(list.reports.find((x) => x.id === r1.id)!.favorite).toBe(true); // star survives
    expect(db.reports.size).toBe(2);
  });
});

describe('favorites and moving reports', () => {
  it('stars, unstars and files a report, reported back on the dashboard list', async () => {
    const a = await login(build().app);
    const f = await newFolder(a, 'Finance');
    const r = await newReport(a, 'Revenue');
    expect((await listReports(a)).reports[0]).toMatchObject({ folderId: null, favorite: false });
    const star = await a.send('put', `/api/reports/${r.id}/prefs`).send({ favorite: true });
    expect(star.body.prefs).toEqual({ folderId: null, favorite: true });
    const move = await a.send('put', `/api/reports/${r.id}/prefs`).send({ folderId: f.id });
    expect(move.body.prefs).toEqual({ folderId: f.id, favorite: true });
    expect((await listReports(a)).reports[0]).toMatchObject({ folderId: f.id, favorite: true });
    await a.send('put', `/api/reports/${r.id}/prefs`).send({ favorite: false, folderId: null });
    expect((await listReports(a)).reports[0]).toMatchObject({ folderId: null, favorite: false });
    expect(db.reportPrefs.size).toBe(0); // no empty rows left behind
  });

  it('validates the body', async () => {
    const a = await login(build().app);
    const r = await newReport(a, 'Revenue');
    const put = (body: unknown) => a.send('put', `/api/reports/${r.id}/prefs`).send(body as object);
    expect((await put({})).status).toBe(400);
    expect((await put({ favorite: 'yes' })).status).toBe(400);
    expect((await put({ folderId: 'not-a-uuid' })).status).toBe(400);
    expect((await put({ favorite: true, ownerId: 'u-bob' })).status).toBe(400);
  });

  it('removes preferences when the report is deleted', async () => {
    const a = await login(build().app);
    const r = await newReport(a, 'Revenue');
    await a.send('put', `/api/reports/${r.id}/prefs`).send({ favorite: true });
    expect(db.reportPrefs.size).toBe(1);
    expect((await a.send('delete', `/api/reports/${r.id}`)).status).toBe(204);
    expect(db.reportPrefs.size).toBe(0);
  });
});

describe('access checks: folders and favorites belong to the viewing user', () => {
  it("cannot rename, delete or file into another user's folder", async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    const af = await newFolder(a, 'Alice private');
    const br = await newReport(b, 'Bob report');
    expect((await b.send('put', `/api/folders/${af.id}`).send({ name: 'Hacked' })).status).toBe(
      404,
    );
    expect((await b.send('delete', `/api/folders/${af.id}`)).status).toBe(404);
    expect(
      (await b.send('put', `/api/reports/${br.id}/prefs`).send({ folderId: af.id })).status,
    ).toBe(404);
    expect((await a.agent.get('/api/folders')).body.folders).toEqual([
      expect.objectContaining({ id: af.id, name: 'Alice private' }),
    ]);
    expect((await b.agent.get('/api/folders')).body.folders).toEqual([]);
    expect(db.reportPrefs.size).toBe(0);
  });

  it('cannot star or file a report the user cannot see', async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    const ar = await newReport(a, 'Alice only');
    const bf = await newFolder(b, 'Mine');
    expect(
      (await b.send('put', `/api/reports/${ar.id}/prefs`).send({ favorite: true })).status,
    ).toBe(404);
    expect(
      (await b.send('put', `/api/reports/${ar.id}/prefs`).send({ folderId: bf.id })).status,
    ).toBe(404);
    expect(db.reportPrefs.size).toBe(0);
  });

  it('a shared report can be starred and filed separately by each user', async () => {
    const app = build().app;
    const a = await login(app);
    const b = await login(app, 'bob');
    const r = await newReport(a, 'Shared revenue');
    await a
      .send('put', `/api/reports/${r.id}/shares`)
      .send({ shares: [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }] });
    const bf = await newFolder(b, 'From Alice');
    const res = await b
      .send('put', `/api/reports/${r.id}/prefs`)
      .send({ folderId: bf.id, favorite: true });
    expect(res.status).toBe(200); // viewer access is enough for one's own view
    expect((await listReports(b)).shared[0]).toMatchObject({
      id: r.id,
      folderId: bf.id,
      favorite: true,
    });
    expect((await listReports(a)).reports[0]).toMatchObject({
      id: r.id,
      folderId: null,
      favorite: false,
    });
    // when access is revoked the report (and its stale preference) disappear from Bob's list
    await a.send('put', `/api/reports/${r.id}/shares`).send({ shares: [] });
    expect((await listReports(b)).shared).toEqual([]);
  });

  it('scopes every statement by user and binds every value as a parameter', async () => {
    const a = await login(build().app);
    db.statements = [];
    const f = await newFolder(a, "O'Brien; DROP TABLE X");
    const r = await newReport(a, 'Revenue');
    await a.send('put', `/api/reports/${r.id}/prefs`).send({ folderId: f.id, favorite: true });
    await a.send('put', `/api/folders/${f.id}`).send({ name: 'Renamed folder' });
    await a.send('delete', `/api/folders/${f.id}`);
    // Personal folder statements are scoped by user. The shared-folder layer (009) looks
    // folders up by ID and authorises in FolderAccessService; shared-folders.test.ts covers it.
    const sharedLayer = /QF_FOLDER_SHARES|QF_FOLDER_REPORTS|WHERE FOLDER_ID = \?$|P\.FOLDER_ID IN/;
    const mine = db.statements.filter(
      (s) => /QF_FOLDERS|QF_REPORT_PREFS/.test(s.sql) && !sharedLayer.test(s.sql.trim()),
    );
    expect(mine.length).toBeGreaterThan(5);
    for (const s of mine) {
      expect(s.params).toContain('u-alice');
      expect(s.sql).not.toContain("O'Brien");
      expect(s.sql).not.toContain('u-alice');
    }
  });
});
