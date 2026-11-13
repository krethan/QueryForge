import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import {
  cadenceSchema,
  cadenceToCron,
  cronToCadence,
  describeCadence,
  type Cadence,
} from '../src/scheduler/cadence.js';
import { nextRun } from '../src/scheduler/cron.js';
import { normaliseScheduleBody, scheduleBodySchema } from '../src/scheduler/schedules.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT REGION, TOTAL FROM SALESLIB.ORDERS';
const env = { SCHEDULE_RECIPIENT_DOMAINS: 'example.com' };

let db: FakeMetadataDb;
let mailer: MemoryMailer;
let built: ReturnType<typeof createApp>;

function build(over: Record<string, string> = {}, mail: MemoryMailer | null = mailer) {
  const f = fakeFactory(() => ({
    columns: [col('REGION', 'CHAR', 5), col('TOTAL', 'DECIMAL', 11, 2)],
    rows: [
      ['North', '10.00'],
      ['South', '20.50'],
      ['West', '7.25'],
    ],
  }));
  return createApp({
    cfg: testConfig({ ...env, ...over }),
    metadataDb: db,
    jobFactory: f.factory,
    mailer: mail,
  });
}

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-eve', username: 'eve', hash, displayName: 'Eve' });
  db.addUser({ id: 'u-carl', username: 'carl', hash, displayName: 'Carl' });
  db.addUser({ id: 'u-admin', username: 'root', hash, displayName: 'Root', role: 'ADMIN' });
  db.addUser({ id: 'u-gone', username: 'gone', hash, displayName: 'Gone', active: 0 });
  db.setEmail('u-alice', 'alice@example.com');
  db.setEmail('u-bob', 'bob@example.com');
  db.setEmail('u-eve', 'eve@example.com');
  db.setEmail('u-carl', 'carl@elsewhere.test');
  db.setEmail('u-admin', 'admin@example.com');
  db.setEmail('u-gone', 'gone@example.com');
  db.addGroup('u-eve', 'finance');
  mailer = new MemoryMailer();
  built = build();
});

async function login(username = 'alice', app = built.app) {
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
type Session = Awaited<ReturnType<typeof login>>;

async function createReport(a: Session, name = 'Orders') {
  const res = await a.send('post', '/api/reports').send({ name, sql: SQL });
  expect(res.status).toBe(201);
  return res.body.report as { id: string };
}
const weekly: Cadence = { frequency: 'WEEKLY', time: '07:00', weekday: 1 };
const body = (over: Record<string, unknown> = {}) => ({
  cadence: weekly,
  timezone: 'America/Edmonton',
  recipients: ['alice@example.com'],
  parameters: {},
  ...over,
});
async function share(a: Session, reportId: string, shares: object[]) {
  const r = await a.send('put', `/api/reports/${reportId}/shares`).send({ shares });
  expect(r.status).toBe(200);
}

describe('cadence', () => {
  it('stores each friendly cadence as a cron expression and reads it back', () => {
    const cases: [Cadence, string, string][] = [
      [{ frequency: 'DAILY', time: '07:00' }, '0 7 * * *', 'Every day at 07:00'],
      [
        { frequency: 'WEEKDAYS', time: '06:30' },
        '30 6 * * 1-5',
        'Weekdays (Monday to Friday) at 06:30',
      ],
      [{ frequency: 'WEEKLY', time: '18:05', weekday: 5 }, '5 18 * * 5', 'Every Friday at 18:05'],
      [{ frequency: 'WEEKLY', time: '00:00', weekday: 0 }, '0 0 * * 0', 'Every Sunday at 00:00'],
      [
        { frequency: 'MONTHLY', time: '08:00', dayOfMonth: 15 },
        '0 8 15 * *',
        'Monthly on day 15 at 08:00',
      ],
      [
        { frequency: 'MONTHLY', time: '23:59', dayOfMonth: 'LAST' },
        '59 23 L * *',
        'Monthly on the last day at 23:59',
      ],
    ];
    for (const [c, cron, text] of cases) {
      expect(cadenceToCron(c)).toBe(cron);
      expect(cronToCadence(cron)).toEqual(c);
      expect(describeCadence(cronToCadence(cron), cron)).toBe(text);
    }
  });

  it('treats anything else as a custom cron schedule', () => {
    for (const cron of ['*/30 * * * *', '0 7 1,15 * *', '0 7 * 1 *', '0 7 31 * *', '0 7 * * 1,3'])
      expect(cronToCadence(cron)).toBeNull();
    expect(describeCadence(null, '0 7 1,15 * *')).toBe('Custom (cron 0 7 1,15 * *)');
  });

  it('rejects incomplete or out-of-range cadences', () => {
    const bad = [
      { frequency: 'WEEKLY', time: '07:00' },
      { frequency: 'MONTHLY', time: '07:00' },
      { frequency: 'MONTHLY', time: '07:00', dayOfMonth: 31 },
      { frequency: 'DAILY', time: '7:00' },
      { frequency: 'DAILY', time: '24:00' },
      { frequency: 'WEEKLY', time: '07:00', weekday: 7 },
      { frequency: 'HOURLY', time: '07:00' },
    ];
    for (const c of bad) expect(cadenceSchema.safeParse(c).success).toBe(false);
  });

  it('accepts exactly one of cadence or cron', () => {
    const base = { timezone: 'UTC', recipients: [], parameters: {} };
    expect(normaliseScheduleBody(scheduleBodySchema.parse({ ...base, cadence: weekly })).cron).toBe(
      '0 7 * * 1',
    );
    expect(
      normaliseScheduleBody(scheduleBodySchema.parse({ ...base, cron: '0 9 * * *' })).cron,
    ).toBe('0 9 * * *');
    expect(() =>
      normaliseScheduleBody(
        scheduleBodySchema.parse({ ...base, cadence: weekly, cron: '0 9 * * *' }),
      ),
    ).toThrow(/either/);
    expect(() => normaliseScheduleBody(scheduleBodySchema.parse(base))).toThrow(/how often/);
  });
});

describe('next-run calculation (IANA time zone, not the server clock)', () => {
  const runs = (c: Cadence, tz: string, from: string, n = 2) => {
    const out: string[] = [];
    let at = new Date(from);
    for (let i = 0; i < n; i++) {
      at = nextRun(cadenceToCron(c), tz, at);
      out.push(at.toISOString());
    }
    return out;
  };

  it('keeps the local time across a daylight-saving change', () => {
    // America/New_York moves from UTC-5 to UTC-4 on 14 March 2027
    expect(
      runs({ frequency: 'DAILY', time: '07:00' }, 'America/New_York', '2027-03-13T00:00:00Z'),
    ).toEqual(['2027-03-13T12:00:00.000Z', '2027-03-14T11:00:00.000Z']);
  });

  it('computes weekly runs in the schedule time zone', () => {
    // Thursday 12 Nov 2026 (UTC); Monday 07:30 in Tokyo is Sunday 22:30 UTC
    expect(
      runs(
        { frequency: 'WEEKLY', time: '07:30', weekday: 1 },
        'Asia/Tokyo',
        '2026-11-12T00:00:00Z',
      ),
    ).toEqual(['2026-11-15T22:30:00.000Z', '2026-11-22T22:30:00.000Z']);
  });

  it('runs monthly on a fixed day, or on the last day of every month', () => {
    expect(
      runs({ frequency: 'MONTHLY', time: '00:00', dayOfMonth: 15 }, 'UTC', '2026-11-12T00:00:00Z'),
    ).toEqual(['2026-11-15T00:00:00.000Z', '2026-12-15T00:00:00.000Z']);
    expect(
      runs(
        { frequency: 'MONTHLY', time: '08:00', dayOfMonth: 'LAST' },
        'America/New_York',
        '2027-02-01T00:00:00Z',
        3,
      ),
    ).toEqual(['2027-02-28T13:00:00.000Z', '2027-03-31T12:00:00.000Z', '2027-04-30T12:00:00.000Z']);
    expect(
      runs(
        { frequency: 'MONTHLY', time: '08:00', dayOfMonth: 'LAST' },
        'UTC',
        '2028-02-01T00:00:00Z',
        1,
      ),
    ).toEqual(['2028-02-29T08:00:00.000Z']);
  });

  it('skips weekends for weekday schedules', () => {
    // Friday 13 Nov 2026 08:00 UTC -> next is Monday
    expect(
      runs({ frequency: 'WEEKDAYS', time: '07:00' }, 'UTC', '2026-11-13T08:00:00Z', 1),
    ).toEqual(['2026-11-16T07:00:00.000Z']);
  });
});

describe('schedule API', () => {
  it('creates a schedule from a cadence and reports cadence, description and next run', async () => {
    const a = await login();
    const rep = await createReport(a);
    const before = new Date();
    const r = await a.send('post', `/api/reports/${rep.id}/schedules`).send(body());
    expect(r.status).toBe(201);
    expect(r.body.schedule).toMatchObject({
      cron: '0 7 * * 1',
      cadence: weekly,
      description: 'Every Monday at 07:00',
      timezone: 'America/Edmonton',
      recipients: ['alice@example.com'],
      enabled: true,
      lastStatus: 'NEVER',
      lastRunAt: null,
    });
    expect(r.body.schedule.nextRunAt).toBe(
      nextRun('0 7 * * 1', 'America/Edmonton', before).toISOString(),
    );
    const p = await a.send('post', '/api/schedules/preview').send({
      cadence: { frequency: 'MONTHLY', time: '09:15', dayOfMonth: 'LAST' },
      timezone: 'UTC',
    });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      cron: '15 9 L * *',
      description: 'Monthly on the last day at 09:15',
    });
    expect(p.body.upcoming).toHaveLength(5);
    const bad = await a
      .send('post', `/api/reports/${rep.id}/schedules`)
      .send(body({ cron: '0 7 * * *' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CADENCE');
    const tz = await a
      .send('post', `/api/reports/${rep.id}/schedules`)
      .send(body({ timezone: 'Mars/Base' }));
    expect(tz.body.error.code).toBe('INVALID_TIMEZONE');
  });

  it('only lets people who can already open the report be recipients', async () => {
    const a = await login();
    const rep = await createReport(a);
    const post = (recipients: string[]) =>
      a.send('post', `/api/reports/${rep.id}/schedules`).send(body({ recipients }));
    // bob is a user but the report is not shared with him
    let r = await post(['alice@example.com', 'bob@example.com']);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({
      code: 'RECIPIENT_NO_ACCESS',
      blocked: ['bob@example.com'],
    });
    expect(r.body.error.message).toMatch(/Share the report with them first/);
    // not an Uncle Bob user at all, and a deactivated user
    r = await post(['someone@example.com', 'gone@example.com']);
    expect(r.body.error).toMatchObject({
      code: 'RECIPIENT_NO_ACCESS',
      blocked: ['someone@example.com', 'gone@example.com'],
    });
    // outside the allowed domains, even though the report could be shared with him
    await share(a, rep.id, [{ type: 'USER', id: 'u-carl', role: 'VIEWER' }]);
    expect((await post(['carl@elsewhere.test'])).body.error.code).toBe('INVALID_RECIPIENTS');
    expect(db.schedules.size).toBe(0);
    // a direct share, a group share and the admin all count as access
    await share(a, rep.id, [
      { type: 'USER', id: 'u-bob', role: 'VIEWER' },
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
    ]);
    r = await post([
      'Alice@Example.com',
      'bob@example.com',
      'eve@example.com',
      'admin@example.com',
    ]);
    expect(r.status).toBe(201);
    expect(r.body.schedule.recipients).toEqual([
      'alice@example.com',
      'bob@example.com',
      'eve@example.com',
      'admin@example.com',
    ]);
  });

  it('lists the people a report can be delivered to', async () => {
    const a = await login();
    const rep = await createReport(a);
    await share(a, rep.id, [
      { type: 'USER', id: 'u-bob', role: 'VIEWER' },
      { type: 'USER', id: 'u-carl', role: 'EDITOR' },
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
    ]);
    const r = await a.agent.get(`/api/reports/${rep.id}/schedule-recipients`);
    expect(r.status).toBe(200);
    expect(r.body.recipients).toEqual([
      {
        userId: 'u-alice',
        displayName: 'Alice',
        email: 'alice@example.com',
        owner: true,
        allowedDomain: true,
      },
      {
        userId: 'u-bob',
        displayName: 'Bob',
        email: 'bob@example.com',
        owner: false,
        allowedDomain: true,
      },
      {
        userId: 'u-carl',
        displayName: 'Carl',
        email: 'carl@elsewhere.test',
        owner: false,
        allowedDomain: false,
      },
      {
        userId: 'u-eve',
        displayName: 'Eve',
        email: 'eve@example.com',
        owner: false,
        allowedDomain: true,
      },
    ]);
    // viewers cannot manage schedules; strangers cannot even see the report
    expect(
      (await (await login('bob')).agent.get(`/api/reports/${rep.id}/schedule-recipients`)).status,
    ).toBe(403);
    await share(a, rep.id, []);
    expect(
      (await (await login('bob')).agent.get(`/api/reports/${rep.id}/schedule-recipients`)).status,
    ).toBe(404);
  });

  it('tick runs due schedules, e-mails the Excel export to the recipients and records the delivery', async () => {
    const a = await login();
    const rep = await createReport(a, 'Weekly orders');
    await share(a, rep.id, [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }]);
    const s = (
      await a
        .send('post', `/api/reports/${rep.id}/schedules`)
        .send(body({ recipients: ['alice@example.com', 'bob@example.com'] }))
    ).body.schedule;
    // nothing is due before the first run
    expect(await built.scheduler.tick(new Date(new Date(s.nextRunAt).getTime() - 1000))).toEqual(
      [],
    );
    const due = new Date(new Date(s.nextRunAt).getTime() + 1000);
    expect(await built.scheduler.tick(due)).toEqual([s.id]);
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.to).toEqual(['alice@example.com', 'bob@example.com']);
    expect(m.subject).toBe('Uncle Bob: Weekly orders');
    expect(m.text).toContain('Schedule: Every Monday at 07:00 (America/Edmonton)');
    expect(m.text).toContain('Rows: 3');
    expect(m.attachments[0].filename).toMatch(/\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(m.attachmentData[0] as unknown as ArrayBuffer);
    const sheet = wb.worksheets.find((w) => w.name !== 'Report Info')!;
    expect(sheet.getRow(1).values).toEqual(expect.arrayContaining(['REGION', 'TOTAL']));
    expect(sheet.actualRowCount).toBe(4);
    const after = (await a.agent.get(`/api/reports/${rep.id}/schedules`)).body.schedules[0];
    expect(after).toMatchObject({ lastStatus: 'SUCCEEDED', lastError: null, failureCount: 0 });
    expect(after.nextRunAt).toBe(nextRun(s.cron, s.timezone, due).toISOString());
    expect(new Date(after.lastRunAt).getTime()).toBe(due.getTime());
    const h = await a.agent.get(`/api/schedules/${s.id}/deliveries`);
    expect(h.status).toBe(200);
    expect(h.body.deliveries).toHaveLength(1);
    expect(h.body.deliveries[0]).toMatchObject({
      trigger: 'SCHEDULE',
      requestedBy: null,
      status: 'SUCCEEDED',
      rowCount: 3,
      deliveredTo: ['alice@example.com', 'bob@example.com'],
      skipped: [],
      error: null,
    });
    // the run is also in execution history as a scheduled run by the owner
    expect([...db.executions.values()].find((e) => e.KIND === 'SCHEDULE')).toMatchObject({
      USER_ID: 'u-alice',
      SCHEDULE_ID: s.id,
    });
    // the same instant again: nothing due
    expect(await built.scheduler.tick(due)).toEqual([]);
  });

  it('re-checks recipient access at delivery time and never e-mails someone who lost access', async () => {
    const a = await login();
    const rep = await createReport(a);
    await share(a, rep.id, [
      { type: 'USER', id: 'u-bob', role: 'VIEWER' },
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
    ]);
    const s = (
      await a
        .send('post', `/api/reports/${rep.id}/schedules`)
        .send(body({ recipients: ['alice@example.com', 'bob@example.com', 'eve@example.com'] }))
    ).body.schedule;
    // bob's share is removed and eve leaves the finance group
    await share(a, rep.id, [{ type: 'GROUP', id: 'finance', role: 'VIEWER' }]);
    db.removeGroup('u-eve', 'finance');
    const run = await a.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(run.status).toBe(200);
    expect(run.body.result).toMatchObject({
      status: 'SUCCEEDED',
      deliveredTo: ['alice@example.com'],
      skipped: ['bob@example.com', 'eve@example.com'],
    });
    expect(mailer.sent.map((m) => m.to)).toEqual([['alice@example.com']]);
    expect(run.body.schedule.lastError).toMatch(/Not sent to bob@example.com, eve@example.com/);
    // "Run now" records the last run time too
    expect(run.body.schedule).toMatchObject({ lastStatus: 'SUCCEEDED' });
    expect(run.body.schedule.lastRunAt).not.toBeNull();
    const h = (await a.agent.get(`/api/schedules/${s.id}/deliveries`)).body.deliveries[0];
    expect(h).toMatchObject({
      trigger: 'MANUAL',
      requestedBy: 'u-alice',
      requestedByName: 'Alice',
      skipped: ['bob@example.com', 'eve@example.com'],
    });
  });

  it('fails the run without sending when no recipient can open the report', async () => {
    const a = await login();
    const rep = await createReport(a);
    await share(a, rep.id, [{ type: 'USER', id: 'u-bob', role: 'EDITOR' }]);
    const bob = await login('bob');
    const s = (
      await bob
        .send('post', `/api/reports/${rep.id}/schedules`)
        .send(body({ recipients: ['bob@example.com'] }))
    ).body.schedule;
    // bob keeps edit access through a group, but his e-mail address changes to one nobody owns
    db.setEmail('u-bob', 'robert@example.com');
    const r = (await bob.send('post', `/api/schedules/${s.id}/run`).send({})).body;
    expect(r.result).toMatchObject({ status: 'FAILED', deliveredTo: [] });
    expect(r.result.error).toMatch(/none of the recipients can open this report/);
    expect(r.schedule).toMatchObject({ lastStatus: 'FAILED', failureCount: 1 });
    expect(mailer.sent).toHaveLength(0);
    expect(
      (await bob.agent.get(`/api/schedules/${s.id}/deliveries`)).body.deliveries[0],
    ).toMatchObject({ status: 'FAILED', skipped: ['bob@example.com'] });
  });

  it('pauses, resumes (from the next occurrence) and deletes schedules', async () => {
    const a = await login();
    const rep = await createReport(a);
    const s = (await a.send('post', `/api/reports/${rep.id}/schedules`).send(body())).body.schedule;
    const p = await a.send('post', `/api/schedules/${s.id}/pause`).send({ version: s.version });
    expect(p.status).toBe(200);
    expect(p.body.schedule).toMatchObject({
      enabled: false,
      nextRunAt: null,
      version: s.version + 1,
    });
    // a paused schedule never runs
    expect(await built.scheduler.tick(new Date(Date.now() + 30 * 86400_000))).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
    // stale version
    expect(
      (await a.send('post', `/api/schedules/${s.id}/resume`).send({ version: s.version })).status,
    ).toBe(409);
    db.schedules.get(s.id)!.FAILURE_COUNT = 2;
    const before = new Date();
    const r = await a.send('post', `/api/schedules/${s.id}/resume`).send({});
    expect(r.status).toBe(200);
    expect(r.body.schedule).toMatchObject({ enabled: true, failureCount: 0 });
    expect(new Date(r.body.schedule.nextRunAt).getTime()).toBe(
      nextRun(s.cron, s.timezone, before).getTime(),
    );
    await a.send('post', `/api/schedules/${s.id}/run`).send({});
    expect(db.scheduleDeliveries).toHaveLength(1);
    expect((await a.send('delete', `/api/schedules/${s.id}`)).status).toBe(204);
    expect(db.schedules.size).toBe(0);
    expect(db.scheduleDeliveries).toHaveLength(0);
    expect((await a.agent.get(`/api/schedules/${s.id}/deliveries`)).status).toBe(404);
    expect(await built.scheduler.tick(new Date(Date.now() + 30 * 86400_000))).toEqual([]);
  });

  it('edits a schedule: cadence, time zone and recipients are re-validated', async () => {
    const a = await login();
    const rep = await createReport(a);
    const s = (await a.send('post', `/api/reports/${rep.id}/schedules`).send(body())).body.schedule;
    const monthly: Cadence = { frequency: 'MONTHLY', time: '06:00', dayOfMonth: 'LAST' };
    const before = new Date();
    const u = await a
      .send('put', `/api/schedules/${s.id}`)
      .send(body({ cadence: monthly, timezone: 'Europe/London', version: s.version }));
    expect(u.status).toBe(200);
    expect(u.body.schedule).toMatchObject({
      cron: '0 6 L * *',
      cadence: monthly,
      timezone: 'Europe/London',
      description: 'Monthly on the last day at 06:00',
    });
    expect(u.body.schedule.nextRunAt).toBe(
      nextRun('0 6 L * *', 'Europe/London', before).toISOString(),
    );
    const bad = await a
      .send('put', `/api/schedules/${s.id}`)
      .send(body({ recipients: ['bob@example.com'], version: u.body.schedule.version }));
    expect(bad.body.error.code).toBe('RECIPIENT_NO_ACCESS');
  });

  it('keeps schedule management to people who can edit the report', async () => {
    const a = await login();
    const rep = await createReport(a);
    const s = (await a.send('post', `/api/reports/${rep.id}/schedules`).send(body())).body.schedule;
    await share(a, rep.id, [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }]);
    const bob = await login('bob');
    const viewerCalls = [
      bob
        .send('post', `/api/reports/${rep.id}/schedules`)
        .send(body({ recipients: ['bob@example.com'] })),
      bob.send('put', `/api/schedules/${s.id}`).send(body({ version: s.version })),
      bob.send('post', `/api/schedules/${s.id}/pause`).send({}),
      bob.send('post', `/api/schedules/${s.id}/resume`).send({}),
      bob.send('post', `/api/schedules/${s.id}/run`).send({}),
      bob.send('delete', `/api/schedules/${s.id}`),
      bob.agent.get(`/api/schedules/${s.id}/deliveries`),
    ];
    for (const r of await Promise.all(viewerCalls)) expect(r.status).toBe(403);
    const eve = await login('eve');
    for (const r of await Promise.all([
      eve.send('post', `/api/schedules/${s.id}/pause`).send({}),
      eve.agent.get(`/api/schedules/${s.id}/deliveries`),
    ]))
      expect(r.status).toBe(404);
    expect(db.schedules.get(s.id)!.IS_ENABLED).toBe(1);
    expect(mailer.sent).toHaveLength(0);
    // admins are editor-equivalent: they see and manage every schedule
    const admin = await login('root');
    expect(
      (await admin.agent.get('/api/schedules')).body.schedules.map((x: { id: string }) => x.id),
    ).toEqual([s.id]);
    expect((await admin.agent.get(`/api/schedules/${s.id}/deliveries`)).status).toBe(200);
  });
});

describe('when e-mail is not configured', () => {
  beforeEach(() => {
    built = build({}, null); // no SMTP_HOST and no injected mailer
  });

  it('says so, refuses active schedules and "Run now", but allows saving a paused schedule', async () => {
    const a = await login();
    const settings = (await a.agent.get('/api/schedules/settings')).body;
    expect(settings.mailConfigured).toBe(false);
    const rep = await createReport(a);
    const active = await a.send('post', `/api/reports/${rep.id}/schedules`).send(body());
    expect(active.status).toBe(503);
    expect(active.body.error.code).toBe('MAIL_NOT_CONFIGURED');
    const paused = await a
      .send('post', `/api/reports/${rep.id}/schedules`)
      .send(body({ enabled: false }));
    expect(paused.status).toBe(201);
    const id = paused.body.schedule.id;
    expect((await a.send('post', `/api/schedules/${id}/resume`).send({})).body.error.code).toBe(
      'MAIL_NOT_CONFIGURED',
    );
    expect((await a.send('post', `/api/schedules/${id}/run`).send({})).body.error.code).toBe(
      'MAIL_NOT_CONFIGURED',
    );
    expect(db.schedules.get(id)!.IS_ENABLED).toBe(0);
  });

  it('a due schedule fails clearly at run time and the failure is recorded', async () => {
    const a = await login();
    const rep = await createReport(a);
    const s = await built.schedules.create(
      rep.id,
      'u-alice',
      {
        cron: '0 7 * * *',
        timezone: 'UTC',
        recipients: ['alice@example.com'],
        parameters: {},
        enabled: true,
      },
      new Date(Date.now() - 60_000),
    );
    expect(await built.scheduler.tick(new Date())).toEqual([s.id]);
    const after = await built.schedules.get(s.id);
    expect(after).toMatchObject({ lastStatus: 'FAILED', failureCount: 1 });
    expect(after.lastError).toMatch(/not configured on the server \(SMTP_HOST\)/);
    expect(db.scheduleDeliveries[0]).toMatchObject({ STATUS: 'FAILED', RUN_TRIGGER: 'SCHEDULE' });
  });

  it('never sends SMTP settings or credentials to the browser', async () => {
    built = build(
      {
        SMTP_HOST: 'smtp.internal.test',
        SMTP_USER: 'mailer-account',
        SMTP_PASSWORD: 'smtp-password-do-not-leak',
        SMTP_FROM: 'bob@example.com',
      },
      mailer,
    );
    const a = await login();
    const rep = await createReport(a);
    const responses = [
      await a.agent.get('/api/schedules/settings'),
      await a.agent.get('/api/schedules'),
      await a.send('post', `/api/reports/${rep.id}/schedules`).send(body()),
      await a.agent.get(`/api/reports/${rep.id}/schedules`),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      for (const secret of ['smtp.internal.test', 'mailer-account', 'smtp-password-do-not-leak'])
        expect(text).not.toContain(secret);
    }
    expect(responses[0].body.mailConfigured).toBe(true);
  });
});

describe('migration 010: schedule delivery history', () => {
  const migs = loadMigrations('QFMETA');
  it('comes after 009 and only adds the delivery history table', () => {
    expect(migs.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const m = migs.find((x) => x.version === 10)!;
    const sql = m.statements.join('\n').toUpperCase();
    expect(sql).toContain('CREATE TABLE QFMETA.QF_SCHEDULE_DELIVERIES');
    expect(sql).toMatch(
      /FOREIGN KEY \(SCHEDULE_ID\) REFERENCES QFMETA\.QF_SCHEDULES \(SCHEDULE_ID\) ON DELETE CASCADE/,
    );
    expect(sql).toContain("CHECK (RUN_TRIGGER IN ('SCHEDULE', 'MANUAL'))");
    expect(sql).toContain('CREATE INDEX QFMETA.QF_SDLV_IX_SCHED');
    expect(sql).toContain('LABEL ON TABLE QFMETA.QF_SCHEDULE_DELIVERIES');
    expect(sql).not.toMatch(/ALTER TABLE|DROP |ADD COLUMN|INSERT INTO|^UPDATE |DELETE FROM/m);
    expect(m.statements.filter((x) => /^CREATE TABLE/i.test(x))).toHaveLength(1);
    expect(sql).not.toContain('{{SCHEMA}}');
  });
});
