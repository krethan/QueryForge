import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PROTECTED_METADATA_OBJECTS } from '../src/db/schema.js';
import { loadMigrations } from '../scripts/migrate.js';
import { folderSkipReason, maxRole, minRole } from '../src/sharing/folder-report-grants.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// Sharing the reports in a shared folder (migration 011). Fakes only: no IBM i is involved.
const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT N FROM SALESLIB.NUMS';

let db: FakeMetadataDb;
let app: ReturnType<typeof createApp>['app'];
async function login(username: string) {
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
type Role = 'VIEWER' | 'EDITOR';
interface Listed {
  id: string;
  access: string;
  viaFolder?: boolean;
}

const newReport = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/reports').send({ name, sql: SQL });
  expect(res.status).toBe(201);
  return res.body.report as { id: string; name: string };
};
const newFolder = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string };
};
const shareReport = (c: Client, id: string, shares: unknown[]) =>
  c.send('put', `/api/reports/${id}/shares`).send({ shares });
const shareFolder = (c: Client, id: string, shares: unknown[], shareReports?: Role | null) =>
  c
    .send('put', `/api/folders/${id}/shares`)
    .send(shareReports === undefined ? { shares } : { shares, shareReports });
const file = (c: Client, reportId: string, folderId: string | null) =>
  c.send('put', `/api/reports/${reportId}/prefs`).send({ folderId });
const addTo = (c: Client, folderId: string, reportId: string) =>
  c.send('post', `/api/folders/${folderId}/reports`).send({ reportId });
const removeFrom = (c: Client, folderId: string, reportId: string) =>
  c.send('delete', `/api/folders/${folderId}/reports/${reportId}`);
const sharedList = async (c: Client) =>
  ((await c.agent.get('/api/reports')).body.shared as Listed[]).map((x) => ({
    id: x.id,
    access: x.access,
    viaFolder: x.viaFolder ?? false,
  }));
const accessTo = async (c: Client, id: string) => {
  const r = await c.agent.get(`/api/reports/${id}`);
  return r.status === 200 ? (r.body.report?.access ?? r.body.access ?? 'OK') : r.status;
};
const roleOn = async (c: Client, id: string) =>
  (await sharedList(c)).find((x) => x.id === id)?.access ?? null;
const canEdit = async (c: Client, id: string) =>
  (await c.send('put', `/api/reports/${id}`).send({ name: `Renamed ${id.slice(0, 4)}`, sql: SQL }))
    .status;
const USER = (id: string, role: Role = 'VIEWER') => ({ type: 'USER', id, role });

let alice: Client;
let bob: Client;
let carol: Client;
let dave: Client;
let admin: Client;

beforeEach(async () => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-carol', username: 'carol', hash, displayName: 'Carol' });
  db.addUser({ id: 'u-dave', username: 'dave', hash, displayName: 'Dave' });
  db.addUser({ id: 'u-admin', username: 'admin', hash, displayName: 'Ada Admin', role: 'ADMIN' });
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  app = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
  alice = await login('alice');
  bob = await login('bob');
  carol = await login('carol');
  dave = await login('dave');
  admin = await login('admin');
});

/** Alice's folder "Finance" with two of her own reports filed in it. */
async function aliceFolder() {
  const f = await newFolder(alice, 'Finance');
  const a1 = await newReport(alice, 'Alpha');
  const a2 = await newReport(alice, 'Beta');
  await file(alice, a1.id, f.id);
  await file(alice, a2.id, f.id);
  return { f, a1, a2 };
}

describe('migration 011: folder report sharing', () => {
  const migs = loadMigrations('QFMETA');
  const m = migs.find((x) => x.version === 11)!;
  const sql = m.statements.join('\n');
  it('comes after 010 and only adds one QF_ table', () => {
    expect(migs.map((x) => x.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(m.statements.filter((x) => /^CREATE TABLE/.test(x))).toHaveLength(1);
    expect(sql).toContain('CREATE TABLE QFMETA.QF_FOLDER_REPORT_SHARING');
    for (const st of m.statements) expect(st).toMatch(/^(CREATE TABLE|LABEL ON)/);
    expect(sql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE FROM|INSERT)\b/);
    expect(sql).not.toContain('{{SCHEMA}}');
  });
  it('is keyed by folder, cascades with it, and allows only Viewer or Editor', () => {
    expect(sql).toMatch(/CONSTRAINT QF_FRSH_PK PRIMARY KEY \(FOLDER_ID\)/);
    expect(sql).toMatch(
      /FOREIGN KEY \(FOLDER_ID\) REFERENCES QFMETA\.QF_FOLDERS \(FOLDER_ID\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(/CHECK \(MAX_ROLE IN \('VIEWER', 'EDITOR'\)\)/);
    // never touches report shares: folder access is computed, not copied
    expect(sql).not.toMatch(/QF_REPORT_SHARES \(/);
  });
  it('keeps the new table out of reach of reporting SQL', () => {
    expect(PROTECTED_METADATA_OBJECTS).toContain('QF_FOLDER_REPORT_SHARING');
  });
});

describe('folder report sharing rules', () => {
  it('ranks roles and explains skipped reports', () => {
    expect(minRole('EDITOR', 'VIEWER')).toBe('VIEWER');
    expect(minRole('EDITOR', 'EDITOR')).toBe('EDITOR');
    expect(maxRole(null, 'VIEWER')).toBe('VIEWER');
    expect(maxRole('EDITOR', 'VIEWER')).toBe('EDITOR');
    const m = { reportOwnerId: 'o', viaOwnerPref: false, addedBy: 'o' };
    expect(folderSkipReason('o', m)).toBeNull();
    expect(folderSkipReason('o', { ...m, addedBy: null, viaOwnerPref: true })).toBeNull();
    expect(folderSkipReason('o', { ...m, reportOwnerId: 'x' })).toBe('NOT_OWNER');
    expect(folderSkipReason('o', { ...m, addedBy: 'e' })).toBe('ADDED_BY_OTHER');
  });
});

describe('sharing the reports in a shared folder', () => {
  it('is off by default: existing folder shares keep their behaviour', async () => {
    const { f, a1 } = await aliceFolder();
    expect((await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')])).status).toBe(200);
    expect(await sharedList(bob)).toEqual([]);
    expect(await accessTo(bob, a1.id)).toBe(404);
    const folder = (await bob.agent.get(`/api/folders/${f.id}`)).body.folder;
    expect(folder).toMatchObject({ shareReports: null, reportIds: [] });
    expect(db.folderReportSharing.size).toBe(0);
    expect(db.shares).toHaveLength(0);
  });

  it('when the owner opts in, folder recipients can open the owner’s reports in it', async () => {
    const { f, a1, a2 } = await aliceFolder();
    const res = await shareFolder(alice, f.id, [USER('u-bob')], 'EDITOR');
    expect(res.status).toBe(200);
    expect(res.body.shareReports).toBe('EDITOR');
    expect(res.body.reports.included.map((x: { id: string }) => x.id).sort()).toEqual(
      [a1.id, a2.id].sort(),
    );
    expect(res.body.reports.skipped).toEqual([]);
    expect(await sharedList(bob)).toEqual([
      { id: a1.id, access: 'VIEWER', viaFolder: true },
      { id: a2.id, access: 'VIEWER', viaFolder: true },
    ]);
    expect((await bob.agent.get(`/api/folders/${f.id}`)).body.folder).toMatchObject({
      shareReports: 'EDITOR',
      reportIds: [a1.id, a2.id],
    });
    expect((await bob.send('post', `/api/reports/${a1.id}/execute`).send({})).status).toBe(200);
    // nobody else gained anything, and no report share rows were written
    expect(await sharedList(carol)).toEqual([]);
    expect(await accessTo(carol, a1.id)).toBe(404);
    expect(db.shares).toHaveLength(0);
  });

  it('grants no more than the folder share role, capped by the owner’s choice', async () => {
    const { f, a1 } = await aliceFolder();
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), USER('u-carol', 'VIEWER')], 'EDITOR');
    expect(await roleOn(bob, a1.id)).toBe('EDITOR');
    expect(await roleOn(carol, a1.id)).toBe('VIEWER');
    expect(await canEdit(bob, a1.id)).toBe(200);
    expect(await canEdit(carol, a1.id)).toBe(403);
    // "view only": even folder editors only view the reports
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), USER('u-carol', 'VIEWER')], 'VIEWER');
    expect(await roleOn(bob, a1.id)).toBe('VIEWER');
    expect(await canEdit(bob, a1.id)).toBe(403);
  });

  it('never lets a recipient share, delete or see the shares of a report they got through a folder', async () => {
    const { f, a1 } = await aliceFolder();
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR');
    expect((await shareReport(bob, a1.id, [USER('u-carol')])).status).toBe(403);
    expect((await bob.agent.get(`/api/reports/${a1.id}/shares`)).status).toBe(403);
    expect((await bob.send('delete', `/api/reports/${a1.id}`)).status).toBe(403);
    expect(db.reports.has(a1.id)).toBe(true);
  });

  it('works for group shares of the folder', async () => {
    const { f, a1 } = await aliceFolder();
    db.addGroup('u-dave', 'ops');
    await shareFolder(alice, f.id, [{ type: 'GROUP', id: 'ops', role: 'EDITOR' }], 'EDITOR');
    expect((await sharedList(dave)).map((x) => [x.id, x.access])).toContainEqual([a1.id, 'EDITOR']);
    db.removeGroup('u-dave', 'ops');
    expect(await sharedList(dave)).toEqual([]);
    expect(await accessTo(dave, a1.id)).toBe(404);
  });

  it('skips reports the folder owner cannot share and says so, without failing the share', async () => {
    const { f, a1 } = await aliceFolder();
    // Carol's report, shared with Alice as Editor, filed by Alice in her folder
    const c1 = await newReport(carol, 'Carol data');
    await shareReport(carol, c1.id, [USER('u-alice', 'EDITOR')]);
    await file(alice, c1.id, f.id);
    const res = await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR');
    expect(res.status).toBe(200);
    expect(res.body.reports.skipped).toEqual([
      { id: c1.id, name: 'Carol data', ownerName: 'Carol', reason: 'NOT_OWNER' },
    ]);
    expect(res.body.reports.included.map((x: { id: string }) => x.id)).toContain(a1.id);
    // Bob can open Alice's reports but not Carol's, and the folder still hides it from him
    expect((await sharedList(bob)).map((x) => x.id)).not.toContain(c1.id);
    expect(await accessTo(bob, c1.id)).toBe(404);
    expect((await bob.agent.get(`/api/folders/${f.id}`)).body.folder.reportIds).not.toContain(
      c1.id,
    );
    // GET returns the same picture for the owner
    const g = await alice.agent.get(`/api/folders/${f.id}/shares`);
    expect(g.body).toMatchObject({ shareReports: 'EDITOR' });
    expect(g.body.reports.skipped.map((x: { id: string }) => x.id)).toEqual([c1.id]);
  });

  it('does not let a folder editor widen access to the owner’s reports by adding them', async () => {
    const f = await newFolder(alice, 'Finance');
    const secret = await newReport(alice, 'Secret');
    // Bob may view Alice's "Secret" and edits her folder; Carol is a folder viewer
    await shareReport(alice, secret.id, [USER('u-bob')]);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), USER('u-carol')], 'VIEWER');
    expect((await addTo(bob, f.id, secret.id)).status).toBe(200);
    expect(await accessTo(carol, secret.id)).toBe(404);
    const g = await alice.agent.get(`/api/folders/${f.id}/shares`);
    expect(g.body.reports.skipped).toEqual([
      { id: secret.id, name: 'Secret', ownerName: 'Alice', reason: 'ADDED_BY_OTHER' },
    ]);
    // the owner confirms it by adding it herself; now it is shared through the folder
    expect((await addTo(alice, f.id, secret.id)).status).toBe(200);
    expect(db.folderReports.get(`${f.id}|${secret.id}`)!.ADDED_BY).toBe('u-alice');
    expect(await sharedList(carol)).toEqual([{ id: secret.id, access: 'VIEWER', viaFolder: true }]);
  });

  it('does not let an editor re-share their own or anyone else’s report through the owner’s folder', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), USER('u-carol')], 'EDITOR');
    const bobs = await newReport(bob, 'Bob report');
    await addTo(bob, f.id, bobs.id);
    // even the folder owner adding it herself cannot share a report she does not own
    await shareReport(bob, bobs.id, [USER('u-alice', 'EDITOR')]);
    await addTo(alice, f.id, bobs.id);
    expect(await accessTo(carol, bobs.id)).toBe(404);
    expect((await sharedList(carol)).map((x) => x.id)).not.toContain(bobs.id);
  });

  it('keeps a stronger direct share, and upgrades a weaker one only while the folder grants it', async () => {
    const { f, a1, a2 } = await aliceFolder();
    await shareReport(alice, a1.id, [USER('u-bob', 'EDITOR')]);
    await shareReport(alice, a2.id, [USER('u-bob', 'VIEWER')]);
    await shareFolder(alice, f.id, [USER('u-bob', 'VIEWER')], 'EDITOR');
    expect(await sharedList(bob)).toEqual([
      { id: a1.id, access: 'EDITOR', viaFolder: false },
      { id: a2.id, access: 'VIEWER', viaFolder: false },
    ]);
    expect(await canEdit(bob, a1.id)).toBe(200);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')]);
    expect((await sharedList(bob)).find((x) => x.id === a2.id)).toEqual({
      id: a2.id,
      access: 'EDITOR',
      viaFolder: true,
    });
    // revoking the folder share leaves the direct shares exactly as they were
    await shareFolder(alice, f.id, []);
    expect(await sharedList(bob)).toEqual(
      expect.arrayContaining([
        { id: a1.id, access: 'EDITOR', viaFolder: false },
        { id: a2.id, access: 'VIEWER', viaFolder: false },
      ]),
    );
    expect(await sharedList(bob)).toHaveLength(2);
    expect(db.shares.map((s) => [s.REPORT_ID, s.SHARE_ROLE]).sort()).toEqual(
      [
        [a1.id, 'EDITOR'],
        [a2.id, 'VIEWER'],
      ].sort(),
    );
  });

  it('shares reports added later and drops reports taken out of the folder', async () => {
    const { f, a1 } = await aliceFolder();
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    const later = await newReport(alice, 'Gamma');
    expect(await accessTo(bob, later.id)).toBe(404);
    await addTo(alice, f.id, later.id);
    expect((await sharedList(bob)).map((x) => x.id)).toContain(later.id);
    // Move to another (unshared) folder: access through the folder ends
    const other = await newFolder(alice, 'Private');
    await file(alice, later.id, other.id);
    expect(await accessTo(bob, later.id)).toBe(404);
    // Remove from folder (by a folder editor too): access ends
    await file(alice, later.id, f.id);
    expect((await sharedList(bob)).map((x) => x.id)).toContain(later.id);
    await shareFolder(alice, f.id, [USER('u-bob'), USER('u-carol', 'EDITOR')], 'VIEWER');
    expect((await removeFrom(carol, f.id, later.id)).status).toBe(200);
    expect(await accessTo(bob, later.id)).toBe(404);
    expect((await sharedList(bob)).map((x) => x.id)).toEqual([a1.id, expect.any(String)]);
  });

  it('an editor reordering the folder does not change which reports it shares', async () => {
    const { f, a1, a2 } = await aliceFolder();
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), USER('u-carol')], 'VIEWER');
    const bobs = await newReport(bob, 'Bob report');
    await addTo(bob, f.id, bobs.id);
    const before = await alice.agent.get(`/api/folders/${f.id}/shares`);
    expect(
      (
        await bob
          .send('put', `/api/folders/${f.id}/order`)
          .send({ reportIds: [a2.id, bobs.id, a1.id] })
      ).status,
    ).toBe(200);
    const after = await alice.agent.get(`/api/folders/${f.id}/shares`);
    const ids = (r: typeof before) =>
      r.body.reports.included.map((x: { id: string }) => x.id).sort();
    expect(ids(after)).toEqual(ids(before));
    expect(ids(after)).toEqual([a1.id, a2.id].sort());
    // Bob's own report is hidden from Alice, so it is not even listed as skipped
    expect(after.body.reports.skipped).toEqual([]);
    expect((await sharedList(carol)).map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
  });

  it('removing a report from the folder never removes an independent report share', async () => {
    const { f, a1 } = await aliceFolder();
    await shareReport(alice, a1.id, [USER('u-bob')]);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR');
    expect((await sharedList(bob)).find((x) => x.id === a1.id)!.access).toBe('EDITOR');
    await removeFrom(alice, f.id, a1.id);
    expect((await sharedList(bob)).find((x) => x.id === a1.id)).toEqual({
      id: a1.id,
      access: 'VIEWER',
      viaFolder: false,
    });
  });

  it('turning the option off, revoking the folder share or deleting the folder ends folder access', async () => {
    const { f, a1 } = await aliceFolder();
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    expect(await sharedList(bob)).toHaveLength(2);
    // omitting shareReports leaves it as it is
    await shareFolder(alice, f.id, [USER('u-bob'), USER('u-carol')]);
    expect(await sharedList(carol)).toHaveLength(2);
    await shareFolder(alice, f.id, [USER('u-bob'), USER('u-carol')], null);
    expect(await sharedList(bob)).toEqual([]);
    expect(await accessTo(bob, a1.id)).toBe(404);
    expect(db.folderReportSharing.size).toBe(0);
    await shareFolder(alice, f.id, [USER('u-bob'), USER('u-carol')], 'VIEWER');
    await shareFolder(alice, f.id, [USER('u-carol')]);
    expect(await sharedList(bob)).toEqual([]);
    expect(await sharedList(carol)).toHaveLength(2);
    expect((await alice.send('delete', `/api/folders/${f.id}`)).status).toBe(200);
    expect(await sharedList(carol)).toEqual([]);
    expect(db.folderReportSharing.size).toBe(0);
    expect(db.reports.has(a1.id)).toBe(true);
  });

  it('only the folder owner can turn it on; others get 403 or 404 and nothing changes', async () => {
    const { f } = await aliceFolder();
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')]);
    expect((await shareFolder(bob, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR')).status).toBe(403);
    expect((await shareFolder(admin, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR')).status).toBe(403);
    expect((await shareFolder(carol, f.id, [], 'EDITOR')).status).toBe(404);
    expect((await carol.agent.get(`/api/folders/${f.id}/shares`)).status).toBe(404);
    expect((await bob.agent.get(`/api/folders/${f.id}/shares`)).status).toBe(403);
    expect(db.folderReportSharing.size).toBe(0);
    expect(await sharedList(bob)).toEqual([]);
  });

  it('rejects invalid options and rolls back the whole change', async () => {
    const { f } = await aliceFolder();
    for (const shareReports of ['OWNER', 'ADMIN', 'yes', 1])
      expect(
        (await alice.send('put', `/api/folders/${f.id}/shares`).send({ shares: [], shareReports }))
          .status,
      ).toBe(400);
    // a bad share in the same request leaves the option off too
    expect((await shareFolder(alice, f.id, [USER('u-nobody')], 'VIEWER')).status).toBe(400);
    expect(db.folderReportSharing.size).toBe(0);
    expect(db.folderShares).toHaveLength(0);
  });

  it('shows the owner who reaches a report through folders', async () => {
    const { f, a1 } = await aliceFolder();
    db.addGroup('u-dave', 'ops');
    await shareFolder(
      alice,
      f.id,
      [USER('u-bob', 'EDITOR'), { type: 'GROUP', id: 'ops', role: 'VIEWER' }],
      'EDITOR',
    );
    const r = await alice.agent.get(`/api/reports/${a1.id}/shares`);
    expect(r.status).toBe(200);
    expect(r.body.shares).toEqual([]);
    expect(r.body.folderGrants).toEqual([
      {
        folderId: f.id,
        folderName: 'Finance',
        type: 'GROUP',
        id: 'ops',
        role: 'VIEWER',
      },
      {
        folderId: f.id,
        folderName: 'Finance',
        type: 'USER',
        id: 'u-bob',
        role: 'EDITOR',
        displayName: 'Bob',
      },
    ]);
    const audit = await alice.agent.get(`/api/reports/${a1.id}/access`);
    expect(audit.body.folderGrants).toHaveLength(2);
  });

  it('a personal (unshared) folder shares nothing even with the option on, and admins are unaffected', async () => {
    const { f, a1 } = await aliceFolder();
    await shareFolder(alice, f.id, [], 'EDITOR');
    expect(db.folderReportSharing.size).toBe(1);
    expect(await sharedList(bob)).toEqual([]);
    // admins see every report as Admin anyway; the folder stays private
    expect(await accessTo(admin, a1.id)).not.toBe(404);
    expect((await admin.agent.get(`/api/folders/${f.id}`)).status).toBe(404);
  });

  it('folder-granted people count as schedule recipients and see the report’s schedules', async () => {
    const { f, a1 } = await aliceFolder();
    db.setEmail('u-alice', 'alice@example.com');
    db.setEmail('u-bob', 'bob@example.com');
    db.setEmail('u-dave', 'dave@example.com');
    db.setEmail('u-carol', 'carol@example.com');
    db.addGroup('u-dave', 'ops');
    await shareFolder(
      alice,
      f.id,
      [USER('u-bob', 'EDITOR'), { type: 'GROUP', id: 'ops', role: 'VIEWER' }],
      'EDITOR',
    );
    const r = await alice.agent.get(`/api/reports/${a1.id}/schedule-recipients`);
    expect(r.status).toBe(200);
    expect(r.body.recipients.map((x: { email: string }) => x.email)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'dave@example.com',
    ]);
    // Bob (Editor through the folder) can manage the report's schedules
    expect((await bob.agent.get(`/api/reports/${a1.id}/schedules`)).status).toBe(200);
    db.schedules.set('s-1', {
      SCHEDULE_ID: 's-1',
      REPORT_ID: a1.id,
      CREATED_BY: 'u-alice',
      CRON_EXPR: '0 7 * * *',
      TIMEZONE: 'UTC',
      RECIPIENTS: 'alice@example.com',
      PARAMS_JSON: null,
      IS_ENABLED: 0,
      NEXT_RUN_AT: null,
      LAST_RUN_AT: null,
      LAST_STATUS: 'NEVER',
      LAST_ERROR: null,
      FAILURE_COUNT: 0,
      VERSION: 1,
      CREATED_AT: '2026-10-23 12:00:00.000000',
    });
    const mine = async (c: Client) =>
      ((await c.agent.get('/api/schedules')).body.schedules as { id: string }[]).map((s) => s.id);
    expect(await mine(bob)).toEqual(['s-1']);
    expect(await mine(dave)).toEqual(['s-1']);
    expect(await mine(carol)).toEqual([]);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], null);
    expect(await mine(bob)).toEqual([]);
  });

  it('binds every value as a parameter in the folder report sharing SQL', async () => {
    const { f, a1 } = await aliceFolder();
    db.addGroup('u-bob', 'finance.team');
    db.statements = [];
    await shareFolder(
      alice,
      f.id,
      [{ type: 'GROUP', id: 'finance.team', role: 'EDITOR' }],
      'EDITOR',
    );
    expect((await sharedList(bob)).map((x) => x.id)).toContain(a1.id);
    expect(await accessTo(bob, a1.id)).not.toBe(404);
    const sql = db.statements.filter((s) => /QF_FOLDER_REPORT_SHARING/.test(s.sql));
    expect(sql.length).toBeGreaterThan(2);
    for (const s of sql) {
      expect(s.sql).not.toContain(f.id);
      expect(s.sql).not.toContain(a1.id);
      expect(s.sql).not.toContain('u-bob');
      expect(s.sql).not.toContain('finance.team');
    }
  });
});
