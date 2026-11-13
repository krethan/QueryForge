import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadMigrations } from '../scripts/migrate.js';
import {
  FOLDER_REPORTS_PRINCIPAL,
  folderAuditQuerySchema,
  reportSharingAuditAction,
} from '../src/sharing/folder-access.js';
import { GROUP_NAME_RE } from '../src/sharing/groups.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// Folder sharing audit history and its report-sharing rows (migration 012). Fakes only: no IBM i
// is involved.
const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

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
interface Ev {
  id: string;
  action: string;
  principalType: string;
  principalId: string;
  principalName?: string;
  oldRole: Role | null;
  newRole: Role | null;
  actorId: string;
  actorName?: string;
  occurredAt: string;
}

const newFolder = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string };
};
const shareFolder = (c: Client, id: string, shares: unknown[], shareReports?: Role | null) =>
  c
    .send('put', `/api/folders/${id}/shares`)
    .send(shareReports === undefined ? { shares } : { shares, shareReports });
const audit = (c: Client, id: string, query = '') =>
  c.agent.get(`/api/folders/${id}/audit${query}`);
const events = async (c: Client, id: string, query = '') => {
  const r = await audit(c, id, query);
  expect(r.status).toBe(200);
  return r.body.events as Ev[];
};
const reportRows = async (c: Client, id: string) =>
  (await events(c, id, '?limit=100')).filter((e) => e.principalType === 'REPORTS');
const USER = (id: string, role: Role = 'VIEWER') => ({ type: 'USER', id, role });

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
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  app = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
  alice = await login('alice');
  bob = await login('bob');
  carol = await login('carol');
  admin = await login('admin');
});

describe('migration 012: folder audit report-sharing rows', () => {
  const migs = loadMigrations('QFMETA');
  const m = migs.find((x) => x.version === 12)!;
  const sql = m.statements.join('\n');
  it('comes after 011 and only replaces the PRINCIPAL_TYPE check on the folder audit table', () => {
    expect(migs.map((x) => x.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(m.file).toBe('012_folder_audit_report_sharing.sql');
    expect(m.statements).toHaveLength(2);
    expect(m.statements[0]).toBe(
      'ALTER TABLE QFMETA.QF_FOLDER_SHARE_AUDIT DROP CONSTRAINT QF_FSAU_CK_TYPE',
    );
    expect(m.statements[1]).toBe(
      "ALTER TABLE QFMETA.QF_FOLDER_SHARE_AUDIT ADD CONSTRAINT QF_FSAU_CK_TYPE CHECK (PRINCIPAL_TYPE IN ('USER', 'GROUP', 'REPORTS'))",
    );
    expect(sql).not.toMatch(/\b(CREATE|UPDATE|DELETE FROM|INSERT|DROP TABLE|DROP COLUMN)\b/);
    expect(sql).not.toContain('{{SCHEMA}}');
    // nothing but the folder audit table is touched
    for (const st of m.statements) expect(st).toContain('QFMETA.QF_FOLDER_SHARE_AUDIT ');
  });
  it('uses a principal id that can never be a real group name', () => {
    expect(GROUP_NAME_RE.test(FOLDER_REPORTS_PRINCIPAL)).toBe(false);
  });
});

describe('report-sharing audit rules', () => {
  it('maps option changes to grant / change / revoke', () => {
    expect(reportSharingAuditAction(null, null)).toBeNull();
    expect(reportSharingAuditAction('VIEWER', 'VIEWER')).toBeNull();
    expect(reportSharingAuditAction(null, 'VIEWER')).toBe('GRANT');
    expect(reportSharingAuditAction(null, 'EDITOR')).toBe('GRANT');
    expect(reportSharingAuditAction('VIEWER', 'EDITOR')).toBe('CHANGE');
    expect(reportSharingAuditAction('EDITOR', 'VIEWER')).toBe('CHANGE');
    expect(reportSharingAuditAction('EDITOR', null)).toBe('REVOKE');
  });
  it('validates paging', () => {
    expect(folderAuditQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(folderAuditQuerySchema.parse({ limit: '10', offset: '20' })).toEqual({
      limit: 10,
      offset: 20,
    });
    for (const bad of [{ limit: '0' }, { limit: '101' }, { offset: '-1' }, { limit: 'x' }])
      expect(folderAuditQuerySchema.safeParse(bad).success).toBe(false);
  });
});

describe('recording folder report-sharing changes', () => {
  it('records turning the option on, changing its level, and turning it off', async () => {
    const f = await newFolder(alice, 'Finance');
    expect((await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER')).status).toBe(200);
    expect((await shareFolder(alice, f.id, [USER('u-bob')], 'EDITOR')).status).toBe(200);
    expect((await shareFolder(alice, f.id, [USER('u-bob')], null)).status).toBe(200);
    const rows = await reportRows(alice, f.id);
    // newest first
    expect(
      rows.map((e) => [e.action, e.oldRole, e.newRole, e.principalId, e.actorId, e.actorName]),
    ).toEqual([
      ['REVOKE', 'EDITOR', null, FOLDER_REPORTS_PRINCIPAL, 'u-alice', 'Alice'],
      ['CHANGE', 'VIEWER', 'EDITOR', FOLDER_REPORTS_PRINCIPAL, 'u-alice', 'Alice'],
      ['GRANT', null, 'VIEWER', FOLDER_REPORTS_PRINCIPAL, 'u-alice', 'Alice'],
    ]);
    for (const e of rows) {
      expect(e.principalName).toBeUndefined();
      expect(e.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
    // stored like every other folder audit row
    expect(db.folderShareAudit.filter((a) => a.PRINCIPAL_TYPE === 'REPORTS')).toHaveLength(3);
  });

  it('writes nothing for the option when it does not change or is left out', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')]);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], 'VIEWER');
    expect((await reportRows(alice, f.id)).map((e) => e.action)).toEqual(['GRANT']);
    const g = await newFolder(alice, 'Ops');
    await shareFolder(alice, g.id, [USER('u-bob')], null);
    expect(await reportRows(alice, g.id)).toEqual([]);
  });

  it('records the option next to the share changes made in the same save', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob'), USER('u-carol', 'EDITOR')], 'EDITOR');
    const all = await events(alice, f.id);
    expect(all).toHaveLength(3);
    expect(all.map((e) => `${e.action}:${e.principalType}:${e.principalId}`).sort()).toEqual([
      'GRANT:REPORTS:*REPORTS',
      'GRANT:USER:u-bob',
      'GRANT:USER:u-carol',
    ]);
    const occurred = new Set(all.map((e) => e.occurredAt.slice(0, 16)));
    expect(occurred.size).toBe(1);
  });

  it('rolls the audit row back with the change when the save fails', async () => {
    const f = await newFolder(alice, 'Finance');
    const orig = db.update.bind(db);
    db.update = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO \w+\.QF_FOLDER_REPORT_SHARING/.test(sql)) throw new Error('boom');
      return orig(sql, params as never);
    };
    try {
      expect((await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER')).status).toBe(500);
    } finally {
      db.update = orig;
    }
    expect(db.folderShareAudit).toHaveLength(0);
    expect(db.folderShareAudit.filter((a) => a.FOLDER_ID === f.id)).toEqual([]);
    expect(db.folderReportSharing.size).toBe(0);
  });

  it('a bad share list writes no audit rows at all', async () => {
    const f = await newFolder(alice, 'Finance');
    const r = await shareFolder(alice, f.id, [USER('u-nobody')], 'VIEWER');
    expect(r.status).toBe(400);
    expect(db.folderShareAudit).toHaveLength(0);
  });

  it('only the owner can change the option, so nobody else can add audit rows', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')]);
    expect((await shareFolder(bob, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR')).status).toBe(403);
    expect((await shareFolder(admin, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR')).status).toBe(403);
    expect(await reportRows(alice, f.id)).toEqual([]);
  });

  it('keeps the trail after the folder is deleted', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    expect((await alice.send('delete', `/api/folders/${f.id}`)).status).toBe(200);
    expect(db.folderShareAudit.filter((a) => a.FOLDER_ID === f.id)).toHaveLength(2);
    expect((await audit(alice, f.id)).status).toBe(404);
  });
});

describe('GET /api/folders/:id/audit', () => {
  it('pages newest first with hasMore, and every event appears exactly once', async () => {
    const f = await newFolder(alice, 'Finance');
    // 1 grant, then 6 alternating role changes, then a report-sharing toggle: 8 events
    await shareFolder(alice, f.id, [USER('u-bob')]);
    for (let i = 0; i < 6; i++)
      await shareFolder(alice, f.id, [USER('u-bob', i % 2 === 0 ? 'EDITOR' : 'VIEWER')]);
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    const p1 = await audit(alice, f.id, '?limit=3');
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ limit: 3, offset: 0, hasMore: true });
    expect(p1.body.events).toHaveLength(3);
    expect(p1.body.events[0]).toMatchObject({ principalType: 'REPORTS', action: 'GRANT' });
    const p2 = await audit(alice, f.id, '?limit=3&offset=3');
    expect(p2.body).toMatchObject({ hasMore: true });
    const p3 = await audit(alice, f.id, '?limit=3&offset=6');
    expect(p3.body.hasMore).toBe(false);
    expect(p3.body.events).toHaveLength(2);
    const ids = [...p1.body.events, ...p2.body.events, ...p3.body.events].map((e: Ev) => e.id);
    expect(new Set(ids).size).toBe(8);
    expect(p3.body.events.at(-1)).toMatchObject({ action: 'GRANT', principalId: 'u-bob' });
    const all = (await audit(alice, f.id, '?limit=100')).body;
    expect(all.events.map((e: Ev) => e.id)).toEqual(ids);
    expect(all.hasMore).toBe(false);
    const past = await audit(alice, f.id, '?offset=50');
    expect(past.body).toMatchObject({ events: [], hasMore: false });
  });

  it('defaults to 25 events per page', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob')]);
    for (let i = 0; i < 26; i++)
      await shareFolder(alice, f.id, [USER('u-bob', i % 2 === 0 ? 'EDITOR' : 'VIEWER')]);
    const r = await audit(alice, f.id);
    expect(r.body.events).toHaveLength(25);
    expect(r.body).toMatchObject({ limit: 25, offset: 0, hasMore: true });
  });

  it('rejects bad paging for the owner with 400', async () => {
    const f = await newFolder(alice, 'Finance');
    for (const q of ['?limit=0', '?limit=101', '?offset=-1', '?limit=abc', '?offset=100001'])
      expect((await audit(alice, f.id, q)).status).toBe(400);
  });

  it('names users, labels groups, and shows who made each change', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob'), { type: 'GROUP', id: 'sales', role: 'EDITOR' }]);
    await shareFolder(alice, f.id, [{ type: 'GROUP', id: 'sales', role: 'VIEWER' }]);
    const evs = await events(alice, f.id);
    const bobRows = evs.filter((e) => e.principalId === 'u-bob');
    expect(bobRows.map((e) => [e.action, e.principalName])).toEqual([
      ['REVOKE', 'Bob'],
      ['GRANT', 'Bob'],
    ]);
    const salesRows = evs.filter((e) => e.principalId === 'sales');
    expect(salesRows.map((e) => [e.action, e.principalType, e.oldRole, e.newRole])).toEqual([
      ['CHANGE', 'GROUP', 'EDITOR', 'VIEWER'],
      ['GRANT', 'GROUP', null, 'EDITOR'],
    ]);
    expect(salesRows[0].principalName).toBeUndefined();
    expect(evs.every((e) => e.actorName === 'Alice')).toBe(true);
  });

  describe('access control (same rule as the report Access and audit panel)', () => {
    it('the owner can read it, even before the folder is shared', async () => {
      const f = await newFolder(alice, 'Private');
      const r = await audit(alice, f.id);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ events: [], hasMore: false });
    });

    it('an admin can read a shared folder’s trail', async () => {
      const f = await newFolder(alice, 'Finance');
      await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
      const r = await audit(admin, f.id);
      expect(r.status).toBe(200);
      expect(r.body.events).toHaveLength(2);
    });

    it('viewers and editors get 403 and see no events', async () => {
      const f = await newFolder(alice, 'Finance');
      await shareFolder(alice, f.id, [USER('u-bob'), USER('u-carol', 'EDITOR')], 'EDITOR');
      for (const c of [bob, carol]) {
        const r = await audit(c, f.id);
        expect(r.status).toBe(403);
        expect(r.body.events).toBeUndefined();
        const a = await c.agent.get(`/api/folders/${f.id}/access`);
        expect(a.status).toBe(403);
        expect(a.body.events).toBeUndefined();
      }
    });

    it('people with no access get 404, including admins on a personal folder', async () => {
      const f = await newFolder(alice, 'Finance');
      expect((await audit(bob, f.id)).status).toBe(404);
      expect((await audit(admin, f.id)).status).toBe(404);
      await shareFolder(alice, f.id, [USER('u-bob')]);
      expect((await audit(carol, f.id)).status).toBe(404);
      // a folder that was shared and then unshared is personal again
      await shareFolder(alice, f.id, []);
      expect((await audit(admin, f.id)).status).toBe(404);
      expect((await audit(bob, f.id)).status).toBe(404);
    });

    it('unknown and malformed folder ids get 404 or 400 without leaking anything', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect((await audit(alice, unknown)).status).toBe(404);
      expect((await audit(alice, 'not-a-uuid')).status).toBeGreaterThanOrEqual(400);
      expect((await audit(alice, 'not-a-uuid')).status).toBeLessThan(500);
      // bad paging from someone without access is still a plain 404
      const f = await newFolder(alice, 'Finance');
      expect((await audit(bob, f.id, '?limit=0')).status).toBe(404);
    });

    it('needs a signed-in session', async () => {
      const f = await newFolder(alice, 'Finance');
      expect((await request(app).get(`/api/folders/${f.id}/audit`)).status).toBe(401);
    });
  });
});

describe('GET /api/folders/:id/access', () => {
  it('includes the report-sharing option, its audit rows, and hasMore', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], 'EDITOR');
    const r = await alice.agent.get(`/api/folders/${f.id}/access`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      owner: { id: 'u-alice', displayName: 'Alice' },
      shareReports: 'EDITOR',
      hasMore: false,
    });
    expect(r.body.shares).toEqual([
      expect.objectContaining({ type: 'USER', id: 'u-bob', role: 'EDITOR' }),
    ]);
    expect(r.body.events.map((e: Ev) => e.principalType).sort()).toEqual(['REPORTS', 'USER']);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')], null);
    const off = await alice.agent.get(`/api/folders/${f.id}/access?limit=1`);
    expect(off.body).toMatchObject({ shareReports: null, hasMore: true });
    expect(off.body.events).toEqual([
      expect.objectContaining({ principalType: 'REPORTS', action: 'REVOKE', oldRole: 'EDITOR' }),
    ]);
  });
});
