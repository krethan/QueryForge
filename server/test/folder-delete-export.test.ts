import bcrypt from 'bcryptjs';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadMigrations } from '../scripts/migrate.js';
import { errorHandler, FOLDER_AUDIT_CSV_HEADER } from '../src/routes/api.js';
import {
  attachmentHeader,
  CSV_BOM,
  csvCell,
  csvFileName,
  csvLine,
  streamCsv,
} from '../src/export/csv.js';
import { folderDeletionsQuerySchema } from '../src/reports/folders.js';
import { expectedSchema, lintMigrations } from '../scripts/verify/expected.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// Folder deletion audit (migration 013) and folder audit CSV export. Fakes only: no IBM i is
// involved, and nothing here proves the SQL runs on Db2 for i.
const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
const SQL = 'SELECT 1 AS N FROM SYSIBM.SYSDUMMY1';

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

const newFolder = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string; name: string };
};
const newReport = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/reports').send({ name, sql: SQL });
  expect(res.status).toBe(201);
  return res.body.report as { id: string };
};
const shareFolder = (c: Client, id: string, shares: unknown[], shareReports?: Role | null) =>
  c
    .send('put', `/api/folders/${id}/shares`)
    .send(shareReports === undefined ? { shares } : { shares, shareReports });
const USER = (id: string, role: Role = 'VIEWER') => ({ type: 'USER', id, role });
const GROUP = (id: string, role: Role = 'VIEWER') => ({ type: 'GROUP', id, role });
const del = (c: Client, id: string) => c.send('delete', `/api/folders/${id}`);
const exportCsv = (c: Client, id: string) =>
  c.agent.get(`/api/folders/${id}/audit/export`).buffer(true);

/** Minimal RFC 4180 parser for checking what a spreadsheet would read. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}
const csvBody = (res: { text: string }) => {
  expect(res.text.startsWith(CSV_BOM)).toBe(true);
  return parseCsv(res.text.slice(1));
};

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
  db.addGroup('u-carol', 'finance.team');
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  app = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
  alice = await login('alice');
  bob = await login('bob');
  carol = await login('carol');
  admin = await login('admin');
});

describe('migration 013: folder deletion audit', () => {
  const migs = loadMigrations('QFMETA');
  const m = migs.find((x) => x.version === 13)!;
  const sql = m.statements.join('\n');
  it('is additive: one new table with two indexes and a label, and no foreign keys', () => {
    expect(m.file).toBe('013_folder_deletion_audit.sql');
    expect(m.statements).toHaveLength(4);
    expect(m.statements[0]).toMatch(/^CREATE TABLE QFMETA\.QF_FOLDER_DELETIONS \(/);
    expect(m.statements[1]).toMatch(/^CREATE INDEX QFMETA\.QF_FDEL_IX_TIME ON /);
    expect(m.statements[2]).toMatch(/^CREATE INDEX QFMETA\.QF_FDEL_IX_FOLDER ON /);
    expect(m.statements[3]).toMatch(/^LABEL ON TABLE QFMETA\.QF_FOLDER_DELETIONS IS '/);
    // It must outlive the folder and the users it names: nothing may cascade it away.
    expect(sql).not.toMatch(/FOREIGN KEY|REFERENCES|ON DELETE/);
    expect(sql).not.toMatch(/\b(ALTER|UPDATE|DELETE FROM|INSERT|DROP)\b/);
    expect(sql).not.toContain('{{SCHEMA}}');
  });
  it('is understood by the verification kit, with labels inside the Db2 for i limits', () => {
    const e = expectedSchema();
    expect(e.unparsed).toEqual([]);
    expect(lintMigrations()).toEqual([]);
    expect(e.tables.find((t) => t.name === 'QF_FOLDER_DELETIONS')).toMatchObject({
      migration: 13,
      label: 'Uncle Bob folder deletion audit trail',
    });
    expect(
      e.constraints
        .filter((c) => c.table === 'QF_FOLDER_DELETIONS')
        .map((c) => [c.name, c.type])
        .sort(),
    ).toEqual([
      ['QF_FDEL_CK_COUNTS', 'CHECK'],
      ['QF_FDEL_CK_ROLE', 'CHECK'],
      ['QF_FDEL_PK', 'PRIMARY KEY'],
    ]);
    expect(e.indexes.filter((i) => i.table === 'QF_FOLDER_DELETIONS').map((i) => i.name)).toEqual([
      'QF_FDEL_IX_TIME',
      'QF_FDEL_IX_FOLDER',
    ]);
    // The existing audit tables still have no foreign key to the folder either.
    expect(
      e.constraints.filter((c) => c.type === 'FOREIGN KEY' && /AUDIT|DELETIONS/.test(c.table)),
    ).toEqual([]);
  });
});

describe('deleting a folder is audited', () => {
  it('records who, when, the name and what the folder had, and revokes in the sharing trail', async () => {
    const f = await newFolder(alice, 'Finance');
    const r1 = await newReport(alice, 'Ledger');
    const r2 = await newReport(alice, 'Budget');
    expect(
      (await alice.send('put', `/api/reports/${r1.id}/prefs`).send({ folderId: f.id })).status,
    ).toBe(200);
    expect(
      (await alice.send('post', `/api/folders/${f.id}/reports`).send({ reportId: r2.id })).status,
    ).toBe(200);
    expect(
      (await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), GROUP('finance.team')], 'VIEWER'))
        .status,
    ).toBe(200);
    const before = db.folderShareAudit.length;
    const res = await del(alice, f.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moved: 1 });
    expect(db.folders.has(f.id)).toBe(false);
    expect(db.folderDeletions).toEqual([
      expect.objectContaining({
        FOLDER_ID: f.id,
        FOLDER_NAME: 'Finance',
        OWNER_ID: 'u-alice',
        ACTOR_ID: 'u-alice',
        SHARE_COUNT: 2,
        PLACED_COUNT: 1,
        FILED_COUNT: 1,
        REPORTS_ROLE: 'VIEWER',
      }),
    ]);
    const revokes = db.folderShareAudit.slice(before);
    expect(
      revokes.map((a) => [a.ACTION, a.PRINCIPAL_TYPE, a.PRINCIPAL_ID, a.OLD_ROLE, a.NEW_ROLE]),
    ).toEqual([
      ['REVOKE', 'GROUP', 'finance.team', 'VIEWER', null],
      ['REVOKE', 'USER', 'u-bob', 'EDITOR', null],
      ['REVOKE', 'REPORTS', '*REPORTS', 'VIEWER', null],
    ]);
    for (const a of revokes) expect(a.ACTOR_ID).toBe('u-alice');
    // The reports themselves are untouched.
    expect(db.reports.has(r1.id) && db.reports.has(r2.id)).toBe(true);
  });

  it('records a personal (never shared) folder with zero counts and no sharing rows', async () => {
    const f = await newFolder(alice, 'Scratch');
    expect((await del(alice, f.id)).status).toBe(200);
    expect(db.folderDeletions).toEqual([
      expect.objectContaining({
        FOLDER_NAME: 'Scratch',
        SHARE_COUNT: 0,
        PLACED_COUNT: 0,
        FILED_COUNT: 0,
        REPORTS_ROLE: null,
      }),
    ]);
    expect(db.folderShareAudit).toEqual([]);
  });

  it('records nothing when the delete is refused', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR')]);
    const before = db.folderShareAudit.length;
    expect((await del(bob, f.id)).status).toBe(403);
    expect((await del(carol, f.id)).status).toBe(404);
    expect((await del(admin, f.id)).status).toBe(403);
    expect(db.folderDeletions).toEqual([]);
    expect(db.folderShareAudit).toHaveLength(before);
    expect(db.folders.has(f.id)).toBe(true);
  });

  it('keeps the folder and its shares when the audit row cannot be written', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob')]);
    const before = db.folderShareAudit.length;
    const real = db.update.bind(db);
    const spy = vi.spyOn(db, 'update').mockImplementation(async (sql, params) => {
      if (/INSERT INTO \w+\.QF_FOLDER_DELETIONS/.test(sql)) throw new Error('disk full');
      return real(sql, params);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await del(alice, f.id)).status).toBe(500);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
    expect(db.folders.has(f.id)).toBe(true);
    expect(db.folderShares.filter((s) => s.FOLDER_ID === f.id)).toHaveLength(1);
    expect(db.folderShareAudit).toHaveLength(before);
    expect(db.folderDeletions).toEqual([]);
  });

  it('keeps the deletion record after the owner is gone (no foreign keys)', async () => {
    const f = await newFolder(alice, 'Finance');
    await del(alice, f.id);
    db.users.delete('u-alice');
    const res = await admin.agent.get('/api/admin/folder-deletions');
    expect(res.status).toBe(200);
    expect(res.body.deletions).toEqual([
      expect.objectContaining({ folderId: f.id, ownerId: 'u-alice', folderName: 'Finance' }),
    ]);
    expect(res.body.deletions[0].ownerName).toBeUndefined();
  });
});

describe('GET /api/admin/folder-deletions (app admins only)', () => {
  it('lists deletions newest first with names and counts', async () => {
    const a = await newFolder(alice, 'Alpha');
    const b = await newFolder(bob, 'Beta');
    await shareFolder(bob, b.id, [USER('u-carol')], 'EDITOR');
    await del(alice, a.id);
    await del(bob, b.id);
    const res = await admin.agent.get('/api/admin/folder-deletions');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 50, offset: 0, hasMore: false });
    expect(res.body.deletions).toEqual([
      expect.objectContaining({
        folderId: b.id,
        folderName: 'Beta',
        ownerName: 'Bob',
        actorName: 'Bob',
        shareCount: 1,
        reportsRole: 'EDITOR',
        deletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      }),
      expect.objectContaining({ folderId: a.id, folderName: 'Alpha', shareCount: 0 }),
    ]);
  });

  it('pages with limit / offset and validates them', async () => {
    for (const n of ['A', 'B', 'C']) await del(alice, (await newFolder(alice, n)).id);
    const p1 = await admin.agent.get('/api/admin/folder-deletions?limit=2');
    expect(p1.body).toMatchObject({ hasMore: true, limit: 2 });
    expect(p1.body.deletions.map((d: { folderName: string }) => d.folderName)).toEqual(['C', 'B']);
    const p2 = await admin.agent.get('/api/admin/folder-deletions?limit=2&offset=2');
    expect(p2.body.hasMore).toBe(false);
    expect(p2.body.deletions.map((d: { folderName: string }) => d.folderName)).toEqual(['A']);
    expect((await admin.agent.get('/api/admin/folder-deletions?limit=0')).status).toBe(400);
    expect(folderDeletionsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(folderDeletionsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('is refused to everyone else, including the owner of the deleted folder', async () => {
    const f = await newFolder(alice, 'Finance');
    await del(alice, f.id);
    for (const c of [alice, bob]) {
      const res = await c.agent.get('/api/admin/folder-deletions');
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Finance');
      expect((await c.agent.get(`/api/admin/folder-deletions/${f.id}/audit`)).status).toBe(403);
      expect((await c.agent.get(`/api/admin/folder-deletions/${f.id}/audit/export`)).status).toBe(
        403,
      );
    }
    expect((await request(app).get('/api/admin/folder-deletions')).status).toBe(401);
  });
});

describe("a deleted folder's sharing history (admins)", () => {
  it('can be read and exported after the folder is gone', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob')], 'VIEWER');
    await del(alice, f.id);
    const page = await admin.agent.get(`/api/admin/folder-deletions/${f.id}/audit`);
    expect(page.status).toBe(200);
    expect(page.body.deletion).toMatchObject({ folderId: f.id, folderName: 'Finance' });
    expect(page.body.events.map((e: { action: string }) => e.action)).toEqual([
      'REVOKE',
      'REVOKE',
      'GRANT',
      'GRANT',
    ]);
    const csv = await admin.agent
      .get(`/api/admin/folder-deletions/${f.id}/audit/export`)
      .buffer(true);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('filename="Finance audit - deleted.csv"');
    const rows = csvBody(csv);
    expect(rows[0]).toEqual([...FOLDER_AUDIT_CSV_HEADER]);
    expect(rows.slice(1).map((r) => r[1])).toEqual(['REVOKE', 'REVOKE', 'GRANT', 'GRANT']);
    expect(rows.slice(1).every((r) => r[10] === 'Finance')).toBe(true);
  });

  it('is 404 for a folder that still exists, even a shared one, and for unknown IDs', async () => {
    const live = await newFolder(alice, 'Live');
    await shareFolder(alice, live.id, [USER('u-bob')]);
    const personal = await newFolder(alice, 'Personal');
    for (const id of [live.id, personal.id, '00000000-0000-4000-8000-000000000000']) {
      expect((await admin.agent.get(`/api/admin/folder-deletions/${id}/audit`)).status).toBe(404);
      expect((await admin.agent.get(`/api/admin/folder-deletions/${id}/audit/export`)).status).toBe(
        404,
      );
    }
    expect((await admin.agent.get('/api/admin/folder-deletions/not-a-uuid/audit')).status).toBe(
      404,
    );
  });
});

describe('GET /api/folders/:id/audit/export (CSV)', () => {
  it('streams the whole history newest first as UTF-8 CSV, matching the JSON audit', async () => {
    const f = await newFolder(alice, 'Finance');
    await shareFolder(alice, f.id, [USER('u-bob')]);
    await shareFolder(alice, f.id, [USER('u-bob', 'EDITOR'), GROUP('finance.team')], 'VIEWER');
    const res = await exportCsv(alice, f.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Finance audit.csv"; filename*=UTF-8''Finance%20audit.csv`,
    );
    expect(res.text).toMatch(/\r\n$/);
    const rows = csvBody(res);
    expect(rows[0]).toEqual([...FOLDER_AUDIT_CSV_HEADER]);
    const json = (await alice.agent.get(`/api/folders/${f.id}/audit?limit=100`)).body.events as {
      occurredAt: string;
      action: string;
      principalId: string;
    }[];
    expect(rows).toHaveLength(json.length + 1);
    expect(rows.slice(1).map((r) => [r[0], r[1], r[3]])).toEqual(
      json.map((e) => [e.occurredAt, e.action, e.principalId]),
    );
    const bobChange = rows.find((r) => r[1] === 'CHANGE')!;
    expect(bobChange).toEqual([
      expect.stringMatching(/Z$/),
      'CHANGE',
      'USER',
      'u-bob',
      'Bob',
      'VIEWER',
      'EDITOR',
      'u-alice',
      'Alice',
      f.id,
      'Finance',
      expect.any(String),
    ]);
  });

  it('writes just the header for a folder with no history', async () => {
    const f = await newFolder(alice, 'Empty');
    const rows = csvBody(await exportCsv(alice, f.id));
    expect(rows).toEqual([[...FOLDER_AUDIT_CSV_HEADER]]);
  });

  it('follows the audit access rule: owner and admin yes, viewers / editors 403, others 404', async () => {
    const shared = await newFolder(alice, 'Shared');
    await shareFolder(alice, shared.id, [USER('u-bob', 'EDITOR'), GROUP('finance.team')]);
    const personal = await newFolder(alice, 'Personal');
    expect((await exportCsv(alice, shared.id)).status).toBe(200);
    expect((await exportCsv(admin, shared.id)).status).toBe(200);
    expect((await exportCsv(bob, shared.id)).status).toBe(403);
    expect((await exportCsv(carol, shared.id)).status).toBe(403);
    expect((await exportCsv(bob, personal.id)).status).toBe(404);
    // An admin cannot read a personal folder's history, exactly as with the JSON audit.
    expect((await exportCsv(admin, personal.id)).status).toBe(404);
    expect((await exportCsv(alice, 'not-a-uuid')).status).toBe(404);
    expect((await request(app).get(`/api/folders/${shared.id}/audit/export`)).status).toBe(401);
    const refused = await exportCsv(bob, shared.id);
    expect(refused.headers['content-type']).toMatch(/application\/json/);
  });

  it('neutralises formulas and escapes quotes, commas and line breaks', async () => {
    db.addUser({
      id: 'u-mallory',
      username: 'mallory',
      hash,
      displayName: '=HYPERLINK("http://evil.example","x")',
    });
    db.addUser({ id: 'u-plus', username: 'plus', hash, displayName: '+1-555, "Q"\nNext' });
    db.addUser({ id: 'u-at', username: 'at', hash, displayName: '@SUM(A1)' });
    db.addUser({ id: 'u-minus', username: 'minus', hash, displayName: '-2+3' });
    db.addUser({ id: 'u-uni', username: 'uni', hash, displayName: 'Zoë 日本 ＝1' });
    const f = await newFolder(alice, '=cmd|calc');
    await shareFolder(
      alice,
      f.id,
      ['u-mallory', 'u-plus', 'u-at', 'u-minus', 'u-uni'].map((id) => USER(id)),
    );
    const res = await exportCsv(alice, f.id);
    expect(res.status).toBe(200);
    // Every cell is quoted; nothing unquoted can start with a trigger.
    expect(res.text).not.toMatch(/(^|,)[=+\-@]/m);
    const names = new Map(
      csvBody(res)
        .slice(1)
        .map((r) => [r[3], r[4]]),
    );
    expect(names.get('u-mallory')).toBe(`'=HYPERLINK("http://evil.example","x")`);
    expect(names.get('u-plus')).toBe(`'+1-555, "Q"\nNext`);
    expect(names.get('u-at')).toBe(`'@SUM(A1)`);
    expect(names.get('u-minus')).toBe(`'-2+3`);
    expect(names.get('u-uni')).toBe('Zoë 日本 ＝1');
    expect(csvBody(res)[1][10]).toBe(`'=cmd|calc`);
    // Raw UTF-8 bytes, not mojibake.
    expect(Buffer.from(res.text, 'utf8').includes(Buffer.from('Zoë 日本', 'utf8'))).toBe(true);
    expect(res.headers['content-disposition']).toContain('filename="_cmd_calc audit.csv"');
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''%3Dcmd%7Ccalc%20audit.csv",
    );
  });

  it('reads long histories in keyset batches, with no truncation, repeats or OFFSET', async () => {
    const f = await newFolder(alice, 'Busy');
    // 1,234 rows, many sharing a timestamp, so the AUDIT_ID tie-break carries across batches.
    const total = 1234;
    for (let i = 0; i < total; i++)
      db.folderShareAudit.push({
        AUDIT_ID: `a-${String(i).padStart(5, '0')}`,
        FOLDER_ID: f.id,
        ACTION: 'GRANT',
        PRINCIPAL_TYPE: 'USER',
        PRINCIPAL_ID: 'u-bob',
        OLD_ROLE: null,
        NEW_ROLE: 'VIEWER',
        ACTOR_ID: 'u-alice',
        OCCURRED_AT: `2026-01-01 00:00:${String(Math.floor(i / 7) % 60).padStart(2, '0')}.${String(Math.floor(i / 420)).padStart(6, '0')}`,
      });
    db.statements = [];
    const res = await exportCsv(alice, f.id);
    expect(res.status).toBe(200);
    const rows = csvBody(res).slice(1);
    expect(rows).toHaveLength(total);
    const expected = db.folderShareAudit
      .filter((a) => a.FOLDER_ID === f.id)
      .sort(
        (a, b) =>
          String(b.OCCURRED_AT).localeCompare(String(a.OCCURRED_AT)) ||
          String(a.AUDIT_ID).localeCompare(String(b.AUDIT_ID)),
      )
      .map((a) => String(a.AUDIT_ID));
    expect(rows.map((r) => r[11])).toEqual(expected);
    expect(new Set(rows.map((r) => r[11])).size).toBe(total);
    // ceil(1234 / 500) = 3 batches, the first without a cursor, the rest keyset, none OFFSET.
    const reads = db.statements.filter((s) => s.sql.includes('QF_FOLDER_SHARE_AUDIT'));
    expect(reads).toHaveLength(3);
    for (const s of reads) expect(s.sql).not.toMatch(/OFFSET/);
    expect(reads[0].params).toEqual([f.id]);
    expect(reads.slice(1).map((s) => s.params.length)).toEqual([4, 4]);
    // The cursor is the last row of the previous batch, timestamp exactly as read.
    const last = db.folderShareAudit.find((a) => a.AUDIT_ID === expected[499])!;
    expect(reads[1].params).toEqual([f.id, last.OCCURRED_AT, last.OCCURRED_AT, expected[499]]);
  });

  it('reads one extra (empty) batch when the history is an exact multiple of the batch', async () => {
    const f = await newFolder(alice, 'Exact');
    for (let i = 0; i < 500; i++)
      db.folderShareAudit.push({
        AUDIT_ID: `b-${String(i).padStart(4, '0')}`,
        FOLDER_ID: f.id,
        ACTION: 'GRANT',
        PRINCIPAL_TYPE: 'GROUP',
        PRINCIPAL_ID: 'g',
        OLD_ROLE: null,
        NEW_ROLE: 'VIEWER',
        ACTOR_ID: 'u-alice',
        OCCURRED_AT: '2026-01-01 00:00:00.000000',
      });
    db.statements = [];
    expect(csvBody(await exportCsv(alice, f.id))).toHaveLength(501);
    expect(db.statements.filter((s) => s.sql.includes('QF_FOLDER_SHARE_AUDIT'))).toHaveLength(2);
  });
});

describe('CSV helpers', () => {
  it('quotes every cell and guards formula triggers', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
    for (const t of ['=', '+', '-', '@', '\t', '\r', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20'])
      expect(csvCell(`${t}1`)).toBe(`"'${t}1"`);
    expect(csvCell('a=b')).toBe('"a=b"');
    expect(csvCell('x\uD800y')).toBe('"x\uFFFDy"');
    expect(csvCell('😀')).toBe('"😀"');
    expect(csvLine(['a', null, 1])).toBe('"a","","1"\r\n');
  });
  it('builds safe file names and Content-Disposition', () => {
    expect(csvFileName('Q3 "Sales"/EU', 'x')).toBe('Q3 _Sales_EU.csv');
    expect(csvFileName('日本', 'folder-audit')).toBe('_.csv');
    expect(csvFileName('', 'folder-audit')).toBe('folder-audit.csv');
    expect(attachmentHeader('a.csv', "Zoë's (1).csv")).toBe(
      `attachment; filename="a.csv"; filename*=UTF-8''Zo%C3%AB%27s%20%281%29.csv`,
    );
  });
  it('turns a failure before the first row into a normal JSON error', async () => {
    const mini = express();
    mini.get('/x', (req, res, next) => {
      streamCsv(
        res,
        { filename: 'x.csv', header: ['A'] },
        {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('boom')),
          }),
        } as AsyncIterable<string[]>,
        (r: string) => [r],
      ).catch(next);
    });
    mini.use(errorHandler);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(mini).get('/x');
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
  it('cuts the connection, rather than ending cleanly, when a later batch fails', async () => {
    const mini = express();
    mini.get('/x', (req, res, next) => {
      streamCsv(
        res,
        { filename: 'x.csv', header: ['A'] },
        (async function* () {
          yield ['one'];
          throw new Error('boom');
        })(),
        (r: string) => [r],
      ).catch(next);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(request(mini).get('/x').buffer(true)).rejects.toThrow();
    err.mockRestore();
  });
});
