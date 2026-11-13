import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import {
  appLink,
  escapeHtml,
  plain,
  safeAddress,
  safeSubject,
} from '../src/notifications/email.js';
import { ShareNotifier } from '../src/notifications/share-notifier.js';
import { expectedSchema, lintMigrations } from '../scripts/verify/expected.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { baseEnv, testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT SECRET_COLUMN FROM SALESLIB.NUMS';

const START = Date.parse('2026-11-13T12:00:00.000Z');
let nowMs = START;
const clock = () => new Date(nowMs);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

let db: FakeMetadataDb;
let mailer: MemoryMailer;
let built: ReturnType<typeof createApp>;

function build(over: Record<string, string> = {}, mail: MemoryMailer | null = mailer) {
  const f = fakeFactory(() => ({ columns: [col('SECRET_COLUMN', 'INTEGER')], rows: [[42]] }));
  return createApp({
    cfg: testConfig({
      SCHEDULE_RECIPIENT_DOMAINS: 'example.com',
      QF_PUBLIC_BASE_URL: 'https://unclebob.example.com/',
      SCHEDULE_DEFAULT_TIMEZONE: 'UTC',
      ...over,
    }),
    metadataDb: db,
    jobFactory: f.factory,
    mailer: mail,
    clock,
  });
}

async function login(username: string, app = built.app) {
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
let alice: Client;
let bob: Client;

beforeEach(async () => {
  nowMs = START;
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-eve', username: 'eve', hash, displayName: 'Eve' });
  db.addUser({ id: 'u-carol', username: 'carol', hash, displayName: 'Carol' });
  db.addUser({ id: 'u-dan', username: 'dan', hash, displayName: 'Dan' });
  db.setEmail('u-alice', 'alice@example.com');
  db.setEmail('u-bob', 'bob@example.com');
  db.setEmail('u-eve', 'eve@example.com');
  db.setEmail('u-carol', 'carol@example.com');
  // dan has no e-mail address
  db.addGroup('u-eve', 'finance');
  db.addGroup('u-carol', 'finance');
  db.addGroup('u-dan', 'finance');
  db.addGroup('u-alice', 'finance'); // the owner is in the group too: never e-mailed about it
  mailer = new MemoryMailer();
  built = build();
  alice = await login('alice');
  bob = await login('bob');
});
afterEach(() => vi.restoreAllMocks());

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
const putReportShares = (c: Client, id: string, shares: unknown[], notify?: boolean) =>
  c
    .send('put', `/api/reports/${id}/shares`)
    .send(notify === undefined ? { shares } : { shares, notify });
const BOB = (role = 'VIEWER', expiresAt?: string | null) => ({
  type: 'USER',
  id: 'u-bob',
  role,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const FINANCE = (role = 'VIEWER', expiresAt?: string | null) => ({
  type: 'GROUP',
  id: 'finance',
  role,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const sentTo = () => mailer.sent.map((m) => m.to.join(','));
const settle = () => built.notifier.idle();

describe('share notification e-mails', () => {
  it('e-mails a new user share with who, what, role, end date and a link, but no report data', async () => {
    const r = await newReport(alice);
    const ends = iso(START + 10 * DAY);
    const res = await putReportShares(alice, r.id, [BOB('EDITOR', ends)], true);
    expect(res.status).toBe(200);
    expect(res.body.notification).toBe('QUEUED');
    await settle();
    expect(sentTo()).toEqual(['bob@example.com']);
    const m = mailer.sent[0];
    expect(m.subject).toBe('Uncle Bob: Alice shared "Orders" with you');
    expect(m.text).toContain('Alice shared the report Orders with you as Editor.');
    expect(m.text).toContain('This access ends on 23 Nov 2026, 12:00 (UTC).');
    expect(m.text).toContain(`https://unclebob.example.com/reports/${r.id}`);
    expect(m.html).toContain(`href="https://unclebob.example.com/reports/${r.id}"`);
    expect(m.attachments).toEqual([]);
    for (const part of [m.text, m.html!, m.subject]) {
      expect(part).not.toContain('SECRET_COLUMN');
      expect(part).not.toContain('SALESLIB');
    }
  });

  it('sends nothing unless asked (notify false or left out)', async () => {
    const r = await newReport(alice);
    expect((await putReportShares(alice, r.id, [BOB()])).body.notification).toBe('OFF');
    expect((await putReportShares(alice, r.id, [BOB('EDITOR')], false)).body.notification).toBe(
      'OFF',
    );
    await settle();
    expect(mailer.sent).toEqual([]);
  });

  it('expands group shares to members with an address, leaving out the owner and the sharer', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [FINANCE()], true);
    await settle();
    expect(sentTo().sort()).toEqual(['carol@example.com', 'eve@example.com']);
    expect(mailer.sent[0].text).toContain('with the group finance, which you are in, as Viewer.');
  });

  it('sends one e-mail per person when a direct and a group share both reach them', async () => {
    db.addGroup('u-bob', 'finance');
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('EDITOR'), FINANCE('VIEWER')], true);
    await settle();
    const bobs = mailer.sent.filter((m) => m.to[0] === 'bob@example.com');
    expect(bobs).toHaveLength(1);
    expect(bobs[0].text).toContain('shared the report Orders with you as Editor.');
  });

  it('e-mails a role change, but not an end date change alone or a removal', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB()], false);
    const change = await putReportShares(alice, r.id, [BOB('EDITOR')], true);
    expect(change.body.notification).toBe('QUEUED');
    await settle();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe('Uncle Bob: your access to "Orders" changed');
    expect(mailer.sent[0].text).toContain(
      'Alice changed your access to the report Orders from Viewer to Editor.',
    );
    const endOnly = await putReportShares(alice, r.id, [BOB('EDITOR', iso(START + 5 * DAY))], true);
    expect(endOnly.body.notification).toBe('NONE');
    expect((await putReportShares(alice, r.id, [], true)).body.notification).toBe('NONE');
    await settle();
    expect(mailer.sent).toHaveLength(1);
  });

  it('says nothing about a share that has already expired when it is saved again', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + HOUR))], false);
    nowMs = START + 2 * HOUR;
    // role changed on an expired share whose end date is kept: no access, so no e-mail
    const res = await putReportShares(alice, r.id, [BOB('EDITOR')], true);
    expect(res.status).toBe(200);
    expect(res.body.notification).toBe('NONE');
    await settle();
    expect(mailer.sent).toEqual([]);
  });

  it('honours the per-user opt-out (account setting)', async () => {
    expect((await bob.agent.get('/api/account/settings')).body).toEqual({
      settings: { shareEmails: true },
      hasEmail: true,
      mailConfigured: true,
    });
    const off = await bob.send('put', '/api/account/settings').send({ shareEmails: false });
    expect(off.status).toBe(200);
    expect(off.body.settings).toEqual({ shareEmails: false });
    expect(db.userSettings.get('u-bob')?.SHARE_EMAILS).toBe(0);
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB()], true);
    await settle();
    expect(mailer.sent).toEqual([]);
    // and back on (an UPDATE of the existing row)
    await bob.send('put', '/api/account/settings').send({ shareEmails: true });
    await putReportShares(alice, r.id, [BOB('EDITOR')], true);
    await settle();
    expect(sentTo()).toEqual(['bob@example.com']);
    // unknown fields are refused
    expect(
      (await bob.send('put', '/api/account/settings').send({ shareEmails: true, x: 1 })).status,
    ).toBe(400);
  });

  it('keeps sharing working without SMTP: skipped with a log line, and the UI is told', async () => {
    built = build({}, null);
    alice = await login('alice');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await newReport(alice);
    const got = await alice.agent.get(`/api/reports/${r.id}/shares`);
    expect(got.body.mailConfigured).toBe(false);
    const res = await putReportShares(alice, r.id, [BOB()], true);
    expect(res.status).toBe(200);
    expect(res.body.shares).toHaveLength(1);
    expect(res.body.notification).toBe('MAIL_NOT_CONFIGURED');
    expect(log.mock.calls.some((c) => String(c[0]).includes('share notification skipped'))).toBe(
      true,
    );
    // no SMTP setting ever reaches the browser
    expect(JSON.stringify(got.body)).not.toMatch(/smtp|password/i);
  });

  it('escapes names in the HTML part and keeps line breaks out of the subject', async () => {
    db.users.get('u-alice')!.DISPLAY_NAME = 'Mallory\r\nBcc: victim@evil.test <img src=x>';
    alice = await login('alice'); // the display name comes from the session
    const r = await newReport(alice, '<b>Q&A</b> "x"');
    await putReportShares(alice, r.id, [BOB()], true);
    await settle();
    const m = mailer.sent[0];
    expect(m.to).toEqual(['bob@example.com']);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toContain('Mallory Bcc: victim@evil.test');
    expect(m.text).not.toMatch(/\r/);
    expect(m.text.split('\n')[0]).toContain('Mallory Bcc: victim@evil.test <img src=x> shared');
    expect(m.html).not.toContain('<img src=x>');
    expect(m.html).not.toContain('<b>Q&A</b>');
    expect(m.html).toContain('&#60;b&#62;Q&#38;A&#60;/b&#62; &#34;x&#34;');
  });

  it('notifies folder shares too, linking to the app', async () => {
    const f = await newFolder(alice);
    const got = await alice.agent.get(`/api/folders/${f.id}/shares`);
    expect(got.body.mailConfigured).toBe(true);
    const res = await alice
      .send('put', `/api/folders/${f.id}/shares`)
      .send({ shares: [FINANCE('EDITOR')], notify: true });
    expect(res.status).toBe(200);
    expect(res.body.notification).toBe('QUEUED');
    expect(res.body.shares).toHaveLength(1);
    await settle();
    expect(sentTo().sort()).toEqual(['carol@example.com', 'eve@example.com']);
    expect(mailer.sent[0].text).toContain('Alice shared the folder Finance with the group finance');
    expect(mailer.sent[0].text).toContain(
      'Editors can see the folder and add, remove and reorder its reports.',
    );
    expect(mailer.sent[0].text).toContain('Open Uncle Bob: https://unclebob.example.com/\n');
  });

  it('takes the link from configuration, never from the Host header', async () => {
    const r = await newReport(alice);
    await alice
      .send('put', `/api/reports/${r.id}/shares`)
      .set('Host', 'evil.example.net')
      .set('X-Forwarded-Host', 'evil.example.net')
      .send({ shares: [BOB()], notify: true });
    await settle();
    expect(mailer.sent[0].text).not.toContain('evil.example.net');
    expect(mailer.sent[0].text).toContain('https://unclebob.example.com/reports/');
  });

  it('falls back to APP_ORIGIN for links and refuses a non-http QF_PUBLIC_BASE_URL', () => {
    expect(loadConfig({ ...baseEnv } as NodeJS.ProcessEnv).notifications).toEqual({
      publicBaseUrl: 'http://localhost:5173',
      reminderDays: 3,
      reminderToRecipient: false,
      timezone: 'UTC',
    });
    expect(() =>
      loadConfig({ ...baseEnv, QF_PUBLIC_BASE_URL: 'javascript:alert(1)' } as NodeJS.ProcessEnv),
    ).toThrow(/QF_PUBLIC_BASE_URL/);
    expect(() =>
      loadConfig({ ...baseEnv, QF_SHARE_REMINDER_DAYS: '-1' } as NodeJS.ProcessEnv),
    ).toThrow(/QF_SHARE_REMINDER_DAYS/);
  });

  it('a failing mail server never fails or undoes the share', async () => {
    const r = await newReport(alice);
    mailer.failNext = new Error('550 relay denied');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await putReportShares(alice, r.id, [BOB()], true);
    expect(res.status).toBe(200);
    await settle();
    expect(db.shares).toHaveLength(1);
    expect(err).toHaveBeenCalled();
  });
});

describe('share expiry reminders', () => {
  const tick = (ms = nowMs) => built.scheduler.tick(new Date(ms));

  it('reminds the owner once, a few days before the end date, across ticks and restarts', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + 5 * DAY))], false);
    await tick(); // 5 days out: not yet
    expect(mailer.sent).toEqual([]);
    nowMs = START + 2 * DAY + HOUR; // now under 3 days to go
    await tick();
    expect(sentTo()).toEqual(['alice@example.com']);
    const m = mailer.sent[0];
    expect(m.subject).toBe('Uncle Bob: sharing of "Orders" ends soon');
    expect(m.text).toContain(
      'Your share of the report Orders with Bob (Viewer) ends on 18 Nov 2026, 12:00 (UTC).',
    );
    expect(db.shareReminders).toHaveLength(1);
    expect(db.shareReminders[0]).toMatchObject({
      STATUS: 'SENT',
      RECIPIENT_COUNT: 1,
      SHARE_KIND: 'REPORT',
    });
    await tick(nowMs + HOUR);
    expect(mailer.sent).toHaveLength(1);
    // restart: a new app (new instance id, empty memory) on the same metadata
    await built.scheduler.stop();
    built = build();
    await tick(nowMs + 2 * HOUR);
    expect(mailer.sent).toHaveLength(1);
  });

  it('two instances running reminders at the same moment send one e-mail (unique claim)', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    const cfg = testConfig({ SCHEDULE_RECIPIENT_DOMAINS: 'example.com' });
    const a = new ShareNotifier(db, 'QFMETA', cfg, mailer, clock);
    const b = new ShareNotifier(db, 'QFMETA', cfg, mailer, clock);
    const [ra, rb] = await Promise.all([
      a.runReminders(new Date(nowMs), 'qf-a'),
      b.runReminders(new Date(nowMs), 'qf-b'),
    ]);
    expect(ra.sent + rb.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(db.shareReminders).toHaveLength(1);
  });

  it('a new end date can be reminded about again', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    await tick();
    expect(mailer.sent).toHaveLength(1);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + 2 * DAY))], false);
    await tick(nowMs + HOUR);
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1].text).toContain('ends on 15 Nov 2026, 12:00 (UTC)');
    expect(db.shareReminders).toHaveLength(2);
  });

  it('never reminds about a share that has already ended, or one with no end date', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + HOUR)), FINANCE()], false);
    nowMs = START + 2 * HOUR;
    await tick();
    expect(mailer.sent).toEqual([]);
    expect(db.shareReminders).toEqual([]);
  });

  it('can also remind the people losing access, expanding groups and honouring opt-outs', async () => {
    built = build({ QF_SHARE_REMINDER_TO_RECIPIENT: 'true' });
    db.userSettings.set('u-carol', { USER_ID: 'u-carol', SHARE_EMAILS: 0 });
    const f = await newFolder(alice);
    await alice
      .send('put', `/api/folders/${f.id}/shares`)
      .send({ shares: [FINANCE('VIEWER', iso(START + DAY))] });
    alice = await login('alice');
    await tick();
    expect(sentTo().sort()).toEqual(['alice@example.com', 'eve@example.com']);
    const eve = mailer.sent.find((m) => m.to[0] === 'eve@example.com')!;
    expect(eve.subject).toBe('Uncle Bob: your access to "Finance" ends soon');
    expect(eve.text).toContain(
      'Access for the group finance (which you are in) to the folder Finance (Viewer), shared by Alice, ends on',
    );
    expect(db.shareReminders[0]).toMatchObject({
      SHARE_KIND: 'FOLDER',
      STATUS: 'SENT',
      RECIPIENT_COUNT: 2,
    });
  });

  it('skips (and records) a reminder nobody can receive, e.g. the owner opted out', async () => {
    db.userSettings.set('u-alice', { USER_ID: 'u-alice', SHARE_EMAILS: 0 });
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    await tick();
    expect(mailer.sent).toEqual([]);
    expect(db.shareReminders[0]).toMatchObject({ STATUS: 'SKIPPED', RECIPIENT_COUNT: 0 });
    await tick(nowMs + HOUR);
    expect(db.shareReminders).toHaveLength(1);
  });

  it('retries a failed send on a later poll, a limited number of times', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    mailer.failNext = new Error('421 try later');
    await tick();
    expect(mailer.sent).toEqual([]);
    expect(db.shareReminders[0]).toMatchObject({
      STATUS: 'FAILED',
      ATTEMPTS: 1,
      LAST_ERROR: '421 try later',
    });
    await tick(nowMs + HOUR);
    expect(sentTo()).toEqual(['alice@example.com']);
    expect(db.shareReminders[0]).toMatchObject({ STATUS: 'SENT', ATTEMPTS: 2 });
    expect(err).toHaveBeenCalled();
  });

  it('gives up after the maximum attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    for (let i = 0; i < 5; i++) {
      mailer.failNext = new Error('421 try later');
      await tick(nowMs + i * HOUR);
    }
    expect(db.shareReminders[0]).toMatchObject({ STATUS: 'FAILED', ATTEMPTS: 3 });
    expect(mailer.sent).toEqual([]);
  });

  it('does nothing without SMTP or with QF_SHARE_REMINDER_DAYS=0, and claims nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    built = build({}, null);
    await tick();
    expect(db.shareReminders).toEqual([]);
    expect(log.mock.calls.some((c) => String(c[0]).includes('reminders skipped'))).toBe(true);
    built = build({ QF_SHARE_REMINDER_DAYS: '0' });
    await tick(nowMs + 3 * 60_000);
    expect(db.shareReminders).toEqual([]);
    expect(mailer.sent).toEqual([]);
    // once mail is set up again the reminder still goes out
    built = build();
    await tick(nowMs + 6 * 60_000);
    expect(sentTo()).toEqual(['alice@example.com']);
  });

  it('only the scheduler leader sends reminders', async () => {
    const r = await newReport(alice);
    await putReportShares(alice, r.id, [BOB('VIEWER', iso(START + DAY))], false);
    const other = build();
    await tick(); // built takes the lease
    await other.scheduler.tick(new Date(nowMs + 1000)); // not the leader: nothing to do
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('e-mail helpers', () => {
  it('escape, flatten and validate untrusted values', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;',
    );
    expect(plain('a\r\nb\u2028c\u0000d')).toBe('a b c d');
    expect(plain('x'.repeat(300), 10)).toHaveLength(10);
    expect(safeSubject('Hi\r\nBcc: x@y.z')).toBe('Hi Bcc: x@y.z');
    expect(safeAddress('Bob@Example.com')).toBe('bob@example.com');
    expect(safeAddress('bob@example.com\r\nBcc: x@y.z')).toBeNull();
    expect(safeAddress('Bob <bob@example.com>')).toBeNull();
    expect(appLink('https://h.example/app/', '/reports/1')).toBe('https://h.example/app/reports/1');
    expect(appLink('ftp://h.example', '/')).toBeNull();
  });
});

describe('migration 015', () => {
  it('adds the reminder and settings tables with a unique claim key and short labels', () => {
    const m = loadMigrations('QFMETA').find((x) => x.version === 15)!;
    const sql = m.statements.join('\n');
    expect(sql).toContain('CREATE TABLE QFMETA.QF_SHARE_REMINDERS');
    expect(sql).toContain('CREATE TABLE QFMETA.QF_USER_SETTINGS');
    expect(sql).toMatch(
      /CONSTRAINT QF_SREM_UQ_SHARE UNIQUE \(SHARE_KIND, TARGET_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, EXPIRES_AT\)/,
    );
    expect(sql).not.toMatch(/\bDROP\b|ALTER TABLE/);
    expect(lintMigrations()).toEqual([]);
    const tables = expectedSchema().tables.map((t: { name: string }) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['QF_SHARE_REMINDERS', 'QF_USER_SETTINGS']));
  });
});
