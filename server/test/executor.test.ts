import { describe, expect, it } from 'vitest';
import { QueryExecutor } from '../src/sql/executor.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => [i + 1, `${i}.00`, i % 3 === 0 ? null : `name ${i}`]);
const table = (n: number, extra: Partial<Scripted> = {}): Scripted => ({
  columns: [col('ID', 'INTEGER'), col('AMT', 'DECIMAL', 9, 2), col('NAME', 'VARCHAR', 40)],
  rows: rows(n),
  ...extra,
});

describe('QueryExecutor (Mapepire)', () => {
  it('executes on a fresh read-only reporting job and always closes it', async () => {
    const { factory, jobs } = fakeFactory(() => table(5));
    const ex = new QueryExecutor(testConfig(), factory);
    const out = await ex.run('SELECT ID, AMT, NAME FROM SALESLIB.ORDERS', 'u1');
    expect(out.rowCount).toBe(5);
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.name)).toEqual(['ID', 'AMT', 'NAME']);
    expect(out.rows[0]).toEqual([1, '0.00', null]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].options.access).toBe('read only');
    expect(jobs[0].connectedWith?.user).toBe('QFREPORT');
    expect(jobs[0].closed).toBe(true);
    expect(ex.activeExecutions).toBe(0);
  });

  it('pages through results in batches and enforces the row limit', async () => {
    const { factory, jobs } = fakeFactory(() => table(250));
    const ex = new QueryExecutor(testConfig(), factory); // MAX_RESULT_ROWS=100, batch 30
    const out = await ex.run('SELECT * FROM T', 'u1');
    expect(out.rowCount).toBe(100);
    expect(out.truncated).toBe(true);
    expect(Math.max(...jobs[0].fetchSizes)).toBeLessThanOrEqual(30);
  });

  it('is not truncated when the result exactly equals the limit', async () => {
    const { factory } = fakeFactory(() => table(100));
    const out = await new QueryExecutor(testConfig(), factory).run('SELECT * FROM T', 'u1');
    expect(out).toMatchObject({ rowCount: 100, truncated: false });
  });

  it('handles empty result sets with column metadata', async () => {
    const { factory } = fakeFactory(() => table(0));
    const out = await new QueryExecutor(testConfig(), factory).run(
      'SELECT * FROM T WHERE 1=0',
      'u1',
    );
    expect(out.rowCount).toBe(0);
    expect(out.columns).toHaveLength(3);
  });

  it('rejects invalid SQL before opening any connection', async () => {
    const { factory, jobs } = fakeFactory(() => table(1));
    await expect(
      new QueryExecutor(testConfig(), factory).run('DELETE FROM T', 'u1'),
    ).rejects.toMatchObject({ status: 400 });
    expect(jobs).toHaveLength(0);
  });

  it('surfaces Db2 SQLSTATE for invalid SQL and closes the job', async () => {
    const { factory, jobs } = fakeFactory(() =>
      table(0, {
        error: {
          message: '[SQL0206] Column XYZ not in specified tables.',
          sqlState: '42703',
          sqlCode: -206,
        },
      }),
    );
    await expect(
      new QueryExecutor(testConfig(), factory).run('SELECT XYZ FROM T', 'u1'),
    ).rejects.toMatchObject({
      sqlState: '42703',
      sqlCode: -206,
    });
    expect(jobs[0].closed).toBe(true);
  });

  it('reports connection failures as 503', async () => {
    const { factory } = fakeFactory(() =>
      table(0, { connectError: 'connect ECONNREFUSED 10.1.1.1:8076' }),
    );
    await expect(
      new QueryExecutor(testConfig(), factory).run('SELECT 1 FROM T', 'u1'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'CONNECTION_ERROR',
    });
  });

  it('times out long queries by closing the job', async () => {
    const { factory, jobs } = fakeFactory((sql) =>
      sql === '__connect__' ? table(0) : table(1, { delayMs: 500 }),
    );
    const ex = new QueryExecutor(testConfig({ QUERY_TIMEOUT_MS: '100' }), factory);
    await expect(ex.run('SELECT * FROM BIG', 'u1')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(jobs[0].closed).toBe(true);
    expect(ex.activeExecutions).toBe(0);
  });

  it("cancels only the owner's running query", async () => {
    const { factory, jobs } = fakeFactory((sql) =>
      sql === '__connect__' ? table(0) : table(1, { delayMs: 300 }),
    );
    const ex = new QueryExecutor(testConfig(), factory);
    const id = '11111111-1111-4111-8111-111111111111';
    const p = ex.run('SELECT * FROM BIG', 'u1', { executionId: id });
    await new Promise((r) => setTimeout(r, 30));
    expect(ex.cancel(id, 'someone-else')).toBe(false);
    expect(ex.cancel(id, 'u1')).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(jobs[0].closed).toBe(true);
  });
});
