import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PROTECTED_METADATA_OBJECTS } from '../src/db/schema.js';
import { loadMigrations } from '../scripts/migrate.js';
import { mergeVisibleOrder, sortMembers } from '../src/sharing/folder-access.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT N FROM SALESLIB.NUMS';

let db: FakeMetadataDb;
let app: ReturnType<typeof createApp>['app'];
function build() {
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  return createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
}
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
interface FolderView {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  access: string;
  shared: boolean;
  reportIds: string[];
}
const newReport = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/reports').send({ name, sql: SQL });
  expect(res.status).toBe(201);
  return res.body.report as { id: string };
};
const newFolder = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as FolderView;
};
const shareReport = (c: Client, id: string, shares: unknown[]) =>
  c.send('put', `/api/reports/${id}/shares`).send({ shares });
const shareFolder = (c: Client, id: string, shares: unknown[]) =>
  c.send('put', `/api/folders/${id}/shares`).send({ shares });
const file = (c: Client, reportId: string, folderId: string | null) =>
  c.send('put', `/api/reports/${reportId}/prefs`).send({ folderId });
const folders = async (c: Client) =>
  (await c.agent.get('/api/folders')).body.folders as FolderView[];
const folderOf = async (c: Client, id: string) => (await folders(c)).find((f) => f.id === id);
const BOB = (role = 'VIEWER') => ({ type: 'USER', id: 'u-bob', role });

let alice: Client;
let bob: Client;
let carol: Client;
let admin: Client;

beforeEach(async () => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-carol', username: 'carol', hash, displayName: 'Carol' });
  db.addUser({ id: 'u-admin', username: 'admin', hash, displayName: 'Ada Admin', role: 'ADMIN' });
  app = build();
  alice = await login('alice');
  bob = await login('bob');
  carol = await login('carol');
  admin = await login('admin');
});

describe('migration 009: shared folders', () => {
  const migs = loadMigrations('QFMETA');
  const m9 = migs.find((m) => m.version === 9)!;
  const sql = m9.statements.join('\n');
  it('comes after 008 and creates three new QF_ tables in the metadata schema', () => {
    expect(migs.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const t of ['QF_FOLDER_SHARES', 'QF_FOLDER_REPORTS', 'QF_FOLDER_SHARE_AUDIT'])
      expect(sql).toContain(`CREATE TABLE QFMETA.${t}`);
    expect(sql).not.toContain('{{SCHEMA}}');
  });
  it('is additive: only CREATE TABLE / CREATE INDEX / LABEL ON, nothing altered or dropped', () => {
    for (const st of m9.statements) expect(st).toMatch(/^(CREATE TABLE|CREATE INDEX|LABEL ON)/);
    expect(sql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE FROM|INSERT)\b/);
  });
  it('mirrors report sharing roles and principals', () => {
    expect(sql).toMatch(/PRIMARY KEY \(FOLDER_ID, PRINCIPAL_TYPE, PRINCIPAL_ID\)/);
    expect(sql).toMatch(/CHECK \(SHARE_ROLE IN \('VIEWER', 'EDITOR'\)\)/);
    expect(sql).toMatch(/CHECK \(PRINCIPAL_TYPE IN \('USER', 'GROUP'\)\)/);
  });
  it('never deletes a report: rows cascade away with the folder or the report, not the reverse', () => {
    expect(sql).toMatch(
      /QF_FSHR_FK_FOLDER FOREIGN KEY \(FOLDER_ID\) REFERENCES QFMETA\.QF_FOLDERS \(FOLDER_ID\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /QF_FRPT_FK_REPORT FOREIGN KEY \(REPORT_ID\) REFERENCES QFMETA\.QF_REPORTS \(REPORT_ID\) ON DELETE CASCADE/,
    );
    expect(sql).not.toMatch(/REFERENCES QFMETA\.QF_FOLDER_(SHARES|REPORTS)/);
    // the audit trail has no foreign keys so it survives the folder
    const audit = m9.statements.find((s) =>
      s.includes('CREATE TABLE QFMETA.QF_FOLDER_SHARE_AUDIT'),
    )!;
    expect(audit).not.toContain('FOREIGN KEY');
  });
  it('keeps the new tables out of reach of reporting SQL', () => {
    expect(PROTECTED_METADATA_OBJECTS).toEqual(
      expect.arrayContaining(['QF_FOLDER_SHARES', 'QF_FOLDER_REPORTS', 'QF_FOLDER_SHARE_AUDIT']),
    );
  });
});

describe('ordering helpers', () => {
  it('sorts positioned members first, then by name', () => {
    const m = (reportId: string, pos: number | null, nameKey: string) => ({
      reportId,
      pos,
      nameKey,
      viaOwnerPref: false,
      hasItem: true,
    });
    expect(
      sortMembers([m('a', null, 'ZED'), m('b', 1, 'B'), m('c', 0, 'C'), m('d', null, 'ALPHA')]).map(
        (x) => x.reportId,
      ),
    ).toEqual(['c', 'b', 'd', 'a']);
  });
  it('reorders only the visible slots and leaves hidden reports in place', () => {
    expect(mergeVisibleOrder(['a', 'H', 'b', 'c'], new Set(['a', 'b', 'c']), ['c', 'a'])).toEqual([
      'c',
      'H',
      'a',
      'b',
    ]);
  });
});

describe('personal folders stay personal until shared', () => {
  it('hides an unshared folder from other users and from admins (404, never 403)', async () => {
    const f = await newFolder(alice, 'Finance');
    expect(f).toMatchObject({ access: 'OWNER', shared: false, ownerName: 'Alice', reportIds: [] });
    for (const c of [bob, admin]) {
      expect(await folders(c)).toEqual([]);
      expect((await c.agent.get(`/api/folders/${f.id}`)).status).toBe(404);
      expect((await c.send('put', `/api/folders/${f.id}`).send({ name: 'X' })).status).toBe(404);
      expect((await c.send('delete', `/api/folders/${f.id}`)).status).toBe(404);
      expect((await c.agent.get(`/api/folders/${f.id}/shares`)).status).toBe(404);
      expect((await shareFolder(c, f.id, [])).status).toBe(404);
      expect(
        (await c.send('put', `/api/folders/${f.id}/order`).send({ reportIds: [] })).status,
      ).toBe(404);
    }
    const r = await newReport(bob, 'Bob report');
    expect(
      (await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: r.id })).status,
    ).toBe(404);
    expect(db.folderReports.size).toBe(0);
  });

  it('lists the owner’s filed reports as the folder contents, unchanged by 009', async () => {
    const f = await newFolder(alice, 'Finance');
    const r = await newReport(alice, 'Revenue');
    await file(alice, r.id, f.id);
    expect((await folderOf(alice, f.id))!.reportIds).toEqual([r.id]);
    const list = (await alice.agent.get('/api/reports')).body.reports;
    expect(list[0]).toMatchObject({ id: r.id, folderId: f.id });
  });
});

describe('sharing a folder', () => {
  async function aliceFolderWithReports() {
    const f = await newFolder(alice, 'Finance');
    const visible = await newReport(alice, 'Revenue');
    const hidden = await newReport(alice, 'Payroll');
    await shareReport(alice, visible.id, [BOB()]);
    await file(alice, visible.id, f.id);
    await file(alice, hidden.id, f.id);
    return { f, visible, hidden };
  }

  it('lets a viewer see the folder and only the reports in it they can already see', async () => {
    const { f, visible, hidden } = await aliceFolderWithReports();
    const res = await shareFolder(alice, f.id, [BOB()]);
    expect(res.status).toBe(200);
    expect(res.body.shares).toEqual([
      { type: 'USER', id: 'u-bob', role: 'VIEWER', displayName: 'Bob' },
    ]);
    expect((await folderOf(alice, f.id))!).toMatchObject({ shared: true });
    const seen = (await folderOf(bob, f.id))!;
    expect(seen).toMatchObject({
      name: 'Finance',
      ownerId: 'u-alice',
      ownerName: 'Alice',
      access: 'VIEWER',
      shared: true,
      reportIds: [visible.id],
    });
    expect(JSON.stringify(await folders(bob))).not.toContain(hidden.id);
    const one = await bob.agent.get(`/api/folders/${f.id}`);
    expect(one.status).toBe(200);
    expect(one.body.folder.reportIds).toEqual([visible.id]);
    // Sharing the folder never shares the report.
    expect((await bob.agent.get(`/api/reports/${hidden.id}`)).status).toBe(404);
    expect((await alice.agent.get(`/api/folders/${f.id}`)).body.folder.reportIds).toEqual([
      hidden.id,
      visible.id,
    ]); // Payroll, Revenue (name order)
  });

  it('report visibility wins over folder visibility: revoking the report hides it in the folder', async () => {
    const { f, visible } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB()]);
    expect((await folderOf(bob, f.id))!.reportIds).toEqual([visible.id]);
    await shareReport(alice, visible.id, []);
    expect((await folderOf(bob, f.id))!.reportIds).toEqual([]);
    // the folder itself is still visible to Bob, and still holds the report for Alice
    expect((await folderOf(bob, f.id))!.access).toBe('VIEWER');
    expect((await folderOf(alice, f.id))!.reportIds).toContain(visible.id);
    // a report shared through a group shows up once Bob joins the group
    await shareReport(alice, visible.id, [{ type: 'GROUP', id: 'sales', role: 'VIEWER' }]);
    expect((await folderOf(bob, f.id))!.reportIds).toEqual([]);
    db.addGroup('u-bob', 'sales');
    expect((await folderOf(bob, f.id))!.reportIds).toEqual([visible.id]);
  });

  it('keeps viewers read-only on the folder', async () => {
    const { f, visible } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB()]);
    const mine = await newReport(bob, 'Bob report');
    const forbidden = [
      await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: mine.id }),
      await bob.send('delete', `/api/folders/${f.id}/reports/${visible.id}`),
      await bob.send('put', `/api/folders/${f.id}/order`).send({ reportIds: [visible.id] }),
      await bob.send('put', `/api/folders/${f.id}`).send({ name: 'Mine now' }),
      await bob.send('delete', `/api/folders/${f.id}`),
      await bob.agent.get(`/api/folders/${f.id}/shares`),
      await bob.agent.get(`/api/folders/${f.id}/access`),
      await shareFolder(bob, f.id, [BOB('EDITOR')]),
    ];
    for (const r of forbidden) expect(r.status).toBe(403);
    expect((await folderOf(alice, f.id))!.name).toBe('Finance');
    expect(db.folderReports.size).toBe(0);
    expect(db.folderShares).toHaveLength(1);
  });

  it('does not let a viewer file reports into someone else’s folder through prefs', async () => {
    const { f, visible } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB('EDITOR')]);
    expect((await file(bob, visible.id, f.id)).status).toBe(404);
  });

  it('lets an editor add, remove and reorder only reports they can see', async () => {
    const { f, visible, hidden } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB('EDITOR')]);
    expect((await folderOf(bob, f.id))!.access).toBe('EDITOR');
    const bobs = await newReport(bob, 'Bob report');
    const carols = await newReport(carol, 'Carol report');

    // add one of his own reports
    const add = await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: bobs.id });
    expect(add.status).toBe(200);
    expect(add.body.folder.reportIds).toEqual([bobs.id, visible.id]);
    // adding twice is harmless
    expect(
      (await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: bobs.id })).status,
    ).toBe(200);
    // cannot add a report he cannot see, or one that does not exist: 404 and nothing stored
    for (const id of [carols.id, '00000000-0000-4000-8000-000000000000']) {
      const r = await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: id });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('REPORT_NOT_FOUND');
    }
    expect([...db.folderReports.keys()]).toEqual([`${f.id}|${bobs.id}`]);
    // Alice cannot see Bob's report, so it is in her folder but not listed for her
    expect((await folderOf(alice, f.id))!.reportIds).toEqual([hidden.id, visible.id]);
    await shareReport(bob, bobs.id, [{ type: 'USER', id: 'u-alice', role: 'VIEWER' }]);
    expect((await folderOf(alice, f.id))!.reportIds).toEqual([bobs.id, hidden.id, visible.id]);

    // cannot remove a report he cannot see (it stays)
    expect((await bob.send('delete', `/api/folders/${f.id}/reports/${hidden.id}`)).status).toBe(
      404,
    );
    expect((await folderOf(alice, f.id))!.reportIds).toContain(hidden.id);

    // reorder: the hidden report keeps its slot; unknown/hidden ids are ignored
    const ord = await bob
      .send('put', `/api/folders/${f.id}/order`)
      .send({ reportIds: [visible.id, hidden.id, carols.id, bobs.id] });
    expect(ord.status).toBe(200);
    expect(ord.body.folder.reportIds).toEqual([visible.id, bobs.id]);
    // Alice sees: slot 0 and 2 were Bob-visible (bobs, visible) -> visible, bobs; Payroll stays at 1
    expect((await folderOf(alice, f.id))!.reportIds).toEqual([visible.id, hidden.id, bobs.id]);

    // remove a report Alice filed: it leaves the folder for everyone, Alice keeps her star
    await alice.send('put', `/api/reports/${visible.id}/prefs`).send({ favorite: true });
    const rm = await bob.send('delete', `/api/folders/${f.id}/reports/${visible.id}`);
    expect(rm.status).toBe(200);
    expect(rm.body.folder.reportIds).toEqual([bobs.id]);
    expect((await folderOf(alice, f.id))!.reportIds).toEqual([hidden.id, bobs.id]);
    const aliceList = (await alice.agent.get('/api/reports')).body.reports as {
      id: string;
      folderId: string | null;
      favorite: boolean;
    }[];
    expect(aliceList.find((r) => r.id === visible.id)).toMatchObject({
      folderId: null,
      favorite: true,
    });
    // the report itself is untouched
    expect((await bob.agent.get(`/api/reports/${visible.id}`)).status).toBe(200);
  });

  it('follows group membership, picking the best role', async () => {
    const { f, visible } = await aliceFolderWithReports();
    db.addGroup('u-bob', 'finance');
    await shareFolder(alice, f.id, [
      { type: 'GROUP', id: 'finance', role: 'EDITOR' },
      BOB('VIEWER'),
    ]);
    expect((await folderOf(bob, f.id))!).toMatchObject({
      access: 'EDITOR',
      reportIds: [visible.id],
    });
    expect((await folders(carol)).find((x) => x.id === f.id)).toBeUndefined();
    db.removeGroup('u-bob', 'finance');
    expect((await folderOf(bob, f.id))!.access).toBe('VIEWER');
    expect(
      (await bob.send('put', `/api/folders/${f.id}/order`).send({ reportIds: [] })).status,
    ).toBe(403);
    db.addGroup('u-carol', 'finance');
    expect((await folderOf(carol, f.id))!).toMatchObject({ access: 'EDITOR', reportIds: [] });
  });

  it('revoking a share hides the folder again; the audit trail records each change', async () => {
    const { f, visible } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB('VIEWER')]);
    await shareFolder(alice, f.id, [BOB('EDITOR')]);
    await shareFolder(alice, f.id, []);
    expect(await folders(bob)).toEqual([]);
    expect((await bob.agent.get(`/api/folders/${f.id}`)).status).toBe(404);
    // Bob still sees the report through its own share; Alice's folder is intact
    expect((await bob.agent.get(`/api/reports/${visible.id}`)).status).toBe(200);
    expect((await folderOf(alice, f.id))!).toMatchObject({ shared: false });
    expect((await folderOf(alice, f.id))!.reportIds).toHaveLength(2);
    const audit = await alice.agent.get(`/api/folders/${f.id}/access`);
    expect(audit.status).toBe(200);
    expect(
      audit.body.events.map((e: { action: string; oldRole: string; newRole: string }) => [
        e.action,
        e.oldRole,
        e.newRole,
      ]),
    ).toEqual([
      ['REVOKE', 'EDITOR', null],
      ['CHANGE', 'VIEWER', 'EDITOR'],
      ['GRANT', null, 'VIEWER'],
    ]);
    expect(audit.body.events[0]).toMatchObject({ actorName: 'Alice', principalName: 'Bob' });
  });

  it('validates shares like report sharing', async () => {
    const f = await newFolder(alice, 'Finance');
    const bad = [
      [{ type: 'USER', id: 'u-alice', role: 'VIEWER' }],
      [{ type: 'USER', id: 'u-nobody', role: 'VIEWER' }],
      [{ type: 'GROUP', id: 'Bad Group!', role: 'VIEWER' }],
      [BOB(), BOB('EDITOR')],
      [{ type: 'USER', id: 'u-bob', role: 'OWNER' }],
    ];
    for (const shares of bad) expect((await shareFolder(alice, f.id, shares)).status).toBe(400);
    expect(db.folderShares).toHaveLength(0);
    expect(db.folderShareAudit).toHaveLength(0);
  });

  it('treats a global admin as editor-equivalent on shared folders, never as owner', async () => {
    const { f, visible, hidden } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB()]);
    const seen = (await folderOf(admin, f.id))!;
    // admins can see every report, so they see every report in the folder
    expect(seen).toMatchObject({ access: 'ADMIN', reportIds: [hidden.id, visible.id] });
    expect((await admin.agent.get(`/api/folders/${f.id}/shares`)).status).toBe(200);
    expect((await admin.agent.get(`/api/folders/${f.id}/access`)).status).toBe(200);
    expect(
      (await admin.send('put', `/api/folders/${f.id}/order`).send({ reportIds: [visible.id] }))
        .status,
    ).toBe(200);
    expect((await shareFolder(admin, f.id, [])).status).toBe(403);
    expect((await admin.send('put', `/api/folders/${f.id}`).send({ name: 'X' })).status).toBe(403);
    expect((await admin.send('delete', `/api/folders/${f.id}`)).status).toBe(403);
    expect(db.folderShares).toHaveLength(1);
  });

  it('deleting a shared folder deletes no report and leaves everyone’s own filing alone', async () => {
    const { f, visible, hidden } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB('EDITOR')]);
    const bobs = await newReport(bob, 'Bob report');
    await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: bobs.id });
    const mine = await newFolder(bob, 'Finance'); // same name, Bob's own
    await file(bob, visible.id, mine.id);
    const del = await alice.send('delete', `/api/folders/${f.id}`);
    expect(del.status).toBe(200);
    expect(del.body.moved).toBe(2);
    for (const id of [visible.id, hidden.id]) expect(db.reports.has(id)).toBe(true);
    expect(db.reports.has(bobs.id)).toBe(true);
    expect(db.folderReports.size).toBe(0);
    expect(db.folderShares).toHaveLength(0);
    expect((await bob.agent.get(`/api/folders/${f.id}`)).status).toBe(404);
    expect((await folders(bob)).map((x) => [x.id, x.reportIds])).toEqual([[mine.id, [visible.id]]]);
    // the sharing audit survives the folder
    expect(db.folderShareAudit.length).toBeGreaterThan(0);
  });

  it('drops a deleted report from shared folders', async () => {
    const { f } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB('EDITOR')]);
    const bobs = await newReport(bob, 'Bob report');
    await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: bobs.id });
    expect((await bob.send('delete', `/api/reports/${bobs.id}`)).status).toBe(204);
    expect(db.folderReports.size).toBe(0);
  });

  it('owner "Move to folder" takes the report out of their other folders, shared ones too', async () => {
    const { f } = await aliceFolderWithReports();
    await shareFolder(alice, f.id, [BOB('EDITOR')]);
    const bobs = await newReport(bob, 'Bob report');
    await shareReport(bob, bobs.id, [{ type: 'USER', id: 'u-alice', role: 'VIEWER' }]);
    await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: bobs.id });
    const other = await newFolder(alice, 'Archive');
    expect((await file(alice, bobs.id, other.id)).status).toBe(200);
    expect((await folderOf(alice, f.id))!.reportIds).not.toContain(bobs.id);
    expect((await folderOf(alice, other.id))!.reportIds).toEqual([bobs.id]);
    // a sharee's personal move never touches the shared folder
    await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: bobs.id });
    const bobsOwn = await newFolder(bob, 'Mine');
    await file(bob, bobs.id, bobsOwn.id);
    expect((await folderOf(bob, f.id))!.reportIds).toContain(bobs.id);
  });

  it('lists own folders first, then shared folders, without duplicates', async () => {
    const f = await newFolder(alice, 'Zeta');
    db.addGroup('u-bob', 'finance');
    await shareFolder(alice, f.id, [BOB(), { type: 'GROUP', id: 'finance', role: 'EDITOR' }]);
    await newFolder(bob, 'Alpha');
    expect((await folders(bob)).map((x) => [x.name, x.access])).toEqual([
      ['Alpha', 'OWNER'],
      ['Zeta', 'EDITOR'],
    ]);
  });

  it('binds every value as a parameter in the shared-folder SQL', async () => {
    const { f, visible } = await aliceFolderWithReports();
    db.statements = [];
    db.addGroup('u-bob', 'finance.team');
    expect(
      (await shareFolder(alice, f.id, [{ type: 'GROUP', id: 'finance.team', role: 'EDITOR' }]))
        .status,
    ).toBe(200);
    expect((await folders(bob)).map((x) => x.access)).toEqual(['EDITOR']);
    expect(
      (await bob.send('put', `/api/folders/${f.id}/order`).send({ reportIds: [visible.id] }))
        .status,
    ).toBe(200);
    const shared = db.statements.filter((s) =>
      /QF_FOLDER_(SHARES|REPORTS|SHARE_AUDIT)/.test(s.sql),
    );
    expect(shared.length).toBeGreaterThan(3);
    for (const s of shared) {
      expect(s.sql).not.toContain(f.id);
      expect(s.sql).not.toContain('u-bob');
    }
  });
});
