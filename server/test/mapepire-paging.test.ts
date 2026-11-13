/**
 * @ibm/mapepire-js 1.0.2 fetches 100 rows unless told otherwise (SQLJob.execute() is
 * query().execute() + close()). These tests run against fakes that emulate that default, so code
 * relying on it would lose rows here exactly as it would on a real IBM i.
 */
import { describe, expect, it } from 'vitest';
import { MapepireMetadataDb, READ_ALL_PAGE_SIZE, readAllRows } from '../src/db/mapepire.js';
import type { SqlJobLike } from '../src/db/types.js';
import { CatalogService, MAX_TABLES } from '../src/catalog/catalog.js';
import { QueryExecutor } from '../src/sql/executor.js';
import {
  col,
  fakeFactory,
  FakeJob,
  MAPEPIRE_DEFAULT_ROWS,
  type Scripted,
} from './helpers/fake-mapepire.js';
import { FakeIbmi } from './helpers/fake-ibmi.js';
import { expectedSchema } from '../scripts/verify/expected.js';
import { testConfig } from './helpers/config.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const idTable = (n: number, extra: Partial<Scripted> = {}): Scripted => ({
  columns: [col('ID', 'INTEGER')],
  rows: ids(n).map((i) => [i]),
  ...extra,
});
const firstCol = (rows: unknown[]) => rows.map((r) => (r as unknown[])[0]);

describe('fake Mapepire job emulates @ibm/mapepire-js 1.0.2 paging', () => {
  it('SQLJob.execute() returns only the first 100 rows', async () => {
    const job = new FakeJob({}, () => idTable(250));
    const res = await job.execute('SELECT ID FROM T');
    expect(res.data).toHaveLength(MAPEPIRE_DEFAULT_ROWS);
    expect(res.is_done).toBe(false);
  });

  it('reports is_done only after a short block, then refuses to fetch', async () => {
    const q = new FakeJob({}, () => idTable(4)).query('SELECT ID FROM T');
    expect((await q.execute(4)).is_done).toBe(false);
    expect(await q.fetchMore(4)).toMatchObject({ is_done: true, data: [] });
    await expect(q.fetchMore(4)).rejects.toThrow('already been fully run');
  });
});

describe('readAllRows', () => {
  for (const n of [0, 1, 99, 100, 101, 250, 1000, 1001, 2500]) {
    it(`returns all ${n} rows and closes the query`, async () => {
      const job = new FakeJob({}, () => idTable(n));
      const rows = await readAllRows(job, 'SELECT ID FROM T');
      expect(rows).toHaveLength(n);
      expect(firstCol(rows)).toEqual(ids(n));
      expect(job.runs[0].closeCalls).toBe(1);
      expect(job.openCursors()).toHaveLength(0);
      // always an explicit page size, never Mapepire's default
      expect(new Set(job.fetchSizes)).toEqual(new Set([READ_ALL_PAGE_SIZE]));
      expect(job.fetchSizes).toHaveLength(Math.floor(n / READ_ALL_PAGE_SIZE) + 1);
    });
  }

  it('uses the requested page size and binds parameters', async () => {
    const job = new FakeJob({}, () => idTable(20));
    const rows = await readAllRows(job, 'SELECT ID FROM T WHERE X = ?', ['A'], { pageSize: 7 });
    expect(rows).toHaveLength(20);
    expect(job.fetchSizes).toEqual([7, 7, 7]);
    expect(job.queryOptions[0]).toEqual({ parameters: ['A'] });
    await readAllRows(job, 'SELECT ID FROM T');
    expect(job.queryOptions[1]).toBeUndefined();
  });

  it('closes the open cursor when a later fetch fails', async () => {
    const job = new FakeJob({}, () =>
      idTable(250, { failOnFetch: { index: 1, message: 'SQL0901 system error, 58004, -901' } }),
    );
    await expect(readAllRows(job, 'SELECT ID FROM T', [], { pageSize: 100 })).rejects.toThrow(
      'SQL0901',
    );
    expect(job.runs[0].closeCalls).toBe(1);
    expect(job.runs[0].serverCloses).toBe(1);
    expect(job.openCursors()).toHaveLength(0);
  });

  it('fails instead of returning a partial list past maxRows, and closes the cursor', async () => {
    const job = new FakeJob({}, () => idTable(50));
    await expect(
      readAllRows(job, 'SELECT ID FROM T', [], { pageSize: 10, maxRows: 20 }),
    ).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' });
    expect(job.runs[0].serverCloses).toBe(1);
    expect(job.openCursors()).toHaveLength(0);
  });

  it('returns exactly maxRows rows without failing', async () => {
    const job = new FakeJob({}, () => idTable(20));
    const rows = await readAllRows(job, 'SELECT ID FROM T', [], { pageSize: 10, maxRows: 20 });
    expect(rows).toHaveLength(20);
  });

  it('does not loop when the server claims more rows but sends none', async () => {
    let closed = 0;
    const job = {
      query: () => ({
        execute: async () => ({ success: true, is_done: false, has_results: true, data: [] }),
        fetchMore: async () => {
          throw new Error('fetchMore should not be called');
        },
        close: async () => void closed++,
      }),
    } as unknown as SqlJobLike;
    await expect(readAllRows(job, 'SELECT 1 FROM T')).rejects.toMatchObject({ code: 'DB_ERROR' });
    expect(closed).toBe(1);
  });

  it('stops after a statement without a result set', async () => {
    const job = {
      query: () => ({
        execute: async () => ({ success: true, is_done: false, has_results: false, data: [] }),
        fetchMore: async () => {
          throw new Error('fetchMore should not be called');
        },
        close: async () => ({}),
      }),
    } as unknown as SqlJobLike;
    expect(await readAllRows(job, 'CALL X()')).toEqual([]);
  });
});

describe('MapepireMetadataDb reads whole metadata lists', () => {
  for (const n of [0, 100, 101, 250, 1500]) {
    it(`query() returns all ${n} rows`, async () => {
      const { factory, jobs } = fakeFactory(() => idTable(n));
      const db = new MapepireMetadataDb(testConfig(), factory);
      const rows = await db.query('SELECT REPORT_ID FROM QFMETA.QF_REPORTS');
      expect(firstCol(rows)).toEqual(ids(n));
      expect(jobs[0].openCursors()).toHaveLength(0);
      await db.close();
    });
  }

  it('transaction queries read every row too', async () => {
    const { factory, jobs } = fakeFactory(() => idTable(250));
    const db = new MapepireMetadataDb(testConfig(), factory);
    const rows = await db.transaction((tx) => tx.query('SELECT ID FROM QFMETA.QF_FOLDERS'));
    expect(rows).toHaveLength(250);
    expect(jobs[0].openCursors()).toHaveLength(0);
    expect(jobs[0].closed).toBe(true);
  });

  it('a failed fetch surfaces the error and leaves no cursor open', async () => {
    const { factory, jobs } = fakeFactory(() =>
      idTable(2500, { failOnFetch: { index: 1, message: 'SQL0901 system error, 58004, -901' } }),
    );
    const db = new MapepireMetadataDb(testConfig(), factory);
    await expect(db.query('SELECT ID FROM QFMETA.QF_AUDIT')).rejects.toMatchObject({
      sqlState: '58004',
    });
    expect(jobs[0].runs[0].serverCloses).toBe(1);
    expect(jobs[0].openCursors()).toHaveLength(0);
    await db.close();
  });

  it('matches a full catalog read on the verification fake (> 100 rows)', async () => {
    const ibmi = new FakeIbmi({
      existingLibraries: { QFMETA: expectedSchema().tables.map((t) => t.name) },
    });
    const db = new MapepireMetadataDb(testConfig(), ibmi.factory);
    const rows = await db.query(
      'SELECT TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ?',
      ['QFMETA'],
    );
    expect(rows.length).toBe(expectedSchema().columns.length);
    expect(rows.length).toBeGreaterThan(100);
    await db.close();
  });
});

describe('report runs keep the app row limit, not Mapepire’s', () => {
  const run = async (n: number, env: Record<string, string>, maxRows?: number) => {
    const { factory, jobs } = fakeFactory(() => idTable(n));
    const out = await new QueryExecutor(testConfig(env), factory).run('SELECT ID FROM T', 'u1', {
      maxRows,
    });
    return { out, job: jobs[0] };
  };

  it('returns more than 100 rows when the limit allows', async () => {
    const { out, job } = await run(250, { MAX_RESULT_ROWS: '1000' });
    expect(out).toMatchObject({ rowCount: 250, truncated: false, maxRows: 1000 });
    expect(firstCol(out.rows)).toEqual(ids(250));
    expect(job.openCursors()).toHaveLength(0);
    expect(job.closed).toBe(true);
  });

  for (const [n, rowCount, truncated] of [
    [0, 0, false],
    [199, 199, false],
    [200, 200, false],
    [201, 200, true],
    [2500, 200, true],
  ] as const) {
    it(`caps ${n} rows at MAX_RESULT_ROWS=200 (truncated: ${truncated})`, async () => {
      const { out, job } = await run(n, { MAX_RESULT_ROWS: '200' });
      expect(out).toMatchObject({ rowCount, truncated, maxRows: 200 });
      expect(Math.max(0, ...job.fetchSizes)).toBeLessThanOrEqual(30); // FETCH_BATCH_SIZE
      expect(job.runs[0].closeCalls).toBe(1);
      expect(job.openCursors()).toHaveLength(0);
    });
  }

  it('applies an explicit per-run cap (export / schedule limits)', async () => {
    const { out } = await run(500, { MAX_RESULT_ROWS: '1000' }, 150);
    expect(out).toMatchObject({ rowCount: 150, truncated: true, maxRows: 150 });
  });

  it('a failed fetch mid-run closes the query and the job', async () => {
    const { factory, jobs } = fakeFactory(() =>
      idTable(500, { failOnFetch: { index: 2, message: 'SQL0901 system error, 58004, -901' } }),
    );
    await expect(
      new QueryExecutor(testConfig({ MAX_RESULT_ROWS: '1000' }), factory).run(
        'SELECT ID FROM T',
        'u1',
      ),
    ).rejects.toMatchObject({ sqlState: '58004' });
    expect(jobs[0].runs[0].serverCloses).toBe(1);
    expect(jobs[0].openCursors()).toHaveLength(0);
    expect(jobs[0].closed).toBe(true);
  });
});

describe('interactive paging reports hasMore and truncation exactly', () => {
  const open = async (n: number, env: Record<string, string>) => {
    const { factory, jobs } = fakeFactory(() => idTable(n));
    const ex = new QueryExecutor(testConfig(env), factory);
    const first = await ex.openPaged('SELECT ID FROM T', 'u1');
    return { ex, first, jobs };
  };
  const drain = async (ex: QueryExecutor, id: string) => {
    const pages: Awaited<ReturnType<QueryExecutor['fetchPage']>>[] = [];
    for (;;) {
      const p = await ex.fetchPage(id, 'u1');
      pages.push(p);
      if (!p.hasMore) return pages;
    }
  };

  it('a result that exactly fills the first page has no cursor and is not truncated', async () => {
    const { ex, first, jobs } = await open(50, { RESULT_PAGE_SIZE: '50', MAX_RESULT_ROWS: '1000' });
    expect(first).toMatchObject({ rowCount: 50, hasMore: false, truncated: false });
    expect(first.cursor).toBeUndefined();
    expect(jobs[0].closed).toBe(true);
    await ex.shutdown();
  });

  it('one row past the first page is delivered by the next page', async () => {
    const { ex, first } = await open(51, { RESULT_PAGE_SIZE: '50', MAX_RESULT_ROWS: '1000' });
    expect(first).toMatchObject({ rowCount: 50, hasMore: true, truncated: false });
    const [p] = await drain(ex, first.cursor!.id);
    expect(p).toMatchObject({ rowCount: 51, hasMore: false, truncated: false });
    expect(firstCol(p.rows)).toEqual([51]);
    await ex.shutdown();
  });

  it('pages through 250 rows with no empty trailing page', async () => {
    const { ex, first, jobs } = await open(250, {
      RESULT_PAGE_SIZE: '100',
      MAX_RESULT_ROWS: '1000',
    });
    const pages = await drain(ex, first.cursor!.id);
    expect(pages.map((p) => p.rows.length)).toEqual([100, 50]);
    expect(firstCol([...first.rows, ...pages.flatMap((p) => p.rows)])).toEqual(ids(250));
    expect(pages.at(-1)).toMatchObject({ rowCount: 250, truncated: false });
    expect(jobs[0].closed).toBe(true);
    expect(ex.cursors.size).toBe(0);
    await ex.shutdown();
  });

  for (const [n, truncated] of [
    [100, false],
    [101, true],
  ] as const) {
    it(`page size = row cap (100): ${n} rows -> truncated ${truncated}`, async () => {
      const { ex, first } = await open(n, { RESULT_PAGE_SIZE: '100', MAX_RESULT_ROWS: '100' });
      expect(first).toMatchObject({ rowCount: 100, hasMore: false, truncated });
      expect(first.cursor).toBeUndefined();
      await ex.shutdown();
    });
  }

  for (const [n, truncated] of [
    [100, false],
    [101, true],
    [400, true],
  ] as const) {
    it(`row cap reached on a later page: ${n} rows -> truncated ${truncated}`, async () => {
      const { ex, first, jobs } = await open(n, {
        RESULT_PAGE_SIZE: '40',
        MAX_RESULT_ROWS: '100',
      });
      const pages = await drain(ex, first.cursor!.id);
      expect(pages.map((p) => p.rows.length)).toEqual([40, 20]);
      expect(pages.at(-1)).toMatchObject({ rowCount: 100, hasMore: false, truncated });
      expect(jobs[0].closed).toBe(true);
      await ex.shutdown();
    });
  }
});

describe('catalog table list reports truncation at MAX_TABLES', () => {
  const catalog = (n: number) => {
    const { factory, jobs } = fakeFactory(() => ({
      columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'TABLE_TEXT', 'TABLE_OWNER'].map((c) =>
        col(c, 'VARCHAR', 128),
      ),
      rows: ids(n).map((i) => ['SALESLIB', `T${String(i).padStart(4, '0')}`, 'T', null, 'OWNER']),
    }));
    const cfg = testConfig({ MAX_RESULT_ROWS: '1000' });
    return { svc: new CatalogService(cfg, new QueryExecutor(cfg, factory)), jobs };
  };

  it('reads one row past MAX_TABLES and flags the list as truncated', async () => {
    const { svc, jobs } = catalog(MAX_TABLES + 1);
    const res = await svc.listTables('u1', { limit: MAX_TABLES });
    expect(res.tables).toHaveLength(MAX_TABLES);
    expect(res.truncated).toBe(true);
    expect(jobs[0].queries[0]).toContain(`FETCH FIRST ${MAX_TABLES + 1} ROWS ONLY`);
    // and from the cache
    expect((await svc.listTables('u1', { limit: MAX_TABLES })).truncated).toBe(true);
  });

  it('is not truncated with exactly MAX_TABLES matches', async () => {
    const { svc } = catalog(MAX_TABLES);
    const res = await svc.listTables('u1', { limit: MAX_TABLES });
    expect(res.tables).toHaveLength(MAX_TABLES);
    expect(res.truncated).toBe(false);
  });
});
