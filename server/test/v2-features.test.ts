import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { FakeLdap, FakeOidc } from './helpers/fake-auth.js';
import { identityFromClaims } from '../src/auth/oidc.js';
import { cnOf, escapeLdapFilter } from '../src/auth/ldap.js';
import { MemoryMailer, checkRecipients } from '../src/mail/mailer.js';
import { countMarkers, resolveParameters, type ParameterDef } from '../src/reports/parameters.js';
import { validateCron } from '../src/scheduler/cron.js';
import { mapExternalGroups } from '../src/sharing/groups.js';
import { parseGroupMap } from '../src/config/config.js';
import { loadMigrations } from '../scripts/migrate.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);

const PARAMS: ParameterDef[] = [
  {
    name: 'region',
    label: 'Region',
    type: 'list',
    required: true,
    defaultValue: 'North',
    options: [{ value: 'North' }, { value: 'South' }],
  },
  { name: 'since', label: 'Since', type: 'date', required: true, defaultValue: null },
  { name: 'minTotal', label: 'Minimum total', type: 'decimal', required: false, defaultValue: '0' },
  { name: 'top', label: 'Top N', type: 'integer', required: false, defaultValue: null },
];
const PSQL =
  'SELECT * FROM SALESLIB.ORDERS WHERE REGION = ? AND ORDER_DATE >= ? AND TOTAL >= ? AND (CAST(? AS INTEGER) IS NULL OR 1 = 1)';

let db: FakeMetadataDb;
let built: ReturnType<typeof createApp>;
let jobs: ReturnType<typeof fakeFactory>['jobs'];
let mailer: MemoryMailer;
let oidc: FakeOidc;
const env = {
  GROUP_MAP: 'finance-readers=finance;qf admins=qf-admins',
  ADMIN_GROUPS: 'qf-admins',
  SCHEDULE_RECIPIENT_DOMAINS: 'example.com',
};
function build(over: Record<string, string> = {}, shared?: FakeMetadataDb) {
  const f = fakeFactory(() => ({
    columns: [col('N', 'INTEGER'), col('REGION', 'CHAR', 5)],
    rows: [
      [1, 'North'],
      [2, 'North'],
    ],
  }));
  jobs = f.jobs;
  return createApp({
    cfg: testConfig({ ...env, ...over }),
    metadataDb: shared ?? db,
    jobFactory: f.factory,
    oidc,
    ldap: new FakeLdap(),
    mailer,
  });
}

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  db.addUser({ id: 'u-bob', username: 'bob', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-eve', username: 'eve', hash, displayName: 'Eve' });
  db.addGroup('u-eve', 'finance');
  mailer = new MemoryMailer();
  oidc = new FakeOidc();
  built = build();
});

async function login(username = 'alice', app = built.app, body: Record<string, string> = {}) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PW, ...body });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const send = (m: 'post' | 'put' | 'delete', url: string) =>
    agent[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return { agent, send };
}
async function createReport(
  a: Awaited<ReturnType<typeof login>>,
  over: Record<string, unknown> = {},
) {
  const res = await a
    .send('post', '/api/reports')
    .send({ name: 'Orders by region', sql: PSQL, parameters: PARAMS, ...over });
  expect(res.status).toBe(201);
  return res.body.report as { id: string; version: number };
}

describe('report parameters', () => {
  it('counts markers outside strings and comments', () => {
    expect(countMarkers('SELECT \'?\' FROM T WHERE A = ? -- ?\n AND "?" = ?')).toBe(2);
  });
  it('validates and coerces values on the server, applying defaults', () => {
    const r = resolveParameters(PSQL, PARAMS, { since: '2026-01-31', top: '5' });
    expect(r.bound).toEqual(['North', '2026-01-31', '0', 5]);
    expect(() => resolveParameters(PSQL, PARAMS, { since: '2026-02-30' })).toThrow(/date/);
    expect(() => resolveParameters(PSQL, PARAMS, { since: '2026-01-01', region: 'Mars' })).toThrow(
      /listed/,
    );
    expect(() => resolveParameters(PSQL, PARAMS, { since: '2026-01-01', top: '1.5' })).toThrow(
      /whole/,
    );
    expect(() => resolveParameters(PSQL, PARAMS, {})).toThrow(/Since is required/);
    expect(() => resolveParameters('SELECT 1 FROM T', PARAMS, {})).toThrow(/marker/);
  });
  it('rejects saving a report whose markers do not match its definitions', async () => {
    const a = await login();
    const res = await a
      .send('post', '/api/reports')
      .send({ name: 'Bad', sql: 'SELECT * FROM T WHERE A = ?', parameters: [] });
    expect(res.status).toBe(400);
  });
  it('binds values as Mapepire parameters, never as SQL text, and records them', async () => {
    const a = await login();
    const rep = await createReport(a);
    const hostile = "North' OR '1'='1";
    const bad = await a
      .send('post', `/api/reports/${rep.id}/execute`)
      .send({ values: { since: '2026-01-01', region: hostile } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.region).toMatch(/listed/);
    const ok = await a
      .send('post', `/api/reports/${rep.id}/execute`)
      .send({ values: { region: 'South', since: '2026-03-01', minTotal: '12.50' } });
    expect(ok.status).toBe(200);
    expect(ok.body.parameters).toEqual({
      region: 'South',
      since: '2026-03-01',
      minTotal: '12.50',
      top: null,
    });
    const job = jobs.at(-1)!;
    const i = job.queries.findIndex((q) => q.includes('SALESLIB.ORDERS'));
    expect(job.queries[i]).not.toContain('South');
    expect(job.queryOptions[i]?.parameters).toEqual(['South', '2026-03-01', '12.50', null]);
    const hist = await a.agent.get(`/api/reports/${rep.id}/history`);
    expect(hist.body.executions[0].parameters).toMatchObject({
      region: 'South',
      since: '2026-03-01',
    });
  });
  it('writes parameter values into the XLSX Report Info sheet', async () => {
    const a = await login();
    const rep = await createReport(a);
    const res = await a
      .send('post', '/api/export')
      .send({ reportId: rep.id, values: { since: '2026-04-01' } })
      .buffer(true)
      .parse((r, cb) => {
        const c: Buffer[] = [];
        r.on('data', (d: Buffer) => c.push(d));
        r.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const info = wb.getWorksheet('Report Info')!;
    const rows = new Map<string, unknown>();
    info.eachRow((r) => rows.set(String(r.getCell(1).value), r.getCell(2).value));
    expect(rows.get('Parameter: Since')).toBe('2026-04-01');
    expect(rows.get('Parameter: Region')).toBe('North');
    expect(rows.get('Parameter: Top N')).toBe('(none)');
  });
  it('rejects ? markers with no parameter definitions before anything reaches Db2', async () => {
    const a = await login();
    const before = jobs.length;
    const r = await a
      .send('post', '/api/query/execute')
      .send({ sql: 'SELECT * FROM SALESLIB.ORDERS WHERE ID = ?' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PARAMETERS_NOT_DEFINED');
    const x = await a
      .send('post', '/api/export')
      .send({ sql: 'SELECT * FROM SALESLIB.ORDERS WHERE ID = ?' });
    expect(x.status).toBe(400);
    expect(
      jobs
        .slice(before)
        .flatMap((j) => j.queries)
        .some((q) => q.includes('ORDERS')),
    ).toBe(false);
  });
  it('returns authSource from /auth/me', async () => {
    const a = await login();
    expect((await a.agent.get('/api/auth/me')).body.user.authSource).toBe('LOCAL');
  });
  it('supports parameters on ad-hoc queries', async () => {
    const a = await login();
    const res = await a.send('post', '/api/query/execute').send({
      sql: 'SELECT * FROM SALESLIB.ORDERS WHERE TOTAL > ?',
      parameters: [{ name: 'min', label: 'Min', type: 'integer', required: true }],
      values: { min: '100' },
    });
    expect(res.status).toBe(200);
    expect(jobs.at(-1)!.queryOptions.at(-1)?.parameters).toEqual([100]);
  });
});

describe('sharing and access control', () => {
  it('hides unshared reports (404) from other users on every endpoint', async () => {
    const rep = await createReport(await login());
    const bob = await login('bob');
    expect((await bob.agent.get(`/api/reports/${rep.id}`)).status).toBe(404);
    expect(
      (
        await bob
          .send('post', `/api/reports/${rep.id}/execute`)
          .send({ values: { since: '2026-01-01' } })
      ).status,
    ).toBe(404);
    expect((await bob.send('post', '/api/export').send({ reportId: rep.id })).status).toBe(404);
    expect(
      (await bob.send('put', `/api/reports/${rep.id}/shares`).send({ shares: [] })).status,
    ).toBe(404);
    expect((await bob.agent.get(`/api/reports/${rep.id}/schedules`)).status).toBe(404);
  });
  it('VIEWER can run and export but not edit, delete, share or schedule', async () => {
    const alice = await login();
    const rep = await createReport(alice);
    const s = await alice
      .send('put', `/api/reports/${rep.id}/shares`)
      .send({ shares: [{ type: 'USER', id: 'u-bob', role: 'VIEWER' }] });
    expect(s.status).toBe(200);
    expect(s.body.shares[0]).toMatchObject({ id: 'u-bob', role: 'VIEWER', displayName: 'Bob' });
    const bob = await login('bob');
    const list = await bob.agent.get('/api/reports');
    expect(list.body.reports).toHaveLength(0);
    expect(list.body.shared[0]).toMatchObject({ id: rep.id, access: 'VIEWER', ownerName: 'Alice' });
    expect(
      (
        await bob
          .send('post', `/api/reports/${rep.id}/execute`)
          .send({ values: { since: '2026-01-01' } })
      ).status,
    ).toBe(200);
    const put = await bob
      .send('put', `/api/reports/${rep.id}`)
      .send({ name: 'Hijack', sql: PSQL, parameters: PARAMS, version: rep.version });
    expect(put.status).toBe(403);
    expect((await bob.send('delete', `/api/reports/${rep.id}`)).status).toBe(403);
    expect((await bob.agent.get(`/api/reports/${rep.id}/shares`)).status).toBe(403);
    expect(
      (
        await bob
          .send('post', `/api/reports/${rep.id}/schedules`)
          .send({ cron: '0 7 * * 1', timezone: 'UTC', recipients: ['bob@example.com'] })
      ).status,
    ).toBe(403);
  });
  it('EDITOR (via a group) can edit but not delete or re-share; owner keeps ownership', async () => {
    const alice = await login();
    const rep = await createReport(alice);
    await alice
      .send('put', `/api/reports/${rep.id}/shares`)
      .send({ shares: [{ type: 'GROUP', id: 'finance', role: 'EDITOR' }] });
    const eve = await login('eve');
    const put = await eve
      .send('put', `/api/reports/${rep.id}`)
      .send({ name: 'Orders v2', sql: PSQL, parameters: PARAMS, version: rep.version });
    expect(put.status).toBe(200);
    expect(put.body.report).toMatchObject({
      name: 'Orders v2',
      ownerId: 'u-alice',
      access: 'EDITOR',
    });
    expect((await eve.send('delete', `/api/reports/${rep.id}`)).status).toBe(403);
    expect(
      (await eve.send('put', `/api/reports/${rep.id}/shares`).send({ shares: [] })).status,
    ).toBe(403);
    // revoking removes access immediately
    await alice.send('put', `/api/reports/${rep.id}/shares`).send({ shares: [] });
    expect((await eve.agent.get(`/api/reports/${rep.id}`)).status).toBe(404);
  });
  it('validates share targets', async () => {
    const alice = await login();
    const rep = await createReport(alice);
    const bad = async (shares: unknown) =>
      (await alice.send('put', `/api/reports/${rep.id}/shares`).send({ shares })).status;
    expect(await bad([{ type: 'USER', id: 'u-nobody', role: 'VIEWER' }])).toBe(400);
    expect(await bad([{ type: 'USER', id: 'u-alice', role: 'VIEWER' }])).toBe(400);
    expect(await bad([{ type: 'GROUP', id: 'Bad Group!', role: 'VIEWER' }])).toBe(400);
    expect(await bad([{ type: 'USER', id: 'u-bob', role: 'OWNER' }])).toBe(400);
  });
  it('user search excludes the caller and lists groups', async () => {
    const alice = await login();
    const r = await alice.agent.get('/api/users?search=b');
    expect(r.body.users.map((u: { username: string }) => u.username)).toEqual(['bob']);
    expect((await alice.agent.get('/api/groups')).body.groups).toEqual(['finance']);
  });
});

describe('OIDC and LDAP sign-in', () => {
  it('advertises providers', async () => {
    const r = await request(built.app).get('/api/auth/providers');
    expect(r.body).toEqual({
      local: true,
      oidc: { label: 'Contoso SSO (fake)', startUrl: '/api/auth/oidc/start' },
      ldap: { label: 'Corporate directory (fake)' },
    });
  });
  it('completes the code flow with a signed state cookie, maps groups and provisions the user', async () => {
    const agent = request.agent(built.app);
    const start = await agent.get('/api/auth/oidc/start');
    expect(start.status).toBe(302);
    const cookie = String(start.headers['set-cookie']);
    expect(cookie).toMatch(/qf_oidc=.*HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const cb = await agent.get(start.headers.location);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({
      username: 'carol@example.com',
      role: 'USER',
      authSource: 'OIDC',
    });
    expect(me.body.groups).toEqual(['finance']);
    const u = [...db.users.values()].find((x) => x.USERNAME === 'carol@example.com')!;
    expect(u.PASSWORD_HASH).toBe('!');
    expect(u.AUTH_SOURCE).toBe('OIDC');
    // the provisioned account cannot be used with a local password
    const local = await request(built.app)
      .post('/api/auth/login')
      .send({ username: 'carol@example.com', password: '!' });
    expect(local.status).toBe(401);
  });
  it('rejects a callback without the state cookie or with a tampered state', async () => {
    const r1 = await request(built.app).get('/api/auth/oidc/callback?code=x&state=y');
    expect(r1.headers.location).toBe('/login?sso_error=SSO_STATE_MISSING');
    const agent = request.agent(built.app);
    await agent.get('/api/auth/oidc/start');
    const r2 = await agent.get('/api/auth/oidc/callback?code=abc&state=forged');
    expect(r2.headers.location).toBe('/login?sso_error=SSO_STATE_MISMATCH');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
  it('never takes over an existing local account with the same username', async () => {
    oidc.next = { username: 'alice', externalId: 'iss|evil' };
    const agent = request.agent(built.app);
    const start = await agent.get('/api/auth/oidc/start');
    const cb = await agent.get(start.headers.location);
    expect(cb.headers.location).toBe('/login?sso_error=USERNAME_TAKEN');
  });
  it('signs in with LDAP and grants admin via ADMIN_GROUPS', async () => {
    const bad = await request(built.app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'dave', password: 'wrong', method: 'ldap' });
    expect(bad.status).toBe(401);
    const ok = await request(built.app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'dave', password: 'directory-pass', method: 'ldap' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ username: 'dave', role: 'ADMIN', authSource: 'LDAP' });
  });
  it('can disable local sign-in when SSO is configured', async () => {
    const app = build({
      AUTH_LOCAL_ENABLED: 'false',
      OIDC_ISSUER_URL: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'qf',
      OIDC_REDIRECT_URI: 'http://localhost:5173/api/auth/oidc/callback',
    }).app;
    const r = await request(app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'alice', password: PW });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('LOCAL_DISABLED');
  });
  it('maps groups case-insensitively and drops unmapped ones; escapes LDAP filters', () => {
    const m = parseGroupMap('Finance-Readers=finance; CN=QF Admins,OU=G,DC=x=qf-admins');
    expect(mapExternalGroups(['finance-readers', 'other', 'cn=qf admins,ou=g,dc=x'], m)).toEqual([
      'finance',
      'qf-admins',
    ]);
    expect(escapeLdapFilter('a*b(c)\\d\0')).toBe('a\\2ab\\28c\\29\\5cd\\00');
    expect(cnOf('CN=QF Admins,OU=Groups,DC=example')).toBe('QF Admins');
    expect(
      identityFromClaims(
        { iss: 'https://i', sub: 's1', preferred_username: 'x', groups: 'g' },
        { usernameClaim: 'preferred_username', groupsClaim: 'groups' },
      ),
    ).toMatchObject({ externalId: 'https://i|s1', username: 'x', groups: ['g'] });
  });
});

describe('scheduled runs', () => {
  const sched = {
    cron: '0 7 * * 1',
    timezone: 'America/Edmonton',
    recipients: ['ops@example.com'],
    parameters: { since: '2026-01-01' },
  };

  it('validates cron, minimum interval, time zone and recipient allowlist', async () => {
    expect(() => validateCron('* * * * *', 'UTC', 15)).toThrow(/at most once every 15/);
    expect(() => validateCron('0 7 * *', 'UTC', 15)).toThrow(/5-field/);
    expect(() => validateCron('0 7 * * 1', 'Mars/Base', 15)).toThrow(/time zone/);
    expect(
      checkRecipients(['a@evil.test'], { recipientDomains: ['example.com'], maxRecipients: 5 }).ok,
    ).toBe(false);
    expect(
      checkRecipients('A@Example.com, b@example.com', {
        recipientDomains: ['example.com'],
        maxRecipients: 5,
      }),
    ).toEqual({ ok: true, recipients: ['a@example.com', 'b@example.com'] });
    const a = await login();
    const rep = await createReport(a);
    const post = (b: object) =>
      a.send('post', `/api/reports/${rep.id}/schedules`).send({ ...sched, ...b });
    expect((await post({ recipients: ['x@gmail.com'] })).body.error.code).toBe(
      'INVALID_RECIPIENTS',
    );
    expect((await post({ cron: '*/5 * * * *' })).body.error.code).toBe('SCHEDULE_TOO_FREQUENT');
    expect((await post({ parameters: {} })).body.error.code).toBe('INVALID_PARAMETERS');
    const ok = await post({});
    expect(ok.status).toBe(201);
    expect(ok.body.schedule).toMatchObject({
      enabled: true,
      lastStatus: 'NEVER',
      recipients: ['ops@example.com'],
    });
    expect(new Date(ok.body.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('runs due schedules once across instances (Db2 lease + conditional claim) and emails the XLSX', async () => {
    const a = await login();
    const rep = await createReport(a);
    await a.send('post', `/api/reports/${rep.id}/schedules`).send(sched);
    const other = build({}, db); // second app instance sharing the same metadata store
    const later = new Date(Date.now() + 8 * 86400_000);
    const [r1, r2] = await Promise.all([built.scheduler.tick(later), other.scheduler.tick(later)]);
    expect(r1.length + r2.length).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.to).toEqual(['ops@example.com']);
    expect(m.attachments[0].filename).toMatch(/\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(m.attachmentData[0] as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Report Info')).toBeTruthy();
    const s = (await a.agent.get('/api/schedules')).body.schedules[0];
    expect(s).toMatchObject({ lastStatus: 'SUCCEEDED', failureCount: 0 });
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(later.getTime());
    const exec = [...db.executions.values()].find((e) => e.KIND === 'SCHEDULE')!;
    expect(exec).toMatchObject({ USER_ID: 'u-alice', SCHEDULE_ID: s.id, STATUS: 'SUCCEEDED' });
    // the same instant again: nothing due
    expect(await built.scheduler.tick(later)).toEqual([]);
  });

  it('records failures and auto-disables after SCHEDULE_MAX_FAILURES', async () => {
    built = build({ SCHEDULE_MAX_FAILURES: '2' });
    const a = await login();
    const rep = await createReport(a);
    const s = (await a.send('post', `/api/reports/${rep.id}/schedules`).send(sched)).body.schedule;
    mailer.failNext = new Error('SMTP 554 rejected');
    const r1 = (await a.send('post', `/api/schedules/${s.id}/run`)).body;
    expect(r1.result).toMatchObject({ status: 'FAILED', disabled: false });
    expect(r1.schedule).toMatchObject({ lastStatus: 'FAILED', failureCount: 1, enabled: true });
    expect(r1.schedule.lastError).toMatch(/554/);
    mailer.failNext = new Error('SMTP 554 rejected');
    const r2 = (await a.send('post', `/api/schedules/${s.id}/run`)).body;
    expect(r2.result.disabled).toBe(true);
    expect(r2.schedule.enabled).toBe(false);
    // re-enabling resets the failure counter
    const re = await a
      .send('put', `/api/schedules/${s.id}`)
      .send({ ...sched, enabled: true, version: r2.schedule.version });
    expect(re.status).toBe(200);
    expect(re.body.schedule).toMatchObject({ enabled: true, failureCount: 0 });
  });

  it('re-checks authority at run time: a schedule fails if its creator lost edit access', async () => {
    const alice = await login();
    const rep = await createReport(alice);
    await alice
      .send('put', `/api/reports/${rep.id}/shares`)
      .send({ shares: [{ type: 'USER', id: 'u-bob', role: 'EDITOR' }] });
    const bob = await login('bob');
    const s = (await bob.send('post', `/api/reports/${rep.id}/schedules`).send(sched)).body
      .schedule;
    expect(s.createdBy).toBe('u-bob');
    await alice.send('put', `/api/reports/${rep.id}/shares`).send({ shares: [] });
    const fresh = (await alice.agent.get('/api/schedules')).body.schedules[0];
    const res = await built.scheduler.run(fresh);
    expect(res.status).toBe('FAILED');
    expect(mailer.sent).toHaveLength(0);
    expect((await bob.send('delete', `/api/schedules/${s.id}`)).status).toBe(404);
  });

  it('refuses to send when no recipient domains are configured', async () => {
    built = build({ SCHEDULE_RECIPIENT_DOMAINS: '' });
    const a = await login();
    const rep = await createReport(a);
    const r = await a.send('post', `/api/reports/${rep.id}/schedules`).send(sched);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/SCHEDULE_RECIPIENT_DOMAINS/);
  });
});

describe('migration 002', () => {
  it('adds parameters, identities, sharing, schedules and the lease table', () => {
    const m = loadMigrations('QFMETA').find((x) => x.version === 2)!;
    expect(m).toBeTruthy();
    const sql = m.statements.join('\n').toUpperCase();
    for (const t of ['QF_USER_GROUPS', 'QF_REPORT_SHARES', 'QF_SCHEDULES', 'QF_LOCKS'])
      expect(sql).toContain(`CREATE TABLE QFMETA.${t}`);
    expect(sql).toContain('ADD COLUMN PARAMETERS_JSON');
    expect(sql).toContain('AUTH_SOURCE');
    expect(sql).toMatch(/ON DELETE CASCADE/);
    expect(sql).not.toMatch(/\bDROP TABLE\b/);
  });
});
