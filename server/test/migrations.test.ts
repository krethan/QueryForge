import { describe, expect, it } from 'vitest';
import { loadMigrations, splitStatements } from '../scripts/migrate.js';

describe('Db2 for i migrations', () => {
  const migs = loadMigrations('QFMETA');
  it('loads ordered migrations with the schema substituted', () => {
    expect(migs.length).toBeGreaterThan(0);
    expect(migs[0].version).toBe(1);
    const sql = migs.map((m) => m.statements.join('\n')).join('\n');
    expect(sql).not.toContain('{{SCHEMA}}');
    expect(sql).toContain('QFMETA.QF_REPORTS');
  });
  it('defines the required tables, keys and constraints', () => {
    const sql = migs[0].statements.join('\n').toUpperCase();
    for (const t of ['QF_USERS', 'QF_REPORTS', 'QF_EXECUTIONS'])
      expect(sql).toContain(`CREATE TABLE QFMETA.${t}`);
    expect(sql).toMatch(/UNIQUE\s*\(\s*OWNER_ID\s*,\s*REPORT_NAME_KEY\s*\)/);
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).toContain('CLOB');
  });
  it('splits statements without breaking on semicolons in strings or comments', () => {
    expect(
      splitStatements("CREATE TABLE A (X INT);\n-- a; comment\nLABEL ON TABLE A IS 'x; y';"),
    ).toEqual(['CREATE TABLE A (X INT)', "LABEL ON TABLE A IS 'x; y'"]);
  });
});
