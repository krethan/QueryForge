import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/db/migration-files.js';
import {
  assertConfined,
  checkStatement,
  isReadStatement,
  PolicyViolation,
} from '../scripts/verify/confine.js';
import { expectedSchema, lintMigrations } from '../scripts/verify/expected.js';
import { evaluateGuard, parseOptions, type VerifyOptions } from '../scripts/verify/options.js';
import { exitCode, formatReport } from '../scripts/verify/report.js';
import { MARKER_TABLE, readAll, runVerification } from '../scripts/verify/run.js';
import { FakeIbmi } from './helpers/fake-ibmi.js';

const REPORT_PW = 'report-placeholder-pw';
const META_PW = 'meta-placeholder-pw';

/** Options as an operator would set them for a non-production run. */
function opts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    target: 'nonprod',
    confirmNonprod: true,
    host: 'ibmi-test.example.invalid',
    port: 8076,
    rejectUnauthorized: true,
    report: { user: 'QFREPORT', password: REPORT_PW },
    meta: { user: 'QFAPPTEST', password: META_PW },
    schema: 'UBVERIFY',
    dataLibraries: ['SAMPLELIB'],
    productionHosts: ['ibmi-prod.example.invalid'],
    applyMigrations: false,
    allowQfmeta: false,
    adoptEmptyLibrary: false,
    smoke: true,
    dryRun: false,
    jsonPath: '/dev/null',
    help: false,
    ...over,
  };
}

const status = (r: Awaited<ReturnType<typeof runVerification>>, id: string) =>
  r.results.filter((x) => x.id === id).map((x) => x.status);

describe('verify-ibmi: non-production guard', () => {
  it.each([
    ['QF_VERIFY_TARGET missing', { target: undefined }, /QF_VERIFY_TARGET=nonprod/],
    ['QF_VERIFY_TARGET=prod', { target: 'prod' }, /QF_VERIFY_TARGET=nonprod/],
    ['no --confirm-nonprod', { confirmNonprod: false }, /--confirm-nonprod/],
    ['NODE_ENV=production', { nodeEnv: 'production' }, /NODE_ENV=production/],
    ['listed production host', { host: 'IBMI-PROD.example.invalid' }, /QF_VERIFY_PRODUCTION_HOSTS/],
    ['no reporting password', { report: { user: 'QFREPORT' } }, /QF_VERIFY_REPORT_PASSWORD/],
    ['QFMETA without --allow-qfmeta', { schema: 'QFMETA' }, /--allow-qfmeta/],
    ['IBM-supplied library', { schema: 'QGPL' }, /IBM-supplied/],
    ['SYS* library', { schema: 'SYSTOOLS' }, /IBM-supplied/],
    ['schema is a data library', { schema: 'SAMPLELIB' }, /also listed as a data library/],
    ['invalid library name', { schema: 'TOO_LONG_NAME' }, /system library name/],
    [
      'writes without a metadata profile',
      { applyMigrations: true, meta: undefined },
      /QF_VERIFY_META_USER/,
    ],
    ['writes without a library', { applyMigrations: true, schema: undefined }, /QF_VERIFY_SCHEMA/],
    ['cleanup name mismatch', { cleanup: 'OTHERLIB' }, /does not match/],
  ])('refuses: %s', (_name, over, msg) => {
    const g = evaluateGuard(opts(over as Partial<VerifyOptions>));
    expect(g.ok).toBe(false);
    expect(g.errors.join('\n')).toMatch(msg);
  });

  it('accepts a marked non-production target and defaults to read-only', () => {
    const g = evaluateGuard(opts());
    expect(g).toMatchObject({ ok: true, errors: [], readOnly: true });
    expect(evaluateGuard(opts({ applyMigrations: true })).readOnly).toBe(false);
    expect(evaluateGuard(opts({ schema: 'QFMETA', allowQfmeta: true })).ok).toBe(true);
  });

  it('never opens a connection when it refuses', async () => {
    const ibmi = new FakeIbmi();
    const r = await runVerification(opts({ target: undefined, confirmNonprod: false }), {
      factory: ibmi.factory,
    });
    expect(r.mode).toBe('refused');
    expect(r.refusedBecause).toHaveLength(2);
    expect(exitCode(r)).toBe(2);
    expect(ibmi.connections).toHaveLength(0);
    expect(ibmi.statements).toHaveLength(0);
  });

  it('a dry run checks the settings but connects to nothing', async () => {
    const ibmi = new FakeIbmi();
    const r = await runVerification(opts({ dryRun: true, applyMigrations: true }), {
      factory: ibmi.factory,
    });
    expect(r.mode).toBe('dry-run');
    expect(r.ok).toBe(true);
    expect(ibmi.connections).toHaveLength(0);
  });
});

describe('verify-ibmi: options', () => {
  it('reads only QF_VERIFY_* keys from the config file, lets the environment win and resolves paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qf-verify-'));
    writeFileSync(
      join(dir, 'v.env'),
      [
        'QF_VERIFY_TARGET=nonprod',
        'QF_VERIFY_HOST=from-file.example.invalid',
        'QF_VERIFY_SCHEMA=ubverify',
        'QF_VERIFY_DATA_LIBRARIES=lib1, lib2',
        'QF_VERIFY_CA_FILE=ca.pem',
        'MAPEPIRE_HOST=ignored.example.invalid',
      ].join('\n'),
    );
    const o = parseOptions(
      ['--config', 'v.env', '--confirm-nonprod', '--apply-migrations', '--cleanup', 'ubverify'],
      { QF_VERIFY_HOST: 'from-env.example.invalid', MAPEPIRE_HOST: 'x' },
      dir,
    );
    expect(o).toMatchObject({
      target: 'nonprod',
      confirmNonprod: true,
      host: 'from-env.example.invalid',
      schema: 'UBVERIFY',
      cleanup: 'UBVERIFY',
      dataLibraries: ['LIB1', 'LIB2'],
      caFile: join(dir, 'ca.pem'),
      applyMigrations: true,
      smoke: true,
      jsonPath: join(dir, 'ibmi-verification-report.json'),
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseOptions(['--yolo'], {})).toThrow();
  });
});

describe('verify-ibmi: statement policy', () => {
  it('classifies reads', () => {
    expect(isReadStatement('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(true);
    expect(isReadStatement("SELECT 'DELETE' AS X FROM SYSIBM.SYSDUMMY1")).toBe(true);
    expect(isReadStatement('SELECT LAST_UPDATED_AT FROM A.B')).toBe(true);
    expect(isReadStatement('SELECT * FROM FINAL TABLE (INSERT INTO A.B VALUES (1))')).toBe(false);
    expect(isReadStatement('SELECT 1 FROM SYSIBM.SYSDUMMY1; DROP TABLE A.B')).toBe(false);
    expect(isReadStatement('CALL QSYS2.QCMDEXC(?)')).toBe(false);
  });

  it('read-only runs refuse every write', () => {
    expect(() => checkStatement('CREATE SCHEMA UBVERIFY', { writesAllowed: false })).toThrow(
      PolicyViolation,
    );
    expect(checkStatement('VALUES 1', { writesAllowed: false })).toBe('read');
  });

  it('confines writes to the disposable library', () => {
    const ok = [
      'CREATE SCHEMA UBVERIFY',
      'DROP SCHEMA UBVERIFY CASCADE',
      'CREATE TABLE UBVERIFY.QF_X (A INT, CONSTRAINT FK FOREIGN KEY (A) REFERENCES UBVERIFY.QF_Y (A))',
      'CREATE UNIQUE WHERE NOT NULL INDEX UBVERIFY.IX ON UBVERIFY.QF_USERS (A)',
      "LABEL ON COLUMN UBVERIFY.QF_REPORTS.CHART_DEF IS 'x'",
      'INSERT INTO UBVERIFY.QF_USERS (A) VALUES (?)',
      'UPDATE UBVERIFY.QF_USERS SET A = 1 WHERE B IN (SELECT B FROM UBVERIFY.QF_REPORTS R)',
      'DELETE FROM UBVERIFY.QF_REPORTS WHERE REPORT_ID = ?',
      'REVOKE ALL ON UBVERIFY.QF_USERS FROM PUBLIC',
      'COMMIT',
    ];
    for (const s of ok) expect(() => assertConfined(s, 'UBVERIFY'), s).not.toThrow();
    const bad = [
      'CREATE SCHEMA QFMETA',
      'DROP SCHEMA SAMPLELIB CASCADE',
      'INSERT INTO SAMPLELIB.ORDERS VALUES (1)',
      'UPDATE SAMPLELIB.ORDERS SET A = 1',
      'DELETE FROM QFMETA.QF_USERS',
      'DELETE FROM QF_USERS',
      'CREATE TABLE UBVERIFY.T (A INT, CONSTRAINT F FOREIGN KEY (A) REFERENCES SAMPLELIB.T (A))',
      'DROP TABLE UBVERIFY.QF_USERS',
      'GRANT ALL ON SAMPLELIB.ORDERS TO PUBLIC',
      'CALL QSYS2.QCMDEXC(?)',
    ];
    for (const s of bad) expect(() => assertConfined(s, 'UBVERIFY'), s).toThrow(PolicyViolation);
  });
});

describe('verify-ibmi: expected objects', () => {
  it('understands every statement in migrations 001-012', () => {
    const e = expectedSchema();
    expect(e.unparsed).toEqual([]);
    expect(e.migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(e.tables.map((t) => t.name)).toContain('QF_FOLDER_REPORT_SHARING');
    expect(e.indexes.find((i) => i.name === 'QF_USERS_UX_EXTERNAL')?.unique).toBe('V');
    expect(e.constraints.find((c) => c.name === 'QF_EXEC_FK_REPORT')?.deleteRule).toBe('SET NULL');
    // 002 drops and re-adds QF_EXEC_CK_KIND; 012 does the same for QF_FSAU_CK_TYPE.
    expect(e.constraints.find((c) => c.name === 'QF_EXEC_CK_KIND')?.checkLiterals).toContain(
      'SCHEDULE',
    );
    expect(e.constraints.find((c) => c.name === 'QF_FSAU_CK_TYPE')).toMatchObject({
      migration: 12,
      checkLiterals: ['USER', 'GROUP', 'REPORTS'],
    });
  });

  it('keeps every LABEL within the Db2 for i limits', () => {
    expect(lintMigrations()).toEqual([]);
    for (const l of expectedSchema().labels) expect(l.bytes, l.target).toBeLessThanOrEqual(50);
  });

  it('flags a table label longer than 50 bytes', () => {
    const statements = splitStatements(
      "CREATE TABLE QFX_SCHEMA.QF_T (A INT);\nLABEL ON TABLE QFX_SCHEMA.QF_T IS 'Uncle Bob folder user/group Viewer and Editor grants';",
    );
    const issues = lintMigrations(expectedSchema([{ version: 99, file: '099_x.sql', statements }]));
    expect(issues).toEqual([expect.stringMatching(/099_x\.sql: LABEL ON QF_T is 52 bytes/)]);
  });
});

describe('verify-ibmi: read-only run (default)', () => {
  it('runs only SELECT / VALUES statements and passes on a healthy system', async () => {
    const ibmi = new FakeIbmi({ existingLibraries: {} });
    const r = await runVerification(opts(), { factory: ibmi.factory });
    expect(r.mode).toBe('read-only');
    expect(ibmi.writes()).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.readCount).toBeGreaterThan(5);
    expect(status(r, 'os.level')).toEqual(['PASS']);
    expect(status(r, 'sql.offset')).toEqual(['PASS']);
    expect(status(r, 'ro.special')).toEqual(['PASS']);
    expect(status(r, 'ro.files.SAMPLELIB')).toEqual(['PASS']);
    expect(status(r, 'exec.exact')).toEqual(['PASS']);
    expect(status(r, 'exec.validator')).toEqual(['PASS']);
    // The library does not exist and nothing may create it in a read-only run.
    expect(status(r, 'objects.skip')).toEqual(['SKIP']);
    expect(r.ok).toBe(true);
    // The reporting job is opened read only, like the app's.
    const reportConn = ibmi.connections.find((c) => c.user === 'QFREPORT');
    expect(reportConn?.options).toMatchObject({ access: 'read only' });
  });

  it('fails on an old release, *ALLOBJ and writable data files', async () => {
    const ibmi = new FakeIbmi({
      os: { version: '7', release: '1' },
      specialAuthorities: '*ALLOBJ    *JOBCTL',
      fileAuthorities: [
        {
          SYSTEM_OBJECT_NAME: 'ORDERS',
          AUTHORIZATION_NAME: '*PUBLIC',
          OBJECT_AUTHORITY: '*CHANGE',
          OBJECT_OWNER: 'NO',
          DATA_ADD: 'YES',
          DATA_UPDATE: 'YES',
          DATA_DELETE: 'YES',
          OBJECT_EXISTENCE: 'NO',
          OBJECT_ALTER: 'NO',
        },
      ],
    });
    const r = await runVerification(opts(), { factory: ibmi.factory });
    expect(status(r, 'os.level')).toEqual(['FAIL']);
    expect(status(r, 'ro.special')).toEqual(['FAIL']);
    expect(status(r, 'ro.files.SAMPLELIB')).toEqual(['FAIL']);
    expect(r.results.find((x) => x.id === 'ro.files.SAMPLELIB')?.detail).toContain(
      'SAMPLELIB/ORDERS - *PUBLIC *CHANGE',
    );
    expect(r.ok).toBe(false);
    expect(exitCode(r)).toBe(1);
    expect(ibmi.writes()).toEqual([]);
  });

  it('reports a connection failure instead of crashing', async () => {
    const ibmi = new FakeIbmi({ connectError: 'connect ECONNREFUSED 192.0.2.1:8076' });
    const r = await runVerification(opts(), { factory: ibmi.factory });
    expect(status(r, 'connect.report')).toEqual(['FAIL']);
    expect(status(r, 'connect.meta')).toEqual(['FAIL']);
    expect(r.ok).toBe(false);
  });

  it('refuses to apply migrations into a library it did not create', async () => {
    const ibmi = new FakeIbmi({ existingLibraries: { UBVERIFY: ['CUSTOMERS'] } });
    const r = await runVerification(opts({ applyMigrations: true, smoke: false }), {
      factory: ibmi.factory,
    });
    expect(status(r, 'apply.refused')).toEqual(['FAIL']);
    expect(ibmi.writes()).toEqual([]);
  });

  it('refuses to drop a library without the kit marker', async () => {
    const ibmi = new FakeIbmi({ existingLibraries: { UBVERIFY: ['QF_USERS'] } });
    const r = await runVerification(opts({ cleanup: 'UBVERIFY' }), { factory: ibmi.factory });
    expect(status(r, 'cleanup')).toEqual(['FAIL']);
    expect(ibmi.libraries.has('UBVERIFY')).toBe(true);
    expect(ibmi.writes()).toEqual([]);
  });
  it('refuses to drop a kit library that has gained non-file objects', async () => {
    const ibmi = new FakeIbmi({
      otherObjects: { UBVERIFY: [{ OBJNAME: 'PAYROLL', OBJTYPE: '*PGM' }] },
    });
    const r = await runVerification(
      opts({ applyMigrations: true, smoke: false, cleanup: 'UBVERIFY' }),
      {
        factory: ibmi.factory,
      },
    );
    expect(status(r, 'cleanup')).toEqual(['FAIL']);
    expect(r.results.find((x) => x.id === 'cleanup')?.detail).toContain('PAYROLL (*PGM)');
    expect(ibmi.libraries.has('UBVERIFY')).toBe(true);
    expect(ibmi.writes().some((w) => w.sql.startsWith('DROP SCHEMA'))).toBe(false);
  });
});

describe('verify-ibmi: disposable library round trip', () => {
  it('creates the library, applies 001-012, verifies every object and drops it', async () => {
    const ibmi = new FakeIbmi();
    const r = await runVerification(
      opts({ applyMigrations: true, smoke: false, cleanup: 'UBVERIFY' }),
      { factory: ibmi.factory },
    );
    expect(r.mode).toBe('writes-to-disposable-library');
    for (let v = 1; v <= 12; v++) {
      expect(status(r, `apply.${v}`), `apply ${v}`).toEqual(['PASS']);
      expect(status(r, `objects.${v}`), `objects ${v}`).toEqual(['PASS']);
    }
    expect(status(r, 'objects.versions')).toEqual(['PASS']);
    expect(status(r, 'objects.journal')).toEqual(['PASS']);
    expect(status(r, 'objects.separation')).toEqual(['PASS']);
    expect(
      r.results.filter((x) => x.section === 'Metadata queries').every((x) => x.status === 'PASS'),
    ).toBe(true);
    expect(status(r, 'cleanup')).toEqual(['PASS']);
    expect(ibmi.libraries.has('UBVERIFY')).toBe(false);
    expect(r.summary.FAIL).toBe(0);
    expect(r.ok).toBe(true);
    // Every write named only the disposable library.
    expect(ibmi.writes().length).toBeGreaterThan(50);
    for (const w of ibmi.writes()) {
      expect(w.user).toBe('QFAPPTEST');
      expect(w.sql).toMatch(/UBVERIFY/);
      expect(w.sql).not.toMatch(/\b(QFMETA|SAMPLELIB)\b/);
    }
    expect(ibmi.writes()[0].sql).toBe('CREATE SCHEMA UBVERIFY');
    expect(ibmi.writes().at(-1)?.sql).toBe('DROP SCHEMA UBVERIFY CASCADE');
    expect(r.writes.some((w) => w.includes(MARKER_TABLE))).toBe(true);
  });

  it('reports missing or wrong objects against the migration that should create them', async () => {
    const ibmi = new FakeIbmi({
      hideIndexes: ['QF_SDLV_IX_SCHED'],
      checkClauses: { QF_FSAU_CK_TYPE: "PRINCIPAL_TYPE IN ('USER', 'GROUP')" },
    });
    const r = await runVerification(opts({ applyMigrations: true, smoke: false }), {
      factory: ibmi.factory,
    });
    expect(status(r, 'objects.10')).toEqual(['FAIL']);
    expect(r.results.find((x) => x.id === 'objects.10')?.detail).toContain(
      'index QF_SDLV_IX_SCHED on QF_SCHEDULE_DELIVERIES is missing',
    );
    expect(status(r, 'objects.12')).toEqual(['FAIL']);
    expect(r.results.find((x) => x.id === 'objects.12')?.detail).toContain("lacks 'REPORTS'");
    expect(status(r, 'objects.9')).toEqual(['PASS']);
  });

  it('stops at the first failing migration statement and says where', async () => {
    const ibmi = new FakeIbmi({
      failOn: {
        pattern: /^CREATE TABLE UBVERIFY\.QF_TILE_ORDER/,
        sqlState: '42601',
        sqlCode: -104,
      },
    });
    const r = await runVerification(opts({ applyMigrations: true }), { factory: ibmi.factory });
    expect(status(r, 'apply.7')).toEqual(['PASS']);
    expect(status(r, 'apply.8')).toEqual(['FAIL']);
    expect(status(r, 'apply.9')).toEqual([]);
    expect(r.results.find((x) => x.id === 'apply.8')?.detail).toMatch(
      /SQLSTATE 42601, SQLCODE -104/,
    );
    expect(status(r, 'smoke.skip')).toEqual(['SKIP']);
  });

  it('runs the write smoke test through the app repositories, confined to the library', async () => {
    const ibmi = new FakeIbmi();
    const r = await runVerification(opts({ applyMigrations: true }), { factory: ibmi.factory });
    const smoke = r.results.filter((x) => x.section === 'Smoke test (disposable library)');
    expect(smoke.length).toBeGreaterThanOrEqual(3);
    // The fake cannot answer the app's joins, so some steps fail here; none may be blocked by policy
    // and no write may leave the disposable library.
    expect(smoke.map((s) => s.detail ?? '').join('\n')).not.toMatch(/safety policy/);
    for (const w of ibmi.writes()) expect(w.sql).toMatch(/\bUBVERIFY\b/);
    for (const table of ['QF_USERS', 'QF_REPORTS', 'QF_FOLDERS'])
      expect(
        ibmi.writes().some((w) => w.sql.trim().startsWith(`INSERT INTO UBVERIFY.${table}`)),
        table,
      ).toBe(true);
  });
});

describe('verify-ibmi: report output', () => {
  it('formats a readable report and JSON without passwords', async () => {
    const ibmi = new FakeIbmi();
    const r = await runVerification(
      opts({ applyMigrations: true, smoke: false, cleanup: 'UBVERIFY' }),
      {
        factory: ibmi.factory,
        now: () => new Date('2026-11-13T12:00:00Z'),
      },
    );
    const text = formatReport(r);
    expect(text).toContain('Uncle Bob - IBM i verification report');
    expect(text).toContain('Target: ibmi-test.example.invalid:8076');
    expect(text).toMatch(
      /\n {2}\[PASS\] Applied 009_shared_folders\.sql \(\d+ statements\) \(migration 009\)/,
    );
    expect(text).toMatch(
      /Summary: \d+ passed, 0 failed, \d+ warning\(s\), \d+ skipped\. Result: PASS$/,
    );
    expect(text.indexOf('\nSafety')).toBeLessThan(text.indexOf('\nMigrations'));
    expect(text.indexOf('\nMigrations')).toBeLessThan(text.indexOf('\nCleanup'));
    const json = JSON.stringify(r);
    expect(json).not.toContain(REPORT_PW);
    expect(json).not.toContain(META_PW);
    expect(text).not.toContain(META_PW);
    expect(r.startedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(r.summary.PASS).toBe(r.results.filter((x) => x.status === 'PASS').length);
  });

  it('formats a refusal', async () => {
    const r = await runVerification(opts({ target: undefined }));
    const text = formatReport(r);
    expect(text).toContain('REFUSED - nothing was connected to:');
    expect(text).toContain('Result: FAIL');
  });
});

describe('verify-ibmi: readAll', () => {
  it('fetches past the first block of rows', async () => {
    const ibmi = new FakeIbmi();
    const job = ibmi.factory({});
    await job.connect({ host: 'h', user: 'U', password: 'p' });
    // FakeIbmi answers SYSCOLUMNS for the library from the expected schema (>100 rows once created).
    ibmi.libraries.set(
      'UBVERIFY',
      new Map(expectedSchema().tables.map((t) => [t.name, { type: 'T', text: '' }])),
    );
    const rows = await readAll(
      job,
      'SELECT TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ?',
      ['UBVERIFY'],
    );
    expect(rows.length).toBe(expectedSchema().columns.length);
    expect(rows.length).toBeGreaterThan(100);
  });
});
