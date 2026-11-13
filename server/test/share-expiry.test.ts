import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { diffShares } from '../src/sharing/access.js';
import { resolveExpiry, shareActive } from '../src/sharing/expiry.js';
import { expectedSchema, lintMigrations } from '../scripts/verify/expected.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT N FROM SALESLIB.NUMS';

// A movable clock for every share expiry check (AppOptions.clock); sessions use real time.
const START = Date.parse('2026-11-13T12:00:00.000Z');
let nowMs = START;
const clock = () => new Date(nowMs);
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: FakeMetadataDb;
let mailer: MemoryMailer;
let built: ReturnType<typeof createApp>;

async function login(username: string) {
  const agent = request.agent(built.app);
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
let alice: Client;
let bob: Client;
let eve: Client;
let admin: Client;

beforeEach(async () => {
  nowMs = START;
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-eve', username: 'eve', hash, displayName: 'Eve' });
  db.addUser({ id: 'u-admin', username: 'admin', hash, displayName: 'Ada', role: 'ADMIN' });
  db.setEmail('u-alice', 'alice@example.com');
  db.setEmail('u-bob', 'bob@example.com');
  db.setEmail('u-eve', 'eve@example.com');
  db.addGroup('u-eve', 'finance');
  mailer = new MemoryMailer();
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  built = createApp({
    cfg: testConfig({ SCHEDULE_RECIPIENT_DOMAINS: 'example.com' }),
    metadataDb: db,
    jobFactory: f.factory,
    mailer,
    clock,
  });
  alice = await login('alice');
  bob = await login('bob');
  eve = await login('eve');
  admin = await login('admin');
});

const newReport = async (c: Client, name = 'Orders') => {
  const res = await c.send('post', '/api/reports').send({ name, sql: SQL });
  expect(res.status).toBe(201);
  return res.body.report as { id: string; version: number };
};
const newFolder = async (c: Client, name = 'Finance') => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string };
};
const putReportShares = (c: Client, id: string, shares: unknown[]) =>
  c.send('put', `/api/reports/${id}/shares`).send({ shares });
const putFolderShares = (c: Client, id: string, shares: unknown[], shareReports?: string | null) =>
  c
    .send('put', `/api/folders/${id}/shares`)
    .send(shareReports === undefined ? { shares } : { shares, shareReports });
const BOB = (expiresAt?: string | null, role = 'VIEWER') => ({
  type: 'USER',
  id: 'u-bob',
  role,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
/** Every way bob can use a report: open, run, export. All must agree. */
const bobCanUse = async (reportId: string) => {
  const statuses = [
    (await bob.agent.get(`/api/reports/${reportId}`)).status,
    (await bob.send('post', `/api/reports/${reportId}/execute`).send({})).status,
    (await bob.send('post', '/api/export').send({ reportId })).status,
  ];
  const listed = ((await bob.agent.get('/api/reports')).body.shared as { id: string }[]).some(
    (r) => r.id === reportId,
  );
  if (statuses.every((s) => s === 200) && listed) return true;
  if (statuses.every((s) => s === 404) && !listed) return false;
  throw new Error(`Inconsistent access: ${statuses.join(', ')}, listed ${listed}`);
};

describe('share expiry rules', () => {
  it('is active strictly before EXPIRES_AT and expired from that instant on', () => {
    const at = new Date(START);
    expect(shareActive(null, at)).toBe(true);
    expect(shareActive(undefined, at)).toBe(true);
    expect(shareActive('2026-11-13 12:00:00.001000', at)).toBe(true);
    expect(shareActive('2026-11-13 12:00:00.000000', at)).toBe(false);
    expect(shareActive('2026-11-13-12.00.00.000000', at)).toBe(false);
    expect(shareActive('2026-11-13 11:59:59.999000', at)).toBe(false);
    expect(shareActive(new Date(START + 1), at)).toBe(true);
    // a value that cannot be read never means "no expiry"
    expect(shareActive('garbage', at)).toBe(false);
  });

  it('keeps unchanged expiries, requires new ones in the future, and caps them', () => {
    const now = new Date(START);
    const past = iso(START - DAY);
    expect(resolveExpiry(undefined, past, now)).toBe(past);
    expect(resolveExpiry(undefined, null, now)).toBeNull();
    expect(resolveExpiry(null, past, now)).toBeNull();
    // re-sending an expired share unchanged is fine (saving a dialog that lists it)
    expect(resolveExpiry(past, past, now)).toBe(past);
    expect(resolveExpiry('2026-11-12T12:00:00Z', past, now)).toBe(past);
    expect(() => resolveExpiry(iso(START - 1), null, now)).toThrow(/future/);
    expect(() => resolveExpiry(iso(START), null, now)).toThrow(/future/);
    expect(resolveExpiry(iso(START + 1), null, now)).toBe(iso(START + 1));
    // offsets are normalised to UTC
    expect(resolveExpiry('2026-11-14T00:00:00-06:00', null, now)).toBe('2026-11-14T06:00:00.000Z');
    expect(() => resolveExpiry(iso(START + 11 * 366 * DAY), null, now)).toThrow(/ten years/);
  });

  it('audits expiry-only changes as EXPIRY and carries expiries on every event', () => {
    const a = iso(START + DAY);
    const b = iso(START + 2 * DAY);
    expect(
      diffShares(
        [
          { type: 'USER', id: 'set', role: 'VIEWER' },
          { type: 'USER', id: 'move', role: 'VIEWER', expiresAt: a },
          { type: 'USER', id: 'clear', role: 'VIEWER', expiresAt: a },
          { type: 'USER', id: 'role', role: 'VIEWER', expiresAt: a },
          { type: 'USER', id: 'same', role: 'EDITOR', expiresAt: a },
          { type: 'GROUP', id: 'gone', role: 'VIEWER', expiresAt: a },
        ],
        [
          { type: 'USER', id: 'set', role: 'VIEWER', expiresAt: a },
          { type: 'USER', id: 'move', role: 'VIEWER', expiresAt: b },
          { type: 'USER', id: 'clear', role: 'VIEWER', expiresAt: null },
          { type: 'USER', id: 'role', role: 'EDITOR', expiresAt: b },
          { type: 'USER', id: 'same', role: 'EDITOR', expiresAt: a },
          { type: 'USER', id: 'new', role: 'VIEWER', expiresAt: b },
        ],
      ).map((e) => [e.action, e.id, e.oldExpiresAt, e.newExpiresAt]),
    ).toEqual([
      ['EXPIRY', 'set', null, a],
      ['EXPIRY', 'move', a, b],
      ['EXPIRY', 'clear', a, null],
      ['CHANGE', 'role', a, b],
      ['GRANT', 'new', null, b],
      ['REVOKE', 'gone', a, null],
    ]);
  });
});

describe('migration 014: share expiry', () => {
  const migs = loadMigrations('QFMETA');
  const m14 = migs.find((m) => m.version === 14)!;
  it('is the last migration and only adds nullable columns and widens two ACTION checks', () => {
    expect(migs.at(-1)!.version).toBe(14);
    expect(m14.file).toBe('014_share_expiry.sql');
    const stmts = m14.statements.map((s) => s.replace(/\s+/g, ' '));
    const adds = stmts.filter((s) => / ADD COLUMN /.test(s));
    expect(adds).toEqual([
      'ALTER TABLE QFMETA.QF_REPORT_SHARES ADD COLUMN EXPIRES_AT TIMESTAMP',
      'ALTER TABLE QFMETA.QF_FOLDER_SHARES ADD COLUMN EXPIRES_AT TIMESTAMP',
      'ALTER TABLE QFMETA.QF_SHARE_AUDIT ADD COLUMN OLD_EXPIRES_AT TIMESTAMP',
      'ALTER TABLE QFMETA.QF_SHARE_AUDIT ADD COLUMN NEW_EXPIRES_AT TIMESTAMP',
      'ALTER TABLE QFMETA.QF_FOLDER_SHARE_AUDIT ADD COLUMN OLD_EXPIRES_AT TIMESTAMP',
      'ALTER TABLE QFMETA.QF_FOLDER_SHARE_AUDIT ADD COLUMN NEW_EXPIRES_AT TIMESTAMP',
    ]);
    // nullable, no default: existing rows read NULL (never expire)
    for (const s of adds) expect(s).not.toMatch(/NOT NULL|DEFAULT/);
    const sql = stmts.join('\n');
    expect(sql).not.toMatch(/\bDROP (TABLE|INDEX|COLUMN)\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b/);
    expect(stmts.filter((s) => /DROP CONSTRAINT/.test(s))).toEqual([
      'ALTER TABLE QFMETA.QF_SHARE_AUDIT DROP CONSTRAINT QF_SAUD_CK_ACTION',
      'ALTER TABLE QFMETA.QF_FOLDER_SHARE_AUDIT DROP CONSTRAINT QF_FSAU_CK_ACTION',
    ]);
  });
  it('leaves the verification kit expecting the new columns and wider checks, with short labels', () => {
    const e = expectedSchema(loadMigrations('QFX_SCHEMA'));
    const cols = e.columns.filter((c) => c.migration === 14).map((c) => `${c.table}.${c.name}`);
    expect(cols.sort()).toEqual(
      [
        'QF_FOLDER_SHARES.EXPIRES_AT',
        'QF_FOLDER_SHARE_AUDIT.NEW_EXPIRES_AT',
        'QF_FOLDER_SHARE_AUDIT.OLD_EXPIRES_AT',
        'QF_REPORT_SHARES.EXPIRES_AT',
        'QF_SHARE_AUDIT.NEW_EXPIRES_AT',
        'QF_SHARE_AUDIT.OLD_EXPIRES_AT',
      ].sort(),
    );
    for (const name of ['QF_SAUD_CK_ACTION', 'QF_FSAU_CK_ACTION']) {
      const c = e.constraints.find((x) => x.name === name)!;
      expect(c).toMatchObject({ type: 'CHECK', migration: 14 });
      expect(c.checkLiterals).toEqual(['GRANT', 'CHANGE', 'REVOKE', 'EXPIRY']);
    }
    expect(e.unparsed).toEqual([]);
    expect(lintMigrations(e)).toEqual([]);
    const labels = e.labels.filter((l) => l.file === '014_share_expiry.sql');
    expect(labels).toHaveLength(6);
    for (const l of labels) expect(l).toMatchObject({ kind: 'columnText' });
    for (const l of labels) expect(l.bytes).toBeLessThanOrEqual(50);
  });
});

describe('report share expiry', () => {
  it('gives access until the exact expiry instant, then none, on every path', async () => {
    const rep = await newReport(alice);
    const until = START + HOUR;
    const put = await putReportShares(alice, rep.id, [BOB(iso(until))]);
    expect(put.status).toBe(200);
    expect(put.body.shares).toEqual([
      expect.objectContaining({ id: 'u-bob', expiresAt: iso(until), expired: false }),
    ]);
    expect(await bobCanUse(rep.id)).toBe(true);
    nowMs = until - 1;
    expect(await bobCanUse(rep.id)).toBe(true);
    nowMs = until; // the boundary: expired from this instant on
    expect(await bobCanUse(rep.id)).toBe(false);
    nowMs = until + DAY;
    expect(await bobCanUse(rep.id)).toBe(false);
    // the owner still sees the row, marked expired
    const shares = (await alice.agent.get(`/api/reports/${rep.id}/shares`)).body.shares;
    expect(shares).toEqual([
      expect.objectContaining({ id: 'u-bob', expiresAt: iso(until), expired: true }),
    ]);
    const access = (await alice.agent.get(`/api/reports/${rep.id}/access`)).body;
    expect(access.shares[0]).toMatchObject({ expired: true });
    // no cleanup job: the row is still there
    expect(db.shares.filter((s) => s.REPORT_ID === rep.id)).toHaveLength(1);
  });

  it('applies to group shares too', async () => {
    const rep = await newReport(alice);
    await putReportShares(alice, rep.id, [
      { type: 'GROUP', id: 'finance', role: 'VIEWER', expiresAt: iso(START + HOUR) },
    ]);
    expect((await eve.agent.get(`/api/reports/${rep.id}`)).status).toBe(200);
    nowMs = START + HOUR;
    expect((await eve.agent.get(`/api/reports/${rep.id}`)).status).toBe(404);
  });

  it('refuses an expiry that is not in the future', async () => {
    const rep = await newReport(alice);
    for (const at of [iso(START), iso(START - 1), '2026-01-01T00:00:00Z']) {
      const res = await putReportShares(alice, rep.id, [BOB(at)]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EXPIRY_IN_PAST');
    }
    expect((await putReportShares(alice, rep.id, [BOB('tomorrow')])).status).toBe(400);
    expect(db.shares).toHaveLength(0);
  });

  it('can be renewed, kept, changed and cleared by the owner, and every change is audited', async () => {
    const rep = await newReport(alice);
    const first = iso(START + HOUR);
    await putReportShares(alice, rep.id, [BOB(first)]);
    nowMs = START + 2 * HOUR; // expired now
    expect(await bobCanUse(rep.id)).toBe(false);
    // saving the dialog unchanged (expired share re-sent as is) is allowed and changes nothing
    const same = await putReportShares(alice, rep.id, [
      BOB(first),
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
    ]);
    expect(same.status).toBe(200);
    expect(same.body.shares.find((s: { id: string }) => s.id === 'u-bob')).toMatchObject({
      expired: true,
    });
    // leaving expiresAt out keeps it as well
    const kept = await putReportShares(alice, rep.id, [BOB()]);
    expect(kept.body.shares[0]).toMatchObject({ expiresAt: first, expired: true });
    // renew
    const renewed = iso(START + 3 * DAY);
    expect((await putReportShares(alice, rep.id, [BOB(renewed)])).status).toBe(200);
    expect(await bobCanUse(rep.id)).toBe(true);
    // clear: never expires
    const cleared = await putReportShares(alice, rep.id, [BOB(null)]);
    expect(cleared.body.shares[0]).toMatchObject({ expiresAt: null, expired: false });
    nowMs = START + 400 * DAY;
    expect(await bobCanUse(rep.id)).toBe(true);
    const events = (await alice.agent.get(`/api/reports/${rep.id}/access`)).body.events as {
      action: string;
      principalId: string;
      oldExpiresAt: string | null;
      newExpiresAt: string | null;
    }[];
    expect(
      events
        .filter((e) => e.principalId === 'u-bob')
        .map((e) => [e.action, e.oldExpiresAt, e.newExpiresAt])
        .reverse(),
    ).toEqual([
      ['GRANT', null, first],
      ['EXPIRY', first, renewed],
      ['EXPIRY', renewed, null],
    ]);
  });

  it('only the owner can set expiry', async () => {
    const rep = await newReport(alice);
    await putReportShares(alice, rep.id, [BOB(null, 'EDITOR')]);
    const res = await putReportShares(bob, rep.id, [
      { type: 'USER', id: 'u-eve', role: 'VIEWER', expiresAt: iso(START + DAY) },
    ]);
    expect(res.status).toBe(403);
  });

  it('an expired direct share does not hide access still given through a folder', async () => {
    const rep = await newReport(alice);
    const f = await newFolder(alice);
    await alice.send('put', `/api/reports/${rep.id}/prefs`).send({ folderId: f.id });
    await putReportShares(alice, rep.id, [BOB(iso(START + HOUR), 'EDITOR')]);
    await putFolderShares(alice, f.id, [BOB(iso(START + DAY))], 'VIEWER');
    nowMs = START + HOUR;
    const one = await bob.agent.get(`/api/reports/${rep.id}`);
    expect(one.status).toBe(200);
    expect(one.body.report.access).toBe('VIEWER');
    nowMs = START + DAY;
    expect(await bobCanUse(rep.id)).toBe(false);
  });
});

describe('folder share expiry', () => {
  const folderIds = async (c: Client) =>
    ((await c.agent.get('/api/folders')).body.folders as { id: string }[]).map((f) => f.id);

  it('hides the folder and the reports it shares from the moment it expires', async () => {
    const rep = await newReport(alice);
    const f = await newFolder(alice);
    await alice.send('put', `/api/reports/${rep.id}/prefs`).send({ folderId: f.id });
    const until = START + HOUR;
    const put = await putFolderShares(alice, f.id, [BOB(iso(until))], 'VIEWER');
    expect(put.status).toBe(200);
    expect(put.body.shares[0]).toMatchObject({ expiresAt: iso(until), expired: false });
    nowMs = until - 1;
    expect(await folderIds(bob)).toContain(f.id);
    expect((await bob.agent.get(`/api/folders/${f.id}`)).status).toBe(200);
    expect(await bobCanUse(rep.id)).toBe(true);
    expect(await folderIds(admin)).toContain(f.id);
    nowMs = until;
    expect(await folderIds(bob)).not.toContain(f.id);
    expect((await bob.agent.get(`/api/folders/${f.id}`)).status).toBe(404);
    expect(await bobCanUse(rep.id)).toBe(false);
    // every share expired: personal again, so not even an admin sees it, and it is not "shared"
    expect(await folderIds(admin)).not.toContain(f.id);
    expect((await admin.agent.get(`/api/folders/${f.id}`)).status).toBe(404);
    const own = (await alice.agent.get('/api/folders')).body.folders.find(
      (x: { id: string }) => x.id === f.id,
    );
    expect(own).toMatchObject({ shared: false });
    // the owner's dialog lists the expired share so it can be renewed or removed
    const dlg = (await alice.agent.get(`/api/folders/${f.id}/shares`)).body;
    expect(dlg.shares).toEqual([
      expect.objectContaining({ id: 'u-bob', expiresAt: iso(until), expired: true }),
    ]);
    // the report's own share dialog no longer lists the folder grant
    const rs = (await alice.agent.get(`/api/reports/${rep.id}/shares`)).body;
    expect(rs.folderGrants).toEqual([]);
  });

  it('an expired folder share takes away folder editing too', async () => {
    const f = await newFolder(alice);
    const rep = await newReport(bob, 'Bob report');
    await putFolderShares(alice, f.id, [BOB(iso(START + HOUR), 'EDITOR')]);
    expect(
      (await bob.send('post', `/api/folders/${f.id}/reports`).send({ reportId: rep.id })).status,
    ).toBe(200);
    nowMs = START + HOUR;
    expect((await bob.send('delete', `/api/folders/${f.id}/reports/${rep.id}`)).status).toBe(404);
  });

  it('records set / renew / clear in the folder audit and the CSV export', async () => {
    const f = await newFolder(alice);
    const a = iso(START + HOUR);
    const b = iso(START + 5 * DAY);
    await putFolderShares(alice, f.id, [BOB()]);
    await putFolderShares(alice, f.id, [BOB(a)]);
    nowMs = START + 2 * HOUR;
    expect((await putFolderShares(alice, f.id, [BOB(iso(START + HOUR / 2))])).status).toBe(400);
    await putFolderShares(alice, f.id, [BOB(b)]);
    await putFolderShares(alice, f.id, [BOB(null)]);
    const page = (await alice.agent.get(`/api/folders/${f.id}/audit`)).body.events as {
      action: string;
      oldExpiresAt: string | null;
      newExpiresAt: string | null;
    }[];
    expect(page.map((e) => [e.action, e.oldExpiresAt, e.newExpiresAt]).reverse()).toEqual([
      ['GRANT', null, null],
      ['EXPIRY', null, a],
      ['EXPIRY', a, b],
      ['EXPIRY', b, null],
    ]);
    const csv = await alice.agent.get(`/api/folders/${f.id}/audit/export`).buffer(true);
    expect(csv.status).toBe(200);
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toContain('"Expiry before (UTC)","Expiry after (UTC)"');
    expect(lines.some((l) => l.includes(`"EXPIRY"`) && l.includes(`"${a}","${b}"`))).toBe(true);
  });

  it('deleting a folder revokes its expired shares with their expiry on the audit row', async () => {
    const f = await newFolder(alice);
    const a = iso(START + HOUR);
    await putFolderShares(alice, f.id, [BOB(a)]);
    nowMs = START + DAY;
    expect((await alice.send('delete', `/api/folders/${f.id}`)).status).toBe(200);
    const revoke = db.folderShareAudit.find(
      (x) => x.FOLDER_ID === f.id && x.ACTION === 'REVOKE' && x.PRINCIPAL_ID === 'u-bob',
    )!;
    expect(revoke.OLD_EXPIRES_AT).toBe('2026-11-13 13:00:00.000000');
  });
});

describe('scheduled delivery and expired shares', () => {
  const schedule = (c: Client, reportId: string, recipients: string[]) =>
    c.send('post', `/api/reports/${reportId}/schedules`).send({
      cadence: { frequency: 'DAILY', time: '07:00' },
      timezone: 'UTC',
      recipients,
      parameters: {},
    });

  it('skips a recipient whose share expired and records why in the delivery history', async () => {
    const rep = await newReport(alice);
    const until = START + HOUR;
    await putReportShares(alice, rep.id, [BOB(iso(until))]);
    const s = (await schedule(alice, rep.id, ['alice@example.com', 'bob@example.com'])).body
      .schedule;
    expect(s).toBeTruthy();
    nowMs = until - 1;
    let run = await alice.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(run.body.result).toMatchObject({ skipped: [] });
    nowMs = until; // exactly at expiry: bob is out
    run = await alice.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(run.body.result).toMatchObject({
      status: 'SUCCEEDED',
      deliveredTo: ['alice@example.com'],
      skipped: ['bob@example.com'],
      expired: ['bob@example.com'],
    });
    expect(mailer.sent.at(-1)!.to).toEqual(['alice@example.com']);
    const h = (await alice.agent.get(`/api/schedules/${s.id}/deliveries`)).body.deliveries[0];
    expect(h).toMatchObject({ skipped: ['bob@example.com'] });
    expect(h.error).toBe('Not sent to bob@example.com: their access has expired.');
    expect(run.body.schedule.lastError).toBe(h.error);
  });

  it('tells expired recipients apart from others who lost access', async () => {
    const rep = await newReport(alice);
    await putReportShares(alice, rep.id, [
      BOB(iso(START + HOUR)),
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
    ]);
    const s = (
      await schedule(alice, rep.id, ['alice@example.com', 'bob@example.com', 'eve@example.com'])
    ).body.schedule;
    db.removeGroup('u-eve', 'finance');
    nowMs = START + DAY;
    const run = await alice.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(run.body.result.skipped).toEqual(['bob@example.com', 'eve@example.com']);
    expect(run.body.result.error).toBe(
      'Not sent to bob@example.com: their access has expired. Not sent to eve@example.com: they can no longer open this report.',
    );
  });

  it('fails without sending when every recipient expired, and says so', async () => {
    const rep = await newReport(alice);
    await putReportShares(alice, rep.id, [BOB(iso(START + HOUR))]);
    const s = (await schedule(alice, rep.id, ['bob@example.com'])).body.schedule;
    const sent = mailer.sent.length;
    nowMs = START + HOUR;
    const run = await alice.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(run.body.result.status).toBe('FAILED');
    expect(run.body.result.error).toMatch(/Access has expired for bob@example.com/);
    expect(mailer.sent.length).toBe(sent);
  });

  it('skips a recipient whose folder share expired (folder report sharing)', async () => {
    const rep = await newReport(alice);
    const f = await newFolder(alice);
    await alice.send('put', `/api/reports/${rep.id}/prefs`).send({ folderId: f.id });
    await putFolderShares(alice, f.id, [BOB(iso(START + HOUR))], 'VIEWER');
    const s = (await schedule(alice, rep.id, ['alice@example.com', 'bob@example.com'])).body
      .schedule;
    nowMs = START + HOUR;
    const run = await alice.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(run.body.result).toMatchObject({
      skipped: ['bob@example.com'],
      expired: ['bob@example.com'],
    });
  });

  it('refuses to save a schedule for an expired recipient and leaves them out of the options', async () => {
    const rep = await newReport(alice);
    await putReportShares(alice, rep.id, [
      BOB(iso(START + HOUR)),
      { type: 'GROUP', id: 'finance', role: 'VIEWER', expiresAt: iso(START + HOUR) },
    ]);
    const before = (await alice.agent.get(`/api/reports/${rep.id}/schedule-recipients`)).body
      .recipients as { userId: string }[];
    expect(before.map((r) => r.userId).sort()).toEqual(['u-alice', 'u-bob', 'u-eve']);
    nowMs = START + HOUR;
    const after = (await alice.agent.get(`/api/reports/${rep.id}/schedule-recipients`)).body
      .recipients as { userId: string }[];
    expect(after.map((r) => r.userId)).toEqual(['u-alice']);
    const res = await schedule(alice, rep.id, ['bob@example.com']);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECIPIENT_NO_ACCESS');
    expect(res.body.error.message).toMatch(/Access has expired for bob@example.com/);
  });

  it("drops a schedule from a viewer's list once their share expires", async () => {
    const rep = await newReport(alice);
    await putReportShares(alice, rep.id, [BOB(iso(START + HOUR))]);
    const s = (await schedule(alice, rep.id, ['alice@example.com'])).body.schedule;
    const ids = async () =>
      ((await bob.agent.get('/api/schedules')).body.schedules as { id: string }[]).map((x) => x.id);
    expect(await ids()).toContain(s.id);
    nowMs = START + HOUR;
    expect(await ids()).not.toContain(s.id);
  });
});
