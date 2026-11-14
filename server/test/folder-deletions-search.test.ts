import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { FOLDER_DELETIONS_CSV_HEADER } from '../src/routes/api.js';
import { CSV_BOM } from '../src/export/csv.js';
import {
  decodeFolderDeletionCursor,
  encodeFolderDeletionCursor,
  folderDeletionsQuerySchema,
  FolderRepository,
  MAX_FOLDER_DELETION_SEARCH,
} from '../src/reports/folders.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// Admin Deleted folders: search, "deleted by" and date filters, total count, keyset paging and
// the filtered CSV export. Fakes only: no IBM i is involved, and nothing here proves the SQL
// runs on Db2 for i (the fake evaluates the generated WHERE clause marker by marker).
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

/** Clock the fake's CURRENT TIMESTAMP reads, so deletion times can be placed. */
let now = new Date('2026-11-01T12:00:00.000Z');
const at = (iso: string) => {
  now = new Date(iso);
};

const make = async (c: Client, name: string) => {
  const res = await c.send('post', '/api/folders').send({ name });
  expect(res.status).toBe(201);
  const id = res.body.folder.id as string;
  expect((await c.send('delete', `/api/folders/${id}`)).status).toBe(200);
  return id;
};
type Body = {
  deletions: { folderName: string; folderId: string; ownerName?: string; actorId: string }[];
  hasMore: boolean;
  total: number;
  next: string | null;
  limit: number;
  offset: number;
};
const list = async (c: Client, query: Record<string, string | number>) => {
  const res = await c.agent.get('/api/admin/folder-deletions').query(query);
  expect(res.status).toBe(200);
  return res.body as Body;
};
const names = (b: Body) => b.deletions.map((d) => d.folderName);

let alice: Client;
let bob: Client;
let admin: Client;

beforeEach(async () => {
  db = new FakeMetadataDb();
  now = new Date('2026-11-01T12:00:00.000Z');
  db.dbClock = () => now;
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice Archer' });
  db.addUser({ id: 'u-bob', username: 'bob.smith', hash, displayName: 'Bob' });
  db.addUser({ id: 'u-admin', username: 'admin', hash, displayName: 'Ada Admin', role: 'ADMIN' });
  const f = fakeFactory(() => ({ columns: [col('N', 'INTEGER')], rows: [[1]] }));
  app = createApp({ cfg: testConfig(), metadataDb: db, jobFactory: f.factory }).app;
  alice = await login('alice');
  bob = await login('bob.smith');
  admin = await login('admin');
});

describe('GET /api/admin/folder-deletions: search and filters', () => {
  beforeEach(async () => {
    at('2026-11-01T09:00:00.000Z');
    await make(alice, 'Q3 Close');
    at('2026-11-02T09:00:00.000Z');
    await make(alice, 'Budget 2025');
    at('2026-11-03T09:00:00.000Z');
    await make(bob, 'close-out notes');
    at('2026-11-04T09:00:00.000Z');
    await make(bob, 'Scratch');
  });

  it('returns the total with every page, unfiltered', async () => {
    const b = await list(admin, { limit: 2 });
    expect(b).toMatchObject({ total: 4, hasMore: true, limit: 2, offset: 0 });
    expect(names(b)).toEqual(['Scratch', 'close-out notes']);
    expect(typeof b.next).toBe('string');
  });

  it('searches folder names in any case', async () => {
    const b = await list(admin, { q: 'CLOSE' });
    expect(names(b)).toEqual(['close-out notes', 'Q3 Close']);
    expect(b).toMatchObject({ total: 2, hasMore: false, next: null });
    expect(names(await list(admin, { q: '  budget  ' }))).toEqual(['Budget 2025']);
  });

  it("searches the owner's display name, username and user ID", async () => {
    expect(names(await list(admin, { q: 'archer' }))).toEqual(['Budget 2025', 'Q3 Close']);
    expect(names(await list(admin, { q: 'BOB.SM' }))).toEqual(['Scratch', 'close-out notes']);
    expect(names(await list(admin, { q: 'u-bob' }))).toEqual(['Scratch', 'close-out notes']);
    // An owner who is no longer in QF_USERS is still found by ID (but not by a name).
    db.users.delete('u-alice');
    expect(names(await list(admin, { q: 'u-alice' }))).toEqual(['Budget 2025', 'Q3 Close']);
    expect((await list(admin, { q: 'archer' })).total).toBe(0);
  });

  it('treats %, _ and \\ in the search as literal characters', async () => {
    at('2026-11-05T09:00:00.000Z');
    await make(alice, '100%_done');
    await make(alice, '100xxdone');
    await make(alice, 'a\\b');
    expect(names(await list(admin, { q: '%' }))).toEqual(['100%_done']);
    expect(names(await list(admin, { q: '_' }))).toEqual(['100%_done']);
    expect(names(await list(admin, { q: '0%_d' }))).toEqual(['100%_done']);
    expect(names(await list(admin, { q: '\\' }))).toEqual(['a\\b']);
    const search = db.statements.filter(
      (x) => /QF_FOLDER_DELETIONS D/.test(x.sql) && x.sql.includes('LIKE'),
    );
    expect(search.length).toBeGreaterThan(0);
    for (const x of search) {
      expect(x.sql).toContain("UPPER(D.FOLDER_NAME) LIKE ? ESCAPE '\\'");
      expect(x.sql).not.toContain('done');
    }
    expect(search.some((x) => x.params.includes('%0\\%\\_D%'))).toBe(true);
  });

  it('filters by who deleted the folder', async () => {
    const b = await list(admin, { actorId: 'u-alice' });
    expect(names(b)).toEqual(['Budget 2025', 'Q3 Close']);
    expect(b.deletions.every((d) => d.actorId === 'u-alice')).toBe(true);
    expect((await list(admin, { actorId: 'u-nobody' })).total).toBe(0);
  });

  it('filters by deletion time: from inclusive, to exclusive', async () => {
    const b = await list(admin, {
      from: '2026-11-02T09:00:00.000Z',
      to: '2026-11-04T09:00:00.000Z',
    });
    expect(names(b)).toEqual(['close-out notes', 'Budget 2025']);
    expect(b.total).toBe(2);
    // Offsets are honored: a local midnight in UTC-6 is 06:00Z.
    expect(names(await list(admin, { from: '2026-11-03T00:00:00-06:00' }))).toEqual([
      'Scratch',
      'close-out notes',
    ]);
    expect(names(await list(admin, { to: '2026-11-02T00:00:00Z' }))).toEqual(['Q3 Close']);
  });

  it('combines every filter', async () => {
    const b = await list(admin, {
      q: 'close',
      actorId: 'u-bob',
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    });
    expect(names(b)).toEqual(['close-out notes']);
    expect(b.total).toBe(1);
  });

  it('rejects bad filters with 400', async () => {
    for (const query of [
      { q: 'x'.repeat(MAX_FOLDER_DELETION_SEARCH + 1) },
      { from: 'yesterday' },
      { to: '2026-11-02' },
      { from: '2026-11-02T00:00:00Z', to: '2026-11-02T00:00:00Z' },
      { from: '2026-11-03T00:00:00Z', to: '2026-11-02T00:00:00Z' },
      { actorId: 'x'.repeat(37) },
    ]) {
      const res = await admin.agent.get('/api/admin/folder-deletions').query(query);
      expect(res.status, JSON.stringify(query)).toBe(400);
    }
    // Blank filters are the same as none.
    expect((await list(admin, { q: '   ', actorId: '', from: '', to: '' })).total).toBe(4);
  });
});

describe('keyset paging with filters', () => {
  it('walks every match exactly once, newest first, and ends with next: null', async () => {
    for (let i = 0; i < 7; i++) {
      at(`2026-11-0${i + 1}T10:00:00.000Z`);
      await make(alice, `Close ${i}`);
      await make(bob, `Other ${i}`);
    }
    const seen: string[] = [];
    let page = await list(admin, { q: 'close', limit: 3 });
    expect(page.total).toBe(7);
    for (;;) {
      seen.push(...names(page));
      if (!page.next) break;
      expect(page.hasMore).toBe(true);
      page = await list(admin, { q: 'close', limit: 3, cursor: page.next });
      expect(page.total).toBe(7);
    }
    expect(page.hasMore).toBe(false);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0].map((i) => `Close ${i}`));
  });

  it('is not shifted by a deletion recorded between pages', async () => {
    for (let i = 0; i < 4; i++) {
      at(`2026-11-0${i + 1}T10:00:00.000Z`);
      await make(alice, `F${i}`);
    }
    const p1 = await list(admin, { limit: 2 });
    expect(names(p1)).toEqual(['F3', 'F2']);
    at('2026-11-09T10:00:00.000Z');
    await make(alice, 'Newest');
    const p2 = await list(admin, { limit: 2, cursor: p1.next! });
    expect(names(p2)).toEqual(['F1', 'F0']);
    expect(p2).toMatchObject({ hasMore: false, next: null, total: 5 });
  });

  it('orders equal deletion times by deletion ID and keeps paging through them', async () => {
    at('2026-11-01T10:00:00.000Z');
    // The fake keeps every timestamp distinct; make three rows share one.
    for (const n of ['A', 'B', 'C']) await make(alice, n);
    const same = db.folderDeletions[0].DELETED_AT;
    for (const x of db.folderDeletions) x.DELETED_AT = same;
    const ids = db.folderDeletions.map((x) => String(x.DELETION_ID)).sort();
    const p1 = await list(admin, { limit: 2 });
    const p2 = await list(admin, { limit: 2, cursor: p1.next! });
    expect([...p1.deletions, ...p2.deletions].map((d) => d.folderId)).toHaveLength(3);
    expect(
      [...p1.deletions, ...p2.deletions].map(
        (d) => db.folderDeletions.find((x) => x.FOLDER_ID === d.folderId)!.DELETION_ID,
      ),
    ).toEqual(ids);
  });

  it('refuses a cursor from a different search, a broken cursor, or cursor + offset', async () => {
    for (const n of ['A', 'B', 'C']) await make(alice, n);
    const all = await list(admin, { limit: 1 });
    const other = await admin.agent
      .get('/api/admin/folder-deletions')
      .query({ limit: 1, q: 'b', cursor: all.next! });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('BAD_CURSOR');
    for (const cursor of ['nope', Buffer.from('{"t":"x","i":"y","f":"z"}').toString('base64url')])
      expect((await admin.agent.get('/api/admin/folder-deletions').query({ cursor })).status).toBe(
        400,
      );
    expect(
      (await admin.agent.get('/api/admin/folder-deletions').query({ cursor: all.next!, offset: 1 }))
        .status,
    ).toBe(400);
    // A blank filter is the same search as no filter.
    const ok = await admin.agent
      .get('/api/admin/folder-deletions')
      .query({ limit: 1, cursor: all.next!, q: '' });
    expect(ok.status).toBe(200);
  });

  it('binds the cursor back as a TIMESTAMP marker, never as SQL text', async () => {
    for (const n of ['A', 'B']) await make(alice, n);
    const p1 = await list(admin, { limit: 1 });
    db.statements.length = 0;
    await list(admin, { limit: 1, cursor: p1.next! });
    const page = db.statements.find((x) => /FROM \w+\.QF_FOLDER_DELETIONS D/.test(x.sql))!;
    expect(page.sql).toMatch(
      /\(D\.DELETED_AT < CAST\(\? AS TIMESTAMP\) OR \(D\.DELETED_AT = CAST\(\? AS TIMESTAMP\) AND D\.DELETION_ID > \?\)\)/,
    );
    expect(page.sql).not.toMatch(/OFFSET/);
    const c = decodeFolderDeletionCursor(p1.next!, {});
    expect(page.params).toEqual([c.deletedAt, c.deletedAt, c.id]);
  });

  it('round-trips cursors and validates the query', () => {
    const c = { deletedAt: '2026-11-01 10:00:00.000001', id: 'd-1' };
    expect(
      decodeFolderDeletionCursor(encodeFolderDeletionCursor(c, { q: 'X' }), { q: 'x' }),
    ).toEqual(c);
    expect(() => decodeFolderDeletionCursor(encodeFolderDeletionCursor(c, { q: 'x' }), {})).toThrow(
      /not valid/,
    );
    expect(folderDeletionsQuerySchema.safeParse({ cursor: 'a', offset: '5' }).success).toBe(false);
    expect(folderDeletionsQuerySchema.parse({ q: ' y ' })).toMatchObject({
      q: 'y',
      limit: 50,
      offset: 0,
    });
  });
});

describe('deleted-folder actors and CSV export', () => {
  it('lists who deleted folders, by name, for admins only', async () => {
    await make(bob, 'B');
    await make(alice, 'A1');
    await make(alice, 'A2');
    const res = await admin.agent.get('/api/admin/folder-deletions/actors');
    expect(res.status).toBe(200);
    expect(res.body.actors).toEqual([
      { id: 'u-alice', name: 'Alice Archer' },
      { id: 'u-bob', name: 'Bob' },
    ]);
    expect((await alice.agent.get('/api/admin/folder-deletions/actors')).status).toBe(403);
  });

  it('exports only the filtered list, newest first, as CSV', async () => {
    at('2026-11-01T10:00:00.000Z');
    await make(alice, 'Close A');
    at('2026-11-02T10:00:00.000Z');
    await make(bob, '=HYPERLINK("x") close');
    at('2026-11-03T10:00:00.000Z');
    await make(alice, 'Unrelated');
    const res = await admin.agent
      .get('/api/admin/folder-deletions/export')
      .query({ q: 'close' })
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toContain('deleted-folders.csv');
    expect(res.text.startsWith(CSV_BOM)).toBe(true);
    const lines = res.text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe(FOLDER_DELETIONS_CSV_HEADER.map((h) => `"${h}"`).join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"") close"`);
    expect(lines[1]).toContain('"Bob","u-bob"');
    expect(lines[2]).toContain('"Close A"');
    expect(res.text).not.toContain('Unrelated');
  });

  it('streams the export in keyset batches without repeating or skipping rows', async () => {
    for (let i = 0; i < 5; i++) await make(alice, `F${i}`);
    const repo = new FolderRepository(db, 'QFMETA');
    const batches: string[][] = [];
    for await (const b of repo.allDeletions({ actorId: 'u-alice' }, 2))
      batches.push(b.map((d) => d.folderName));
    expect(batches).toEqual([['F4', 'F3'], ['F2', 'F1'], ['F0']]);
  });

  it('applies the export filters and refuses bad ones', async () => {
    await make(alice, 'A');
    const res = await admin.agent
      .get('/api/admin/folder-deletions/export')
      .query({ from: '2026-12-01T00:00:00Z' })
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.text.slice(1).trimEnd().split('\r\n')).toHaveLength(1);
    expect(
      (await admin.agent.get('/api/admin/folder-deletions/export').query({ from: 'soon' })).status,
    ).toBe(400);
  });
});

describe('admin only', () => {
  it('refuses search, actors and export to everyone else', async () => {
    await make(alice, 'Secret');
    for (const c of [alice, bob]) {
      for (const url of [
        '/api/admin/folder-deletions?q=secret',
        '/api/admin/folder-deletions/actors',
        '/api/admin/folder-deletions/export?q=secret',
      ]) {
        const res = await c.agent.get(url);
        expect(res.status, url).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain('Secret');
      }
    }
    for (const url of [
      '/api/admin/folder-deletions?q=secret',
      '/api/admin/folder-deletions/actors',
      '/api/admin/folder-deletions/export',
    ])
      expect((await request(app).get(url)).status).toBe(401);
  });
});
