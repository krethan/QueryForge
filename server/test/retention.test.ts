import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { toDbTimestamp, T } from '../src/db/schema.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import {
  RETENTION_TABLES,
  RetentionRunningError,
  RetentionService,
  type RetentionConfig,
  type RetentionKey,
  type RetentionRun,
} from '../src/retention/retention.js';
import { DbError } from '../src/util/errors.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { baseEnv, testConfig } from './helpers/config.js';

// History retention. Fakes and a fake clock only: no IBM i is involved, and nothing here proves
// the DELETE ... IN (SELECT ... FETCH FIRST n ROWS ONLY) statement runs on Db2 for i (the
// verification kit's smoke test does that, in a disposable library).
const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT 1 AS N FROM SYSIBM.SYSDUMMY1';
const START = Date.parse('2026-11-13T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ts = (ms: number) => toDbTimestamp(new Date(ms));

let nowMs = START;
const clock = () => new Date(nowMs);
let db: FakeMetadataDb;

const CFG: RetentionConfig = {
  deliveryDays: 365,
  reminderDays: 180,
  executionDays: 0,
  auditDays: 0,
  batchSize: 1000,
  maxBatches: 100,
};
const service = (over: Partial<RetentionConfig> = {}) =>
  new RetentionService(db, 'QFMETA', { ...CFG, ...over }, clock);

let seq = 0;
const delivery = (startedMs: number) =>
  db.scheduleDeliveries.push({
    DELIVERY_ID: `d-${++seq}`,
    SCHEDULE_ID: 's-1',
    REPORT_ID: 'r-1',
    RUN_TRIGGER: 'SCHEDULE',
    STARTED_AT: ts(startedMs),
    FINISHED_AT: ts(startedMs + 1000),
    STATUS: 'SUCCEEDED',
  });
const reminder = (expiresMs: number, status = 'SENT') =>
  db.shareReminders.push({
    REMINDER_ID: `m-${++seq}`,
    SHARE_KIND: 'REPORT',
    TARGET_ID: 'r-1',
    PRINCIPAL_TYPE: 'USER',
    PRINCIPAL_ID: `u-${seq}`,
    EXPIRES_AT: ts(expiresMs),
    STATUS: status,
    ATTEMPTS: 1,
    RECIPIENT_COUNT: 1,
    CLAIMED_BY: 'qf-x',
    CREATED_AT: ts(expiresMs - 3 * DAY),
    UPDATED_AT: ts(expiresMs - 3 * DAY),
  });
const execution = (startedMs: number, status = 'SUCCEEDED') => {
  const id = `e-${++seq}`;
  db.executions.set(id, {
    EXECUTION_ID: id,
    USER_ID: 'u-alice',
    KIND: 'RUN',
    STATUS: status,
    STARTED_AT: ts(startedMs),
  });
};
const audit = (occurredMs: number) => {
  const row = { AUDIT_ID: `a-${++seq}`, OCCURRED_AT: ts(occurredMs), ACTION: 'GRANT' };
  db.shareAudit.push({ ...row, REPORT_ID: 'r-1' });
  db.folderShareAudit.push({ ...row, FOLDER_ID: 'f-1' });
  db.folderDeletions.push({
    DELETION_ID: `x-${seq}`,
    FOLDER_ID: 'f-1',
    DELETED_AT: ts(occurredMs),
  });
};
const deletes = () => db.statements.filter((s) => /^\s*DELETE/.test(s.sql));
const tableResult = (run: RetentionRun, key: RetentionKey) =>
  run.tables.find((t) => t.key === key)!;

beforeEach(() => {
  nowMs = START;
  seq = 0;
  db = new FakeMetadataDb();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('retention configuration', () => {
  const load = (over: Record<string, string> = {}) =>
    loadConfig({ ...baseEnv, ...over } as NodeJS.ProcessEnv).retention;

  it('defaults: deliveries a year, reminders 180 days, run history and audit kept for ever', () => {
    expect(load()).toEqual({
      deliveryDays: 365,
      reminderDays: 180,
      executionDays: 0,
      auditDays: 0,
      batchSize: 1000,
      maxBatches: 100,
    });
  });

  it('accepts 0 (keep for ever) and periods at or above each minimum', () => {
    expect(
      load({
        QF_RETAIN_DELIVERY_DAYS: '0',
        QF_RETAIN_REMINDER_DAYS: '7',
        QF_RETAIN_EXECUTION_DAYS: '30',
        QF_RETAIN_AUDIT_DAYS: '365',
        QF_RETAIN_BATCH_SIZE: '50',
      }),
    ).toMatchObject({
      deliveryDays: 0,
      reminderDays: 7,
      executionDays: 30,
      auditDays: 365,
      batchSize: 50,
    });
  });

  it.each([
    ['QF_RETAIN_DELIVERY_DAYS', '6'],
    ['QF_RETAIN_REMINDER_DAYS', '1'],
    ['QF_RETAIN_EXECUTION_DAYS', '29'],
    ['QF_RETAIN_AUDIT_DAYS', '364'],
    ['QF_RETAIN_AUDIT_DAYS', '-1'],
    ['QF_RETAIN_DELIVERY_DAYS', '1.5'],
    ['QF_RETAIN_BATCH_SIZE', '5'],
    ['QF_RETAIN_MAX_BATCHES', '0'],
  ])('rejects %s=%s at start-up', (k, v) => {
    expect(() => load({ [k]: v })).toThrow(new RegExp(`Invalid configuration: ${k}`));
  });
});

describe('what retention may touch', () => {
  it('only the history and audit tables, never reports, shares, schedules or versions', () => {
    expect(RETENTION_TABLES.map((t) => t.table).sort()).toEqual(
      [
        T.executions,
        T.folderDeletions,
        T.folderShareAudit,
        T.scheduleDeliveries,
        T.shareAudit,
        T.shareReminders,
      ].sort(),
    );
    const s = service();
    for (const spec of RETENTION_TABLES) {
      const sql = s.deleteSql(spec);
      expect(sql).toBe(
        `DELETE FROM QFMETA.${spec.table} WHERE ${spec.idColumn} IN (SELECT ${spec.idColumn} FROM QFMETA.${spec.table} WHERE ${spec.timeColumn} < CAST(? AS TIMESTAMP)${spec.extra ? ` AND ${spec.extra}` : ''} FETCH FIRST 1000 ROWS ONLY)`,
      );
      for (const other of [
        T.version,
        T.reports,
        T.shares,
        T.folderShares,
        T.schedules,
        T.users,
        T.folders,
      ])
        expect(sql).not.toContain(`.${other} `);
    }
  });

  it('audit tables are untouched by default, however old the rows', async () => {
    audit(START - 20 * 365 * DAY);
    execution(START - 20 * 365 * DAY);
    const run = await service().run();
    expect(db.shareAudit).toHaveLength(1);
    expect(db.folderShareAudit).toHaveLength(1);
    expect(db.folderDeletions).toHaveLength(1);
    expect(db.executions.size).toBe(1);
    for (const k of ['shareAudit', 'folderShareAudit', 'folderDeletions', 'executions'] as const)
      expect(tableResult(run, k)).toMatchObject({ cutoff: null, deleted: 0, batches: 0 });
    expect(
      deletes()
        .map((d) => d.sql)
        .join('\n'),
    ).not.toMatch(/AUDIT|DELETIONS|EXECUTIONS/);
  });

  it('every period 0 keeps everything: no DELETE at all and no automatic run', async () => {
    delivery(START - 5000 * DAY);
    reminder(START - 5000 * DAY);
    const s = service({ deliveryDays: 0, reminderDays: 0 });
    expect(s.keepsEverything).toBe(true);
    expect(await s.runIfDue(new Date(nowMs))).toBeNull();
    const run = await s.run();
    expect(run.deleted).toBe(0);
    expect(deletes()).toEqual([]);
    expect(db.scheduleDeliveries).toHaveLength(1);
    expect(db.shareReminders).toHaveLength(1);
  });

  it('audit is pruned only when QF_RETAIN_AUDIT_DAYS is set, at its cutoff', async () => {
    audit(START - 366 * DAY);
    audit(START - 364 * DAY);
    const run = await service({ auditDays: 365 }).run();
    expect(db.shareAudit.map((a) => a.OCCURRED_AT)).toEqual([ts(START - 364 * DAY)]);
    expect(db.folderShareAudit).toHaveLength(1);
    expect(db.folderDeletions).toHaveLength(1);
    expect(tableResult(run, 'shareAudit').deleted).toBe(1);
    expect(tableResult(run, 'folderDeletions').deleted).toBe(1);
  });

  it('run history: old finished runs go, a RUNNING row never does', async () => {
    execution(START - 40 * DAY);
    execution(START - 40 * DAY, 'RUNNING');
    execution(START - 40 * DAY, 'FAILED');
    execution(START - 10 * DAY);
    await service({ executionDays: 30 }).run();
    expect([...db.executions.values()].map((e) => e.STATUS).sort()).toEqual([
      'RUNNING',
      'SUCCEEDED',
    ]);
  });
});

describe('cutoffs and batching', () => {
  it('deletes rows strictly older than the cutoff and keeps the one exactly at it', async () => {
    const cutoff = START - 365 * DAY;
    delivery(cutoff - 1000);
    delivery(cutoff);
    delivery(cutoff + 1000);
    delivery(START);
    const run = await service().run();
    expect(tableResult(run, 'deliveries')).toMatchObject({
      cutoff: iso(cutoff),
      deleted: 1,
      complete: true,
      error: null,
    });
    expect(db.scheduleDeliveries.map((d) => d.STARTED_AT)).toEqual([
      ts(cutoff),
      ts(cutoff + 1000),
      ts(START),
    ]);
    // the cutoff is bound as a parameter, never written into the SQL
    const del = deletes().find((d) => d.sql.includes('QF_SCHEDULE_DELIVERIES'))!;
    expect(del.params).toEqual([ts(cutoff)]);
  });

  it('deletes in bounded batches until a batch comes back short', async () => {
    for (let i = 0; i < 25; i++) delivery(START - 400 * DAY - i * HOUR);
    delivery(START - DAY);
    const run = await service({ batchSize: 10 }).run();
    expect(db.retentionDeletes.filter((d) => d.table === 'QF_SCHEDULE_DELIVERIES')).toEqual([
      { table: 'QF_SCHEDULE_DELIVERIES', deleted: 10 },
      { table: 'QF_SCHEDULE_DELIVERIES', deleted: 10 },
      { table: 'QF_SCHEDULE_DELIVERIES', deleted: 5 },
    ]);
    expect(tableResult(run, 'deliveries')).toMatchObject({
      deleted: 25,
      batches: 3,
      complete: true,
    });
    expect(db.scheduleDeliveries).toHaveLength(1);
    expect(deletes()[0].sql).toContain('FETCH FIRST 10 ROWS ONLY');
  });

  it('an exact multiple of the batch size needs one more, empty, statement', async () => {
    for (let i = 0; i < 20; i++) delivery(START - 400 * DAY);
    const run = await service({ batchSize: 10 }).run();
    expect(tableResult(run, 'deliveries')).toMatchObject({ deleted: 20, batches: 3 });
  });

  it('stops at the batch limit and finishes on the next run', async () => {
    for (let i = 0; i < 25; i++) delivery(START - 400 * DAY);
    const s = service({ batchSize: 10, maxBatches: 2 });
    const first = await s.run();
    expect(tableResult(first, 'deliveries')).toMatchObject({
      deleted: 20,
      batches: 2,
      complete: false,
    });
    expect(db.scheduleDeliveries).toHaveLength(5);
    const second = await s.run();
    expect(tableResult(second, 'deliveries')).toMatchObject({ deleted: 5, complete: true });
  });

  it('a failing table is reported and the others still run', async () => {
    delivery(START - 400 * DAY);
    reminder(START - 200 * DAY);
    db.failNext = new DbError(
      'Row or object QF_SCHEDULE_DELIVERIES in QFMETA in use.',
      '57033',
      -913,
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = await service().run();
    expect(tableResult(run, 'deliveries')).toMatchObject({ deleted: 0, complete: false });
    expect(tableResult(run, 'deliveries').error).toMatch(/in use/);
    expect(tableResult(run, 'reminders')).toMatchObject({ deleted: 1, error: null });
    expect(err).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/history retention \(manual\): deleted 1 row/);
  });

  it('refuses to overlap runs', async () => {
    delivery(START - 400 * DAY);
    const s = service();
    const a = s.run();
    const b = s.run();
    const due = s.runIfDue(new Date(nowMs + 2 * DAY));
    expect(s.isRunning).toBe(true);
    await expect(b).rejects.toBeInstanceOf(RetentionRunningError);
    expect(await due).toBeNull();
    expect((await a).deleted).toBe(1);
    expect(s.isRunning).toBe(false);
  });
});

describe('share reminder idempotency', () => {
  it('only removes reminder rows whose share end date is long past', async () => {
    reminder(START - 181 * DAY); // ended 181 days ago: removed
    reminder(START - 179 * DAY); // ended 179 days ago: kept
    reminder(START - HOUR, 'FAILED'); // just ended: kept
    reminder(START + 2 * DAY); // still to come: kept, whatever its age
    reminder(START + 2 * DAY, 'CLAIMED');
    await service().run();
    expect(db.shareReminders.map((r) => r.EXPIRES_AT)).toEqual([
      ts(START - 179 * DAY),
      ts(START - HOUR),
      ts(START + 2 * DAY),
      ts(START + 2 * DAY),
    ]);
  });

  it('never uses a reminder cutoff less than a day in the past, even if misconfigured', () => {
    const now = new Date(nowMs);
    expect(service({ reminderDays: 1 }).cutoffFor('reminders', now)?.toISOString()).toBe(
      iso(START - DAY),
    );
    expect(service({ reminderDays: 0.5 }).cutoffFor('reminders', now)).toBeNull();
    expect(service({ reminderDays: -3 }).cutoffFor('reminders', now)).toBeNull();
  });

  it('after pruning, no reminder is ever sent twice for the same end date', async () => {
    db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
    db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
    db.setEmail('u-alice', 'alice@example.com');
    db.setEmail('u-bob', 'bob@example.com');
    const mailer = new MemoryMailer();
    const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
    // Shortest reminder retention allowed, so pruning is as aggressive as it can be.
    const built = createApp({
      cfg: testConfig({
        SCHEDULE_RECIPIENT_DOMAINS: 'example.com',
        SCHEDULE_DEFAULT_TIMEZONE: 'UTC',
        QF_RETAIN_REMINDER_DAYS: '7',
      }),
      metadataDb: db,
      jobFactory: f.factory,
      mailer,
      clock,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agent = request.agent(built.app);
    const login = await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'alice', password: PW });
    const csrf = /qf_csrf=([^;]+)/.exec(String(login.headers['set-cookie']))![1];
    const send = (m: 'post' | 'put', url: string) =>
      agent[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
    const rep = await send('post', '/api/reports').send({ name: 'Orders', sql: SQL });
    const end = START + 2 * DAY;
    await send('put', `/api/reports/${rep.body.report.id}/shares`).send({
      shares: [{ type: 'USER', id: 'u-bob', role: 'VIEWER', expiresAt: iso(end) }],
      notify: false,
    });
    const tick = async (ms: number) => {
      nowMs = ms;
      await built.scheduler.tick(new Date(ms));
      await built.retention.idle();
    };
    await tick(START);
    expect(mailer.sent).toHaveLength(1);
    // Prune repeatedly before, at and after the end date: the claim row survives until the end
    // date is a week past, and once it is gone the share has ended so nothing is due.
    for (const t of [START + HOUR, end - HOUR, end, end + DAY, end + 6 * DAY]) {
      await built.retention.run({ now: new Date(t) });
      expect(db.shareReminders).toHaveLength(1);
      await tick(t);
    }
    await built.retention.run({ now: new Date(end + 8 * DAY) });
    expect(db.shareReminders).toHaveLength(0);
    await tick(end + 8 * DAY);
    expect(mailer.sent).toHaveLength(1);
    await built.scheduler.stop();
  });
});

describe('automatic runs on the scheduler leader', () => {
  const build = (over: Record<string, string> = {}) =>
    createApp({
      cfg: testConfig(over),
      metadataDb: db,
      jobFactory: fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] })).factory,
      mailer: null,
      clock,
    });

  it('runs at most once a day per instance, and only on the leader', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const a = build();
    const b = build();
    const tick = async (x: typeof a, ms: number) => {
      delivery(ms - 400 * DAY);
      await x.scheduler.tick(new Date(ms));
      await x.retention.idle();
    };
    await tick(a, START);
    expect(a.retention.lastRun?.trigger).toBe('SCHEDULE');
    expect(db.scheduleDeliveries).toHaveLength(0);
    await tick(b, START + 1000); // b is not the leader while a holds the lease
    expect(b.retention.lastRun).toBeNull();
    expect(db.scheduleDeliveries).toHaveLength(1);
    await tick(a, START + 23 * HOUR); // not a day yet
    expect(db.scheduleDeliveries).toHaveLength(2);
    expect(a.retention.nextAutomaticAfter).toBe(iso(START + DAY));
    await tick(a, START + DAY);
    expect(db.scheduleDeliveries).toHaveLength(0);
    await a.scheduler.stop();
    await b.scheduler.stop();
  });

  it('a run already started never blocks the poll (it runs in the background)', async () => {
    const a = build();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(a.retention, 'runIfDue').mockImplementation(async () => {
      await gate;
      return null;
    });
    await a.scheduler.tick(new Date(START)); // resolves although the prune has not finished
    expect(spy).toHaveBeenCalledOnce();
    release();
    await a.scheduler.stop();
  });
});

describe('admin API', () => {
  let built: ReturnType<typeof createApp>;
  async function login(username: string) {
    const agent = request.agent(built.app);
    const res = await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ username, password: PW });
    expect(res.status).toBe(200);
    const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
    return { agent, csrf };
  }
  beforeEach(() => {
    db.addUser({ id: 'u-admin', username: 'admin', hash, displayName: 'Ada', role: 'ADMIN' });
    db.addUser({ id: 'u-pat', username: 'pat', hash, displayName: 'Pat' });
    built = createApp({
      cfg: testConfig({ QF_RETAIN_AUDIT_DAYS: '400' }),
      metadataDb: db,
      jobFactory: fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] })).factory,
      mailer: null,
      clock,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('shows the settings and the last run to admins only', async () => {
    const { agent } = await login('admin');
    const res = await agent.get('/api/admin/retention');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      batchSize: 1000,
      maxBatches: 100,
      automatic: false,
      running: false,
      lastRun: null,
      nextAutomaticAfter: null,
    });
    expect(
      Object.fromEntries(
        (res.body.settings as { key: string; days: number }[]).map((s) => [s.key, s.days]),
      ),
    ).toEqual({
      deliveries: 365,
      reminders: 180,
      executions: 0,
      shareAudit: 400,
      folderShareAudit: 400,
      folderDeletions: 400,
    });
    const pat = await login('pat');
    const denied = await pat.agent.get('/api/admin/retention');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(await request(built.app).get('/api/admin/retention')).toHaveProperty('status', 401);
  });

  it('runs now for an admin with a CSRF token, and reports the counts', async () => {
    delivery(START - 400 * DAY);
    delivery(START - DAY);
    reminder(START - 200 * DAY);
    audit(START - 401 * DAY);
    const { agent, csrf } = await login('admin');
    const res = await agent
      .post('/api/admin/retention/run')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ trigger: 'MANUAL', requestedBy: 'admin', deleted: 5 });
    expect(res.body.lastRun).toEqual(res.body.run);
    expect(db.scheduleDeliveries).toHaveLength(1);
    expect(db.shareReminders).toHaveLength(0);
    expect(db.shareAudit).toHaveLength(0);
    const again = await agent.get('/api/admin/retention');
    expect(again.body.lastRun.deleted).toBe(5);
  });

  it('rejects run requests without CSRF, from another origin, or from a non-admin', async () => {
    delivery(START - 400 * DAY);
    const admin = await login('admin');
    const noToken = await admin.agent.post('/api/admin/retention/run').set('Origin', ORIGIN);
    expect(noToken.status).toBe(403);
    const wrongOrigin = await admin.agent
      .post('/api/admin/retention/run')
      .set('Origin', 'https://evil.example.com')
      .set('X-CSRF-Token', admin.csrf);
    expect(wrongOrigin.status).toBe(403);
    const pat = await login('pat');
    const user = await pat.agent
      .post('/api/admin/retention/run')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', pat.csrf);
    expect(user.status).toBe(403);
    expect(user.body.error.code).toBe('FORBIDDEN');
    expect(db.scheduleDeliveries).toHaveLength(1);
    expect(deletes()).toEqual([]);
  });

  it('409 while a run is in progress', async () => {
    vi.spyOn(built.retention, 'run').mockRejectedValue(new RetentionRunningError());
    const { agent, csrf } = await login('admin');
    const res = await agent
      .post('/api/admin/retention/run')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RETENTION_RUNNING');
  });
});
