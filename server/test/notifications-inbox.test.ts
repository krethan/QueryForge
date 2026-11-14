import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import {
  MAX_UNREAD_COUNT,
  NOTICE_SOURCE_CAP,
  decodeCursor,
  encodeCursor,
} from '../src/notifications/inbox.js';
import { toDbTimestamp } from '../src/db/schema.js';
import { expectedSchema } from '../scripts/verify/expected.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT SECRET_COLUMN FROM SALESLIB.NUMS';

const START = Date.parse('2026-11-13T12:00:00.000Z');
let nowMs = START;
const clock = () => new Date(nowMs);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
/** Move both the app clock and the fake database's CURRENT TIMESTAMP. */
const tick = (ms = MIN) => {
  nowMs += ms;
};

let db: FakeMetadataDb;
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

beforeEach(async () => {
  nowMs = START;
  db = new FakeMetadataDb();
  db.dbClock = clock;
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-eve', username: 'eve', hash, displayName: 'Eve' });
  db.addGroup('u-eve', 'finance');
  db.setEmail('u-alice', 'alice@example.com');
  db.setEmail('u-bob', 'bob@example.com');
  const f = fakeFactory(() => ({ columns: [col('SECRET_COLUMN', 'INTEGER')], rows: [[42]] }));
  built = createApp({
    cfg: testConfig({ SCHEDULE_RECIPIENT_DOMAINS: 'example.com', QF_SHARE_REMINDER_DAYS: '3' }),
    metadataDb: db,
    jobFactory: f.factory,
    mailer: new MemoryMailer(),
    clock,
  });
  alice = await login('alice');
  bob = await login('bob');
  eve = await login('eve');
});

const newReport = async (c: Client, name = 'Orders') => {
  const res = await c.send('post', '/api/reports').send({ name, sql: SQL });
  expect(res.status).toBe(201);
  return res.body.report as { id: string };
};
const newFolder = async (c: Client, name = 'Finance') => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string };
};
const shareReport = async (c: Client, id: string, shares: unknown[]) => {
  tick();
  const res = await c.send('put', `/api/reports/${id}/shares`).send({ shares });
  expect(res.status).toBe(200);
};
const shareFolder = async (c: Client, id: string, shares: unknown[]) => {
  tick();
  const res = await c.send('put', `/api/folders/${id}/shares`).send({ shares });
  expect(res.status).toBe(200);
};
const user = (id: string, role = 'VIEWER', expiresAt?: string | null) => ({
  type: 'USER',
  id,
  role,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const group = (id: string, role = 'VIEWER', expiresAt?: string | null) => ({
  type: 'GROUP',
  id,
  role,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
interface NoticeJson {
  id: string;
  kind: string;
  at: string;
  unread: boolean;
  targetType: string;
  target: { id: string; name: string } | null;
  side?: string;
  actorName?: string;
  role?: string;
  oldRole?: string;
  principal?: { type: string; name: string };
  expiresAt?: string | null;
  report?: { id: string; name: string };
  error?: string | null;
}
const list = async (c: Client, query = '') => {
  const res = await c.agent.get(`/api/notifications${query}`);
  expect(res.status).toBe(200);
  return res.body as {
    items: NoticeJson[];
    nextCursor: string | null;
    lastReadAt: string | null;
    readStateAvailable: boolean;
  };
};
const count = async (c: Client) => {
  const res = await c.agent.get('/api/notifications/count');
  expect(res.status).toBe(200);
  return res.body as { unread: number; capped: boolean };
};

describe('in-app notifications: shares', () => {
  it('tells the person a report was shared with, with a link target, and not the owner', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob')]);
    expect(await count(bob)).toEqual({ unread: 1, capped: false });
    const { items } = await list(bob);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'SHARED',
      unread: true,
      targetType: 'REPORT',
      target: { id: r.id, name: 'Orders' },
      actorName: 'Alice',
      role: 'VIEWER',
      at: iso(nowMs).slice(0, 19) + items[0].at.slice(19),
    });
    expect(await count(alice)).toEqual({ unread: 0, capped: false });
    expect((await list(alice)).items).toEqual([]);
    expect((await list(eve)).items).toEqual([]);
  });

  it('reports a role change, and a share made through a group to its members', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob')]);
    await shareReport(alice, r.id, [user('u-bob', 'EDITOR'), group('finance')]);
    const b = (await list(bob)).items;
    expect(b.map((x) => x.kind)).toEqual(['ROLE_CHANGED', 'SHARED']);
    expect(b[0]).toMatchObject({ role: 'EDITOR', oldRole: 'VIEWER' });
    const e = (await list(eve)).items;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      kind: 'SHARED',
      target: { id: r.id, name: 'Orders' },
      principal: { type: 'GROUP', name: 'finance' },
    });
  });

  it('reports folder shares and links to the folder', async () => {
    const f = await newFolder(alice, 'Month end');
    await shareFolder(alice, f.id, [group('finance', 'EDITOR')]);
    const e = (await list(eve)).items;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      kind: 'SHARED',
      targetType: 'FOLDER',
      target: { id: f.id, name: 'Month end' },
      role: 'EDITOR',
    });
  });

  it('drops share events once the share is revoked, so the name no longer shows', async () => {
    const r = await newReport(alice, 'Secret payroll');
    await shareReport(alice, r.id, [user('u-bob')]);
    expect(await count(bob)).toEqual({ unread: 1, capped: false });
    await shareReport(alice, r.id, []);
    expect(await count(bob)).toEqual({ unread: 0, capped: false });
    const res = await bob.agent.get('/api/notifications');
    expect(res.body.items).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('Secret payroll');
    expect(JSON.stringify(res.body)).not.toContain(r.id);
  });

  it('when a share ends: the owner sees what and for whom, the recipient sees no name or ID', async () => {
    const r = await newReport(alice, 'Secret payroll');
    await shareReport(alice, r.id, [user('u-bob', 'VIEWER', iso(nowMs + 2 * DAY))]);
    // within three days of the end: "ends soon" for both, with the name (bob still has access)
    let b = (await list(bob)).items;
    expect(b.map((x) => x.kind).sort()).toEqual(['SHARED', 'SHARE_ENDING']);
    expect(b.find((x) => x.kind === 'SHARE_ENDING')).toMatchObject({
      side: 'RECIPIENT',
      target: { id: r.id, name: 'Secret payroll' },
      expiresAt: iso(START + 2 * DAY),
    });
    const a1 = (await list(alice)).items;
    expect(a1).toHaveLength(1);
    expect(a1[0]).toMatchObject({
      kind: 'SHARE_ENDING',
      side: 'OWNER',
      target: { id: r.id, name: 'Secret payroll' },
      principal: { type: 'USER', name: 'Bob' },
    });
    // after the end
    tick(3 * DAY);
    const res = await bob.agent.get('/api/notifications');
    b = res.body.items;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: 'SHARE_ENDED', side: 'RECIPIENT', target: null });
    expect(JSON.stringify(res.body)).not.toContain('Secret payroll');
    expect(JSON.stringify(res.body)).not.toContain(r.id);
    const a2 = (await list(alice)).items;
    expect(a2[0]).toMatchObject({
      kind: 'SHARE_ENDED',
      side: 'OWNER',
      target: { id: r.id, name: 'Secret payroll' },
      principal: { type: 'USER', name: 'Bob' },
    });
    // more than 30 days after the end it drops out of the list
    tick(31 * DAY);
    expect((await list(alice)).items).toEqual([]);
    expect((await list(bob)).items).toEqual([]);
  });

  it('names an ended share when the recipient can still open it another way', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-eve', 'VIEWER', iso(nowMs + DAY)), group('finance')]);
    tick(2 * DAY);
    const ended = (await list(eve)).items.find((x) => x.kind === 'SHARE_ENDED');
    expect(ended).toMatchObject({ side: 'RECIPIENT', target: { id: r.id, name: 'Orders' } });
  });

  it('never lists the user’s own share changes', async () => {
    const r = await newReport(bob, 'Mine');
    await shareReport(bob, r.id, [user('u-alice')]);
    expect((await list(bob)).items).toEqual([]);
  });
});

describe('in-app notifications: failed deliveries', () => {
  const weekly = { frequency: 'WEEKLY', time: '07:00', weekday: 1 };
  const schedule = async (c: Client, reportId: string) => {
    const res = await c.send('post', `/api/reports/${reportId}/schedules`).send({
      cadence: weekly,
      timezone: 'UTC',
      recipients: [c === bob ? 'bob@example.com' : 'alice@example.com'],
      parameters: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.schedule as { id: string };
  };
  const fail = async (scheduleId: string, reportId: string, error = 'SQL0204 not found') => {
    tick();
    await built.schedules.recordDelivery({
      scheduleId,
      reportId,
      trigger: 'SCHEDULE',
      requestedBy: null,
      startedAt: new Date(nowMs - 1000),
      finishedAt: new Date(nowMs),
      status: 'FAILED',
      rowCount: null,
      deliveredTo: [],
      skipped: [],
      error,
    });
  };

  it('tells the schedule’s creator, links to the schedule and leaves out successes', async () => {
    const r = await newReport(alice, 'Orders');
    const s = await schedule(alice, r.id);
    await fail(s.id, r.id);
    tick();
    await built.schedules.recordDelivery({
      scheduleId: s.id,
      reportId: r.id,
      trigger: 'MANUAL',
      requestedBy: 'u-alice',
      startedAt: new Date(nowMs - 1000),
      finishedAt: new Date(nowMs),
      status: 'SUCCEEDED',
      rowCount: 1,
      deliveredTo: ['alice@example.com'],
      skipped: [],
      error: null,
    });
    const a = (await list(alice)).items;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      kind: 'DELIVERY_FAILED',
      targetType: 'SCHEDULE',
      target: { id: s.id, name: 'Orders' },
      report: { id: r.id, name: 'Orders' },
      error: 'SQL0204 not found',
    });
    expect((await list(bob)).items).toEqual([]);
  });

  it('drops a failure once its creator can no longer open the report', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob', 'EDITOR')]);
    const s = await schedule(bob, r.id);
    await fail(s.id, r.id);
    expect((await list(bob)).items.map((x) => x.kind).sort()).toEqual([
      'DELIVERY_FAILED',
      'SHARED',
    ]);
    await shareReport(alice, r.id, []);
    expect((await list(bob)).items).toEqual([]);
    expect(await count(bob)).toEqual({ unread: 0, capped: false });
  });
});

describe('in-app notifications: read state, paging and limits', () => {
  it('"Mark all read" stores a timestamp in QF_USER_SETTINGS; newer events are unread again', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob')]);
    expect((await list(bob)).lastReadAt).toBeNull();
    tick();
    const res = await bob.send('post', '/api/notifications/read');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unread: 0, lastReadAt: iso(nowMs) });
    expect(db.userSettings.get('u-bob')).toMatchObject({ SHARE_EMAILS: 1 });
    expect(db.userSettings.get('u-bob')!.NOTICES_READ_AT).toBe(toDbTimestamp(new Date(nowMs)));
    expect(await count(bob)).toEqual({ unread: 0, capped: false });
    const after = await list(bob);
    expect(after.items[0].unread).toBe(false);
    expect(after.lastReadAt).toBe(iso(nowMs));
    // the e-mail setting is untouched by marking read, and vice versa
    expect(
      (await bob.send('put', '/api/account/settings').send({ shareEmails: false })).status,
    ).toBe(200);
    expect(await count(bob)).toEqual({ unread: 0, capped: false });
    await shareReport(alice, r.id, [user('u-bob', 'EDITOR')]);
    expect(await count(bob)).toEqual({ unread: 1, capped: false });
    expect((await list(bob)).items.map((x) => x.unread)).toEqual([true, false]);
    expect(db.userSettings.get('u-bob')).toMatchObject({ SHARE_EMAILS: 0 });
  });

  it('marking read is per user', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob'), user('u-eve')]);
    await bob.send('post', '/api/notifications/read');
    expect(await count(bob)).toEqual({ unread: 0, capped: false });
    expect(await count(eve)).toEqual({ unread: 1, capped: false });
  });

  it('pages with an opaque keyset cursor, newest first, without repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const r = await newReport(alice, `Report ${String(i).padStart(2, '0')}`);
      ids.push(r.id);
      await shareReport(alice, r.id, [user('u-bob')]);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const page = await list(bob, `?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      sizes.push(page.items.length);
      seen.push(...page.items.map((x) => x.target!.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([10, 10, 3]);
    expect(seen).toEqual([...ids].reverse());
    // a new event while paging does not shift later pages
    const p1 = await list(bob, '?limit=5');
    await shareReport(alice, (await newReport(alice, 'Late')).id, [user('u-bob')]);
    const p2 = await list(bob, `?limit=5&cursor=${p1.nextCursor}`);
    expect(p2.items[0].target!.id).toBe(ids[17]);
  });

  it('rejects a bad cursor or limit', async () => {
    expect((await bob.agent.get('/api/notifications?cursor=not-a-cursor')).status).toBe(400);
    expect((await bob.agent.get('/api/notifications?limit=500')).status).toBe(400);
    expect((await bob.agent.get('/api/notifications?other=1')).status).toBe(400);
    const c = encodeCursor({ t: 5, i: 'rs:x' });
    expect(decodeCursor(c)).toEqual({ t: 5, i: 'rs:x' });
  });

  it('caps the unread count and reads a bounded number of rows per source', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob')]);
    // 150 more grants straight into the fake audit table
    const occurred = (i: number) => toDbTimestamp(new Date(nowMs - i * MIN));
    for (let i = 0; i < 150; i++)
      db.shareAudit.push({
        AUDIT_ID: `a-${String(i).padStart(4, '0')}`,
        REPORT_ID: r.id,
        ACTION: 'GRANT',
        PRINCIPAL_TYPE: 'USER',
        PRINCIPAL_ID: 'u-bob',
        OLD_ROLE: null,
        NEW_ROLE: 'VIEWER',
        OLD_EXPIRES_AT: null,
        NEW_EXPIRES_AT: null,
        ACTOR_ID: 'u-alice',
        OCCURRED_AT: occurred(i + 1),
      });
    expect(await count(bob)).toEqual({ unread: MAX_UNREAD_COUNT, capped: true });
    const sql = db.statements.filter((s) => s.sql.includes('QF_SHARE_AUDIT A')).map((s) => s.sql);
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) expect(s).toContain(`FETCH FIRST ${NOTICE_SOURCE_CAP} ROWS ONLY`);
  });

  it('works without migration 016: all unread, and "Mark all read" says what is missing', async () => {
    db.noticesReadColumn = false;
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob')]);
    expect(await count(bob)).toEqual({ unread: 1, capped: false });
    const page = await list(bob);
    expect(page.readStateAvailable).toBe(false);
    expect(page.items[0].unread).toBe(true);
    const res = await bob.send('post', '/api/notifications/read');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MIGRATION_REQUIRED');
  });

  it('needs a session, and CSRF protection for marking read', async () => {
    expect((await request(built.app).get('/api/notifications/count')).status).toBe(401);
    expect((await request(built.app).get('/api/notifications')).status).toBe(401);
    const noToken = await bob.agent.post('/api/notifications/read').set('Origin', ORIGIN);
    expect(noToken.status).toBe(403);
  });

  it('binds every value as a parameter', async () => {
    const r = await newReport(alice, 'Orders');
    await shareReport(alice, r.id, [user('u-bob'), group('finance')]);
    db.statements = [];
    await list(eve);
    await count(eve);
    await eve.send('post', '/api/notifications/read');
    const sql = db.statements.map((s) => s.sql).join('\n');
    for (const v of ['u-eve', 'finance', r.id]) expect(sql).not.toContain(v);
  });
});

describe('migration 016', () => {
  it('only adds a nullable QF_USER_SETTINGS.NOTICES_READ_AT', () => {
    const e = expectedSchema();
    const m16 = e.migrations.find((m) => m.version === 16)!;
    expect(m16.tables).toEqual([]);
    expect(m16.indexes).toEqual([]);
    expect(m16.constraints).toEqual([]);
    expect(m16.columns).toEqual(['QF_USER_SETTINGS.NOTICES_READ_AT']);
  });
});
