/**
 * Live integration tests against a real IBM i Mapepire server. They are skipped
 * unless QF_INTEGRATION=1 and the usual MAPEPIRE_ and REPORT_DB_ variables are set.
 * They only run read-only statements (VALUES / catalog SELECT) and never write data.
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { QueryExecutor } from '../../src/sql/executor.js';

const enabled = process.env.QF_INTEGRATION === '1';

describe.skipIf(!enabled)('Mapepire live (read-only)', () => {
  it('connects as the reporting user and runs VALUES', async () => {
    const ex = new QueryExecutor(loadConfig());
    const out = await ex.run('VALUES (1, CURRENT TIMESTAMP)', 'integration');
    expect(out.rowCount).toBe(1);
    expect(out.columns).toHaveLength(2);
  });
  it('reads catalog metadata with types', async () => {
    const ex = new QueryExecutor(loadConfig());
    const out = await ex.run(
      'SELECT TABLE_SCHEMA, TABLE_NAME FROM QSYS2.SYSTABLES FETCH FIRST 5 ROWS ONLY',
      'integration',
    );
    expect(out.columns.map((c) => c.name)).toEqual(['TABLE_SCHEMA', 'TABLE_NAME']);
  });
});
