import { describe, expect, it } from 'vitest';
import { validateReportingSql } from '../src/sql/validator.js';
import { PROTECTED_METADATA_OBJECTS } from '../src/db/schema.js';

const opts = {
  maxLength: 32000,
  protectedSchemas: ['QFMETA', 'QSYS'],
  protectedObjects: PROTECTED_METADATA_OBJECTS,
};
const ok = (sql: string) =>
  expect(validateReportingSql(sql, opts), sql).toMatchObject({ ok: true });
const bad = (sql: string, code?: string) => {
  const r = validateReportingSql(sql, opts);
  expect(r.ok, sql).toBe(false);
  if (code && !r.ok) expect(r.code).toBe(code);
};

describe('SQL validation – allowed read-only statements', () => {
  it.each([
    'SELECT * FROM SALESLIB.ORDERS',
    "select cusnum, lstnam from qiws.qcustcdt where state = 'TX'",
    'SELECT 1 FROM SYSIBM.SYSDUMMY1;',
    'VALUES CURRENT TIMESTAMP',
    'WITH t AS (SELECT * FROM A) SELECT * FROM t',
    'WITH a AS (SELECT 1 X FROM B), b AS (SELECT X FROM a) SELECT * FROM b ORDER BY 1 FETCH FIRST 10 ROWS ONLY',
    'SELECT * FROM (SELECT * FROM (SELECT A FROM T) X) Y',
    'SELECT * FROM T WHERE ID IN (SELECT ID FROM U WHERE U.X = T.X)',
    'SELECT A FROM T UNION ALL SELECT B FROM U',
    "SELECT 'DELETE FROM X; DROP TABLE Y' AS TXT FROM T",
    'SELECT "update", "Insert" FROM "MyLib"."Odd;Name"',
    '-- comment with DROP TABLE\nSELECT 1 FROM T',
    '/* DELETE FROM X; */ SELECT * FROM T -- trailing; comment',
    'SELECT UPDATED_AT, CREATED_BY, DELETED_FLAG FROM T',
    "SELECT * FROM T WHERE NAME LIKE '%;%'",
    'SELECT * FROM T FOR READ ONLY',
  ])('accepts %s', ok);
});

describe('SQL validation – rejected statements', () => {
  it.each([
    ['INSERT INTO T VALUES (1)', 'STATEMENT_NOT_ALLOWED'],
    ['UPDATE T SET A = 1', 'STATEMENT_NOT_ALLOWED'],
    ['DELETE FROM T', 'STATEMENT_NOT_ALLOWED'],
    ['MERGE INTO T USING U ON 1=1 WHEN MATCHED THEN DELETE', 'STATEMENT_NOT_ALLOWED'],
    ['DROP TABLE T', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE TABLE T (A INT)', 'STATEMENT_NOT_ALLOWED'],
    ['ALTER TABLE T ADD COLUMN B INT', 'STATEMENT_NOT_ALLOWED'],
    ['TRUNCATE TABLE T', 'STATEMENT_NOT_ALLOWED'],
    ['GRANT SELECT ON T TO PUBLIC', 'STATEMENT_NOT_ALLOWED'],
    ["CALL QSYS2.QCMDEXC('DLTLIB X')", 'STATEMENT_NOT_ALLOWED'],
    ['SET SCHEMA X', 'STATEMENT_NOT_ALLOWED'],
    ['COMMIT'],
    ['   '],
  ] as [string, string?][])('rejects %s', (sql, code) => bad(sql, code));

  it('rejects multiple statements', () => {
    bad('SELECT 1 FROM T; DELETE FROM T', 'MULTIPLE_STATEMENTS');
    bad('SELECT 1 FROM T; SELECT 2 FROM T', 'MULTIPLE_STATEMENTS');
    bad('SELECT 1 FROM T;/* x */ DROP TABLE T');
  });

  it('rejects data-change statements hidden in CTEs and table functions', () => {
    bad('WITH x AS (SELECT 1 FROM T) DELETE FROM T');
    bad('SELECT * FROM FINAL TABLE (INSERT INTO T VALUES 1)');
    bad('SELECT * FROM OLD TABLE (DELETE FROM T)');
    bad('SELECT * INTO :HV FROM T');
  });

  it('rejects side-effect routines', () => {
    bad("VALUES QSYS2.QCMDEXC('DLTLIB PROD')");
    bad("SELECT QSYS2.IFS_WRITE('/tmp/x', 'y') FROM SYSIBM.SYSDUMMY1");
    bad("SELECT SYSTOOLS.HTTPGETCLOB('http://x', '') FROM SYSIBM.SYSDUMMY1");
  });

  it('rejects comment tricks and unterminated tokens', () => {
    bad('SELECT 1 FROM T /* unterminated');
    bad("SELECT 'unterminated FROM T");
    bad('SELECT /* a /* nested */ */ 1 FROM T');
  });

  it('protects application metadata objects and schemas', () => {
    bad('SELECT * FROM QFMETA.QF_USERS', 'PROTECTED_OBJECT');
    bad('SELECT PASSWORD_HASH FROM qf_users');
    bad('SELECT * FROM "QFMETA"."QF_REPORTS"');
    bad('SELECT * FROM X WHERE Y IN (SELECT USER_ID FROM QF_EXECUTIONS)');
  });

  it('rejects parameter markers and over-long text', () => {
    bad('SELECT * FROM T WHERE A = ?');
    const r = validateReportingSql(`SELECT 1 FROM T WHERE A = '${'x'.repeat(40000)}'`, opts);
    expect(r).toMatchObject({ ok: false, code: 'SQL_TOO_LONG' });
  });

  it('strips one trailing semicolon', () => {
    expect(validateReportingSql('SELECT 1 FROM T ;  ', opts)).toMatchObject({
      ok: true,
      sql: 'SELECT 1 FROM T',
    });
  });
});
