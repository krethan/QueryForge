/**
 * The IBM i verification run. Everything that touches the network goes through an injected
 * JobFactory wrapped in ConfinedJob, so unit tests drive the whole run with fakes.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import {
  defaultJobFactory,
  MapepireMetadataDb,
  metadataJdbcOptions,
  openJob,
  readAllRows,
  reportingJdbcOptions,
} from '../../src/db/mapepire.js';
import {
  loadMigrations,
  VERSION_TABLE,
  versionTableDdl,
  type MigrationFile,
} from '../../src/db/migration-files.js';
import { NOW_UTC, T, toDbTimestamp } from '../../src/db/schema.js';
import type { JobFactory, MetadataDb, SqlJobLike } from '../../src/db/types.js';
import { UserRepository } from '../../src/auth/users.js';
import { CatalogService } from '../../src/catalog/catalog.js';
import { HistoryRepository } from '../../src/history/history.js';
import { FolderRepository } from '../../src/reports/folders.js';
import { ReportRepository, reportInputSchema, type Report } from '../../src/reports/reports.js';
import { TileOrderRepository } from '../../src/reports/tile-order.js';
import { ScheduleRepository } from '../../src/scheduler/schedules.js';
import { RecipientService } from '../../src/scheduler/recipients.js';
import { AccessService } from '../../src/sharing/access.js';
import { FolderAccessService } from '../../src/sharing/folder-access.js';
import { GroupRepository } from '../../src/sharing/groups.js';
import { QueryExecutor } from '../../src/sql/executor.js';
import { toDbError } from '../../src/util/errors.js';
import { MemoryMailer } from '../../src/mail/mailer.js';
import { ShareNotifier } from '../../src/notifications/share-notifier.js';
import { UserSettingsRepository } from '../../src/notifications/settings.js';
import { NotificationInbox } from '../../src/notifications/inbox.js';
import { RetentionService } from '../../src/retention/retention.js';
import {
  confinedFactory,
  PolicyViolation,
  type StatementLogEntry,
  type WritePolicy,
} from './confine.js';
import { expectedSchema, lintMigrations, type ExpectedSchema } from './expected.js';
import { evaluateGuard, type Identity, type VerifyOptions } from './options.js';
import { summarise, type CheckResult, type Status, type VerificationReport } from './report.js';

/** Marker table the kit creates in a library it owns; cleanup refuses libraries without it. */
export const MARKER_TABLE = 'QF_VERIFY_KIT';
export const MIN_OS = { version: 7, release: 2 };

export interface RunDeps {
  factory?: JobFactory;
  now?: () => Date;
}

type Row = Record<string, unknown>;

class Recorder {
  readonly results: CheckResult[] = [];
  add(
    section: string,
    id: string,
    title: string,
    status: Status,
    detail?: string,
    migration?: number,
  ) {
    this.results.push({
      section,
      id,
      title,
      status,
      ...(detail ? { detail } : {}),
      ...(migration ? { migration } : {}),
    });
  }
}

export function describeError(e: unknown): string {
  if (e instanceof PolicyViolation) return `Blocked by the kit's safety policy: ${e.message}`;
  const d = toDbError(e);
  const codes = [d.sqlState && `SQLSTATE ${d.sqlState}`, d.sqlCode && `SQLCODE ${d.sqlCode}`]
    .filter(Boolean)
    .join(', ');
  return codes ? `${d.message} (${codes})` : d.message;
}

/** Read every row of a statement (SQLJob.execute alone returns only the first 100). */
export function readAll<T = Row>(
  job: SqlJobLike,
  sql: string,
  params: (string | number | null)[] = [],
): Promise<T[]> {
  return readAllRows<T>(job, sql, params);
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const words = (v: unknown) => str(v).split(/\s+/).filter(Boolean);

/** App configuration for the kit's own connections, built only from QF_VERIFY_* values. */
export function kitConfig(o: VerifyOptions): AppConfig {
  const report = o.report as Identity;
  const meta = (o.meta?.user ? o.meta : o.report) as Identity;
  return loadConfig({
    NODE_ENV: 'development',
    MAPEPIRE_HOST: o.host,
    MAPEPIRE_PORT: String(o.port),
    MAPEPIRE_REJECT_UNAUTHORIZED: String(o.rejectUnauthorized),
    ...(o.caFile ? { MAPEPIRE_CA_FILE: o.caFile } : {}),
    REPORT_DB_USER: report.user,
    REPORT_DB_PASSWORD: report.password,
    ...(o.dataLibraries.length ? { REPORT_LIBRARIES: o.dataLibraries.join(',') } : {}),
    META_DB_USER: meta.user,
    META_DB_PASSWORD: meta.password,
    META_SCHEMA: o.schema ?? 'UBVERIFY',
    META_POOL_SIZE: '1',
    SESSION_SECRET: randomBytes(24).toString('hex'),
    CONNECT_TIMEOUT_MS: '30000',
    QUERY_TIMEOUT_MS: '120000',
    MAX_RESULT_ROWS: '1000',
    CATALOG_CACHE_TTL_MS: '0',
  } as NodeJS.ProcessEnv);
}

/** MetadataDb over one job that only reads; app repositories run unchanged on top of it. */
function readOnlyMetadataDb(job: SqlJobLike): MetadataDb {
  const refuse = async (): Promise<never> => {
    throw new PolicyViolation('Metadata writes are not part of the read-only checks.');
  };
  return {
    query: <T>(sql: string, params: (string | number | null)[] = []) =>
      readAll<T>(job, sql, params),
    update: refuse,
    transaction: refuse,
    ping: async () => undefined,
    close: async () => undefined,
  };
}

export async function runVerification(
  o: VerifyOptions,
  deps: RunDeps = {},
): Promise<VerificationReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const rec = new Recorder();
  const log: StatementLogEntry[] = [];
  const guard = evaluateGuard(o);
  const base = {
    tool: 'uncle-bob-verify-ibmi' as const,
    formatVersion: 1 as const,
    startedAt,
    target: {
      host: o.host,
      port: o.port,
      reportUser: o.report?.user?.toUpperCase(),
      metaUser: o.meta?.user?.toUpperCase(),
      schema: o.schema,
      dataLibraries: o.dataLibraries,
    },
  };
  const finish = (mode: VerificationReport['mode']): VerificationReport => {
    const summary = summarise(rec.results);
    return {
      ...base,
      finishedAt: now().toISOString(),
      mode,
      refusedBecause: guard.ok ? [] : guard.errors,
      results: rec.results,
      summary,
      writes: log.filter((l) => l.kind === 'write').map((l) => `[${l.identity}] ${l.sql}`),
      readCount: log.filter((l) => l.kind === 'read').length,
      ok: guard.ok && summary.FAIL === 0,
    };
  };

  // ---- Safety -------------------------------------------------------------------------------
  if (!guard.ok) {
    for (const e of guard.errors) rec.add('Safety', 'guard', e, 'FAIL');
    return finish('refused');
  }
  rec.add(
    'Safety',
    'guard.nonprod',
    'Target marked non-production (QF_VERIFY_TARGET=nonprod and --confirm-nonprod)',
    'PASS',
  );
  rec.add(
    'Safety',
    'guard.mode',
    guard.readOnly
      ? 'Read-only run: only SELECT and VALUES statements are allowed'
      : `Writes allowed, confined by the kit to library ${o.schema}`,
    'INFO',
  );
  for (const w of guard.warnings) rec.add('Safety', 'guard.warning', w, 'WARN');

  // ---- Static checks (no connection) --------------------------------------------------------
  const migrations = loadMigrations(o.schema ?? 'UBVERIFY');
  const expected: ExpectedSchema = expectedSchema();
  const lint = lintMigrations(expected);
  rec.add(
    'Static checks',
    'static.migrations',
    `Migration files ${migrations.map((m) => String(m.version).padStart(3, '0')).join(', ')} parsed: ${expected.tables.length} tables, ${expected.constraints.length} constraints, ${expected.indexes.length} indexes expected`,
    lint.length ? 'FAIL' : 'PASS',
    lint.join('\n'),
  );

  const policy: WritePolicy = { writesAllowed: !guard.readOnly, schema: o.schema };
  const readOnlyPolicy: WritePolicy = { writesAllowed: false };
  if (o.dryRun) {
    const plan = [
      `Connect to ${o.host}:${o.port} as ${o.report?.user} (read only) and check OS level, Db2 PTF group, OFFSET/FETCH and authorities.`,
      o.dataLibraries.length
        ? `Check ${o.report?.user} cannot add, change or delete in ${o.dataLibraries.join(', ')}.`
        : 'No data libraries given: authority checks on data libraries would be skipped.',
      o.schema && o.meta?.user
        ? `Connect as ${o.meta.user} and check library ${o.schema}${o.applyMigrations ? ' after creating it and applying migrations' : ''}.`
        : 'No metadata profile/library: metadata checks would be skipped.',
      o.applyMigrations && o.smoke ? `Run the write smoke test inside ${o.schema}.` : '',
      o.cleanup ? `Drop library ${o.schema} (only if it carries the ${MARKER_TABLE} marker).` : '',
    ].filter(Boolean);
    rec.add('Safety', 'dry-run', 'Dry run: nothing was connected to', 'INFO', plan.join('\n'));
    return finish('dry-run');
  }

  const cfg = kitConfig(o);
  const factory = deps.factory ?? defaultJobFactory;
  const reportUser = (o.report as Identity).user.toUpperCase();

  // ---- Connectivity + platform + read-only (reporting profile) --------------------------------
  let reportJob: SqlJobLike | undefined;
  try {
    reportJob = await openJob(
      cfg,
      cfg.reporting,
      reportingJdbcOptions(cfg),
      confinedFactory(factory, readOnlyPolicy, reportUser, log),
    );
    const who = await readAll(
      reportJob,
      'SELECT CURRENT SERVER AS SERVER_NAME, CURRENT USER AS USER_NAME, CURRENT TIMESTAMP AS NOW_TS FROM SYSIBM.SYSDUMMY1',
    );
    const u = str(who[0]?.USER_NAME);
    rec.add(
      'Connectivity',
      'connect.report',
      `Connected through Mapepire as the reporting profile`,
      u && u !== reportUser ? 'WARN' : 'PASS',
      `Relational database ${str(who[0]?.SERVER_NAME) || '?'}, CURRENT USER ${u || '?'}${u && u !== reportUser ? ` (expected ${reportUser})` : ''}`,
    );
  } catch (e) {
    rec.add(
      'Connectivity',
      'connect.report',
      'Connect as the reporting profile',
      'FAIL',
      describeError(e),
    );
  }

  if (reportJob) {
    await platformChecks(reportJob, rec);
    await readOnlyChecks(reportJob, rec, o, reportUser);
    await reportJob.close().catch(() => undefined);
    await reportingPathChecks(cfg, confinedFactory(factory, readOnlyPolicy, reportUser, log), rec);
  }

  // ---- Metadata library (metadata profile) ----------------------------------------------------
  if (!o.schema || !o.meta?.user) {
    rec.add(
      'Metadata library',
      'meta.skip',
      'Metadata checks skipped (set QF_VERIFY_SCHEMA, QF_VERIFY_META_USER and QF_VERIFY_META_PASSWORD)',
      'SKIP',
    );
    return finish(guard.readOnly ? 'read-only' : 'writes-to-disposable-library');
  }
  const schema = o.schema;
  const metaUser = o.meta.user.toUpperCase();
  let metaJob: SqlJobLike | undefined;
  try {
    metaJob = await openJob(
      cfg,
      cfg.metadata,
      { ...metadataJdbcOptions(cfg), libraries: [] },
      confinedFactory(factory, policy, metaUser, log),
    );
    rec.add(
      'Connectivity',
      'connect.meta',
      'Connected through Mapepire as the metadata profile',
      'PASS',
      `Profile ${metaUser}`,
    );
  } catch (e) {
    rec.add(
      'Connectivity',
      'connect.meta',
      'Connect as the metadata profile',
      'FAIL',
      describeError(e),
    );
  }
  if (metaJob) {
    try {
      await metadataPhase(
        metaJob,
        rec,
        o,
        schema,
        expected,
        migrations,
        cfg,
        factory,
        policy,
        log,
        reportUser,
        metaUser,
      );
    } finally {
      await metaJob.close().catch(() => undefined);
    }
  }
  return finish(guard.readOnly ? 'read-only' : 'writes-to-disposable-library');
}

async function platformChecks(job: SqlJobLike, rec: Recorder) {
  const P = 'Platform';
  try {
    const r = await readAll(
      job,
      'SELECT OS_NAME, OS_VERSION, OS_RELEASE FROM SYSIBMADM.ENV_SYS_INFO',
    );
    const v = Number(str(r[0]?.OS_VERSION));
    const rel = Number(str(r[0]?.OS_RELEASE));
    const ok = v > MIN_OS.version || (v === MIN_OS.version && rel >= MIN_OS.release);
    rec.add(
      P,
      'os.level',
      `IBM i ${v}.${rel} (Uncle Bob needs ${MIN_OS.version}.${MIN_OS.release} or later)`,
      Number.isFinite(v) && ok ? 'PASS' : 'FAIL',
      str(r[0]?.OS_NAME),
    );
  } catch (e) {
    rec.add(
      P,
      'os.level',
      'Read the IBM i release from SYSIBMADM.ENV_SYS_INFO',
      'FAIL',
      describeError(e),
    );
  }
  try {
    const r = await readAll(
      job,
      `SELECT PTF_GROUP_NAME, PTF_GROUP_LEVEL, PTF_GROUP_STATUS FROM QSYS2.GROUP_PTF_INFO
        WHERE PTF_GROUP_DESCRIPTION LIKE '%DB2 FOR IBM I%' AND PTF_GROUP_STATUS = 'INSTALLED'
        ORDER BY PTF_GROUP_LEVEL DESC FETCH FIRST 1 ROW ONLY`,
    );
    if (r[0])
      rec.add(
        P,
        'db2.group',
        `Db2 for i PTF group ${str(r[0].PTF_GROUP_NAME)} level ${str(r[0].PTF_GROUP_LEVEL)} installed`,
        'INFO',
      );
    else
      rec.add(
        P,
        'db2.group',
        'No installed Db2 for i PTF group was listed',
        'WARN',
        'Check WRKPTFGRP; the database group PTF should be current.',
      );
  } catch (e) {
    rec.add(
      P,
      'db2.group',
      'Read the Db2 for i PTF group level from QSYS2.GROUP_PTF_INFO',
      'WARN',
      describeError(e),
    );
  }
  try {
    const r = await readAll(
      job,
      `SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2'
        ORDER BY TABLE_NAME OFFSET 1 ROWS FETCH FIRST 2 ROWS ONLY`,
    );
    rec.add(
      P,
      'sql.offset',
      'OFFSET ... FETCH FIRST paging works (folder audit paging uses it)',
      r.length === 2 ? 'PASS' : 'FAIL',
      r.length === 2 ? undefined : `Expected 2 rows, got ${r.length}`,
    );
  } catch (e) {
    rec.add(P, 'sql.offset', 'OFFSET ... FETCH FIRST paging works', 'FAIL', describeError(e));
  }
}

async function readOnlyChecks(job: SqlJobLike, rec: Recorder, o: VerifyOptions, user: string) {
  const R = 'Read-only reporting profile';
  rec.add(
    R,
    'ro.jdbc',
    'Reporting job opened with the JDBC "access=read only" property, as the app does',
    'INFO',
  );
  let groups: string[] = [];
  try {
    const r = await readAll(
      job,
      `SELECT SPECIAL_AUTHORITIES, GROUP_PROFILE_NAME, SUPPLEMENTAL_GROUP_LIST, USER_CLASS_NAME
         FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ?`,
      [user],
    );
    if (!r[0])
      rec.add(
        R,
        'ro.special',
        `Special authorities of ${user}`,
        'WARN',
        'QSYS2.USER_INFO returned no row for the profile; ask the security officer to run DSPUSRPRF.',
      );
    else {
      const spc = words(r[0].SPECIAL_AUTHORITIES).filter((w) => w !== '*NONE');
      groups = [str(r[0].GROUP_PROFILE_NAME), ...words(r[0].SUPPLEMENTAL_GROUP_LIST)].filter(
        (g) => g && g !== '*NONE',
      );
      const bad = spc.filter((s) => s === '*ALLOBJ' || s === '*SECADM');
      rec.add(
        R,
        'ro.special',
        `${user} has no *ALLOBJ or *SECADM special authority`,
        bad.length ? 'FAIL' : spc.length ? 'WARN' : 'PASS',
        `Special authorities: ${spc.join(' ') || '*NONE'}; user class ${str(r[0].USER_CLASS_NAME) || '?'}; groups: ${groups.join(' ') || '*NONE'}`,
      );
    }
  } catch (e) {
    rec.add(R, 'ro.special', `Special authorities of ${user}`, 'WARN', describeError(e));
  }
  if (!o.dataLibraries.length) {
    rec.add(
      R,
      'ro.libs',
      'Data library authority checks',
      'SKIP',
      'QF_VERIFY_DATA_LIBRARIES is empty.',
    );
    return;
  }
  const names = [user, ...groups, '*PUBLIC'];
  const inList = names.map(() => '?').join(', ');
  for (const lib of o.dataLibraries) {
    try {
      const exists = await readAll(
        job,
        'SELECT COUNT(*) AS N FROM QSYS2.SYSSCHEMAS WHERE SYSTEM_SCHEMA_NAME = ? OR SCHEMA_NAME = ?',
        [lib, lib],
      );
      if (Number(exists[0]?.N ?? 0) === 0) {
        rec.add(
          R,
          `ro.lib.${lib}`,
          `Library ${lib} exists`,
          'FAIL',
          'Not found (or not visible to the reporting profile).',
        );
        continue;
      }
      const libAuth = await readAll(
        job,
        `SELECT AUTHORIZATION_NAME, OBJECT_AUTHORITY, DATA_ADD, DATA_DELETE, OBJECT_OWNER
           FROM QSYS2.OBJECT_PRIVILEGES
          WHERE SYSTEM_OBJECT_SCHEMA = 'QSYS' AND SYSTEM_OBJECT_NAME = ? AND OBJECT_TYPE = '*LIB'
            AND AUTHORIZATION_NAME IN (${inList})`,
        [lib, ...names],
      );
      const libBad = libAuth.filter(
        (a) =>
          str(a.OBJECT_OWNER) === 'YES' ||
          str(a.DATA_ADD) === 'YES' ||
          str(a.DATA_DELETE) === 'YES' ||
          str(a.OBJECT_AUTHORITY) === '*ALL',
      );
      rec.add(
        R,
        `ro.lib.${lib}`,
        `${user} cannot create or delete objects in library ${lib}`,
        libBad.length ? 'FAIL' : libAuth.length ? 'PASS' : 'WARN',
        libBad.length
          ? libBad
              .map(
                (a) =>
                  `${str(a.AUTHORIZATION_NAME)}: ${str(a.OBJECT_AUTHORITY)}${str(a.OBJECT_OWNER) === 'YES' ? ' (owner)' : ''}`,
              )
              .join('\n')
          : libAuth.length
            ? libAuth
                .map((a) => `${str(a.AUTHORIZATION_NAME)}: ${str(a.OBJECT_AUTHORITY)}`)
                .join('; ')
            : 'No authority rows were visible to this profile for the library; confirm with DSPOBJAUT.',
      );
      const files = await readAll(
        job,
        `SELECT SYSTEM_OBJECT_NAME, AUTHORIZATION_NAME, OBJECT_AUTHORITY, OBJECT_OWNER, DATA_ADD, DATA_UPDATE, DATA_DELETE,
                OBJECT_EXISTENCE, OBJECT_ALTER, AUTHORIZATION_LIST
           FROM QSYS2.OBJECT_PRIVILEGES
          WHERE SYSTEM_OBJECT_SCHEMA = ? AND OBJECT_TYPE = '*FILE' AND AUTHORIZATION_NAME IN (${inList})`,
        [lib, ...names],
      );
      const writable = files.filter((f) =>
        [
          'OBJECT_OWNER',
          'DATA_ADD',
          'DATA_UPDATE',
          'DATA_DELETE',
          'OBJECT_EXISTENCE',
          'OBJECT_ALTER',
        ].some((k) => str(f[k]) === 'YES'),
      );
      const autl = files.filter((f) => str(f.OBJECT_AUTHORITY) === '*AUTL');
      const sample = writable
        .slice(0, 15)
        .map(
          (f) =>
            `${lib}/${str(f.SYSTEM_OBJECT_NAME)} - ${str(f.AUTHORIZATION_NAME)} ${str(f.OBJECT_AUTHORITY)}`,
        );
      rec.add(
        R,
        `ro.files.${lib}`,
        `${user} has no add/update/delete authority to files in ${lib}`,
        writable.length ? 'FAIL' : files.length ? 'PASS' : 'WARN',
        writable.length
          ? `${writable.length} writable authority row(s):\n${sample.join('\n')}${writable.length > 15 ? '\n...' : ''}`
          : files.length
            ? `${files.length} authority row(s) checked for ${names.join(', ')}.${autl.length ? ` ${autl.length} use an authorization list; check the list with DSPAUTL.` : ''}`
            : 'No file authority rows were visible to this profile. Without *OBJMGT a profile only sees its own private authorities; confirm *PUBLIC and group authority with DSPOBJAUT or PRTPVTAUT.',
      );
    } catch (e) {
      rec.add(R, `ro.lib.${lib}`, `Authority checks for ${lib}`, 'WARN', describeError(e));
    }
  }
  rec.add(
    R,
    'ro.caveat',
    'Catalog checks cannot see adopted authority from programs; the app also runs report SQL with access=read only',
    'INFO',
  );
}

async function reportingPathChecks(cfg: AppConfig, factory: JobFactory, rec: Recorder) {
  const R = 'Reporting path';
  const ex = new QueryExecutor(cfg, factory);
  try {
    const out = await ex.run(
      'SELECT CAST(12345678901234567.89 AS DECIMAL(19, 2)) AS AMOUNT, CAST(9007199254740993 AS BIGINT) AS BIG FROM SYSIBM.SYSDUMMY1',
      'ibmi-verification',
    );
    const [amount, big] = out.rows[0] ?? [];
    const exact = String(amount) === '12345678901234567.89' && String(big) === '9007199254740993';
    rec.add(
      R,
      'exec.exact',
      'Report executor keeps DECIMAL and BIGINT values exact',
      exact ? 'PASS' : 'FAIL',
      `Got ${String(amount)} and ${String(big)}`,
    );
  } catch (e) {
    rec.add(
      R,
      'exec.exact',
      'Report executor runs a query as the reporting profile',
      'FAIL',
      describeError(e),
    );
  }
  try {
    ex.validate('DELETE FROM SOMELIB.SOMEFILE');
    rec.add(
      R,
      'exec.validator',
      'SQL validator refuses a DELETE before it reaches IBM i',
      'FAIL',
      'The validator accepted it.',
    );
  } catch {
    rec.add(
      R,
      'exec.validator',
      'SQL validator refuses a DELETE before it reaches IBM i (checked locally)',
      'PASS',
    );
  }
  try {
    const catalog = new CatalogService(cfg, ex, { ttlMs: 0 });
    const t = await catalog.listTables('ibmi-verification', { limit: 5 });
    rec.add(
      R,
      'exec.catalog',
      'Report Builder table list (QSYS2.SYSTABLES + SQL_CHECK_AUTHORITY) runs',
      'PASS',
      `${t.tables.length} table(s) listed: ${t.tables.map((x) => `${x.schema}.${x.name}`).join(', ') || 'none'}`,
    );
  } catch (e) {
    rec.add(R, 'exec.catalog', 'Report Builder table list runs', 'FAIL', describeError(e));
  }
}

async function libraryState(job: SqlJobLike, schema: string) {
  const s = await readAll(job, 'SELECT COUNT(*) AS N FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = ?', [
    schema,
  ]);
  const exists = Number(s[0]?.N ?? 0) > 0;
  const objects = exists
    ? await readAll<{ TABLE_NAME: string; TABLE_TYPE: string; TABLE_TEXT: string }>(
        job,
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_TEXT FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ?',
        [schema],
      )
    : [];
  const tables = objects.filter((t) => ['T', 'P'].includes(str(t.TABLE_TYPE)));
  // CREATE SCHEMA adds its own catalog views (SYSTABLES, SYSCOLUMNS, ...) inside the library.
  const foreign = objects.filter(
    (t) =>
      !(['T', 'P'].includes(str(t.TABLE_TYPE)) && str(t.TABLE_NAME).startsWith('QF_')) &&
      !(str(t.TABLE_TYPE) === 'V' && str(t.TABLE_NAME).startsWith('SYS')),
  );
  return {
    exists,
    objects,
    tables,
    foreign,
    marked: tables.some((t) => str(t.TABLE_NAME) === MARKER_TABLE),
  };
}

async function metadataPhase(
  job: SqlJobLike,
  rec: Recorder,
  o: VerifyOptions,
  schema: string,
  expected: ExpectedSchema,
  migrations: MigrationFile[],
  cfg: AppConfig,
  factory: JobFactory,
  policy: WritePolicy,
  log: StatementLogEntry[],
  reportUser: string,
  metaUser: string,
) {
  const M = 'Metadata library';
  let state = await libraryState(job, schema);
  rec.add(
    M,
    'meta.library',
    `Library ${schema} ${state.exists ? 'exists' : 'does not exist'}`,
    'INFO',
    state.exists
      ? `${state.tables.length} table(s); ${state.marked ? `created by this kit (${MARKER_TABLE} present)` : `no ${MARKER_TABLE} marker`}`
      : undefined,
  );

  let migrationsOk = true;
  if (o.applyMigrations) {
    migrationsOk = await applyMigrations(job, rec, o, schema, migrations, state);
    state = await libraryState(job, schema);
  }

  if (!state.exists) {
    rec.add(
      'Schema objects',
      'objects.skip',
      `Catalog checks skipped: library ${schema} does not exist`,
      o.applyMigrations ? 'FAIL' : 'SKIP',
      o.applyMigrations ? undefined : 'Run again with --apply-migrations to create it.',
    );
  } else {
    const allPresent = await catalogChecks(job, rec, schema, expected, migrations, state);
    await separationCheck(
      cfg,
      confinedFactory(factory, { writesAllowed: false }, reportUser, log),
      rec,
      schema,
      reportUser,
    );
    if (allPresent) await metadataQueries(job, rec, schema);
    else
      rec.add(
        'Metadata queries',
        'mq.skip',
        'App metadata queries skipped because objects are missing',
        'SKIP',
      );
    if (o.applyMigrations && o.smoke && migrationsOk && allPresent)
      await smokeTest(cfg, factory, policy, log, rec, schema, metaUser);
    else if (o.applyMigrations && o.smoke)
      rec.add(
        'Smoke test (disposable library)',
        'smoke.skip',
        'Smoke test skipped because migrations or objects did not verify',
        'SKIP',
      );
  }

  if (o.cleanup) await cleanup(job, rec, schema);
}

async function applyMigrations(
  job: SqlJobLike,
  rec: Recorder,
  o: VerifyOptions,
  schema: string,
  migrations: MigrationFile[],
  state: Awaited<ReturnType<typeof libraryState>>,
): Promise<boolean> {
  const G = 'Migrations';
  if (state.exists && !state.marked) {
    if (!(o.adoptEmptyLibrary && state.tables.length === 0 && state.foreign.length === 0)) {
      rec.add(
        G,
        'apply.refused',
        `Refused to apply migrations: ${schema} already exists and was not created by this kit`,
        'FAIL',
        state.tables.length || state.foreign.length
          ? `It holds ${state.tables.length + state.foreign.length} object(s). Choose a new disposable library name.`
          : 'It is empty; pass --adopt-empty-library to use it.',
      );
      return false;
    }
  }
  try {
    if (!state.exists) {
      await job.execute(`CREATE SCHEMA ${schema}`);
      rec.add(G, 'apply.schema', `Created library ${schema} with CREATE SCHEMA`, 'PASS');
    }
    if (!state.marked) {
      await job.execute(
        `CREATE TABLE ${schema}.${MARKER_TABLE} (RUN_ID VARCHAR(36) NOT NULL, CREATED_AT TIMESTAMP NOT NULL, NOTE VARCHAR(200) NOT NULL)`,
      );
      await job.execute(
        `LABEL ON TABLE ${schema}.${MARKER_TABLE} IS 'Uncle Bob verification kit - disposable'`,
      );
      await job.execute(
        `INSERT INTO ${schema}.${MARKER_TABLE} (RUN_ID, CREATED_AT, NOTE) VALUES (?, ${NOW_UTC}, ?)`,
        {
          parameters: [
            randomUUID(),
            'Disposable library created by npm run verify:ibmi; safe to drop.',
          ],
        },
      );
    }
    const hasVersion = state.tables.some((t) => str(t.TABLE_NAME) === VERSION_TABLE);
    if (!hasVersion) await job.execute(versionTableDdl(schema));
  } catch (e) {
    rec.add(G, 'apply.setup', `Prepare ${schema} for migrations`, 'FAIL', describeError(e));
    return false;
  }
  const applied = new Set(
    (
      await readAll<{ VERSION: unknown }>(job, `SELECT VERSION FROM ${schema}.${VERSION_TABLE}`)
    ).map((r) => Number(r.VERSION)),
  );
  for (const m of migrations) {
    if (applied.has(m.version)) {
      rec.add(G, `apply.${m.version}`, `${m.file} already applied`, 'PASS', undefined, m.version);
      continue;
    }
    let i = 0;
    try {
      for (; i < m.statements.length; i++) await job.execute(m.statements[i]);
      await job.execute(
        `INSERT INTO ${schema}.${VERSION_TABLE} (VERSION, FILE_NAME, APPLIED_AT) VALUES (?, ?, ${NOW_UTC})`,
        {
          parameters: [m.version, m.file],
        },
      );
      rec.add(
        G,
        `apply.${m.version}`,
        `Applied ${m.file} (${m.statements.length} statements)`,
        'PASS',
        undefined,
        m.version,
      );
    } catch (e) {
      rec.add(
        G,
        `apply.${m.version}`,
        `${m.file} failed at statement ${i + 1} of ${m.statements.length}`,
        'FAIL',
        `${describeError(e)}\n${(m.statements[i] ?? '').replace(/\s+/g, ' ').slice(0, 300)}\nLater migrations were not attempted. Fix the file, then rerun with --cleanup ${schema} and --apply-migrations.`,
        m.version,
      );
      return false;
    }
  }
  // Mirror scripts/migrate.ts: the metadata tables are never readable by *PUBLIC.
  const failures: string[] = [];
  for (const table of [...Object.values(T)]) {
    try {
      await job.execute(`REVOKE ALL ON ${schema}.${table} FROM PUBLIC`);
    } catch (e) {
      failures.push(`${table}: ${describeError(e)}`);
    }
  }
  rec.add(
    G,
    'apply.revoke',
    'Revoked *PUBLIC access to the metadata tables, as npm run migrate does',
    failures.length ? 'WARN' : 'PASS',
    failures.join('\n'),
  );
  return true;
}

async function catalogChecks(
  job: SqlJobLike,
  rec: Recorder,
  schema: string,
  expected: ExpectedSchema,
  migrations: MigrationFile[],
  state: Awaited<ReturnType<typeof libraryState>>,
): Promise<boolean> {
  const O = 'Schema objects';
  let allPresent = true;
  // Version bookkeeping
  try {
    const rows = await readAll<{ VERSION: unknown; FILE_NAME: unknown }>(
      job,
      `SELECT VERSION, FILE_NAME FROM ${schema}.${VERSION_TABLE} ORDER BY VERSION`,
    );
    const got = rows.map((r) => `${Number(r.VERSION)}:${str(r.FILE_NAME)}`);
    const want = migrations.map((m) => `${m.version}:${m.file}`);
    const missing = want.filter((w) => !got.includes(w));
    rec.add(
      O,
      'objects.versions',
      `${VERSION_TABLE} records migrations ${migrations[0]?.version ?? '?'}-${migrations.at(-1)?.version ?? '?'}`,
      missing.length ? 'FAIL' : 'PASS',
      missing.length ? `Not recorded: ${missing.join(', ')}` : `${rows.length} row(s)`,
    );
  } catch (e) {
    rec.add(O, 'objects.versions', `Read ${schema}.${VERSION_TABLE}`, 'FAIL', describeError(e));
    allPresent = false;
  }

  // One statement at a time on the job (no concurrent requests on a single Mapepire job).
  const catalogSql = [
    'SELECT TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ?',
    'SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE, TABLE_NAME, CONSTRAINT_STATE, ENABLED, CHECK_PENDING FROM QSYS2.SYSCST WHERE CONSTRAINT_SCHEMA = ?',
    'SELECT CONSTRAINT_NAME, DELETE_RULE FROM QSYS2.SYSREFCST WHERE CONSTRAINT_SCHEMA = ?',
    'SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM QSYS2.SYSCHKCST WHERE CONSTRAINT_SCHEMA = ?',
    'SELECT INDEX_NAME, TABLE_NAME, IS_UNIQUE FROM QSYS2.SYSINDEXES WHERE INDEX_SCHEMA = ?',
  ];
  const catalog: Row[][] = [];
  try {
    for (const sql of catalogSql) catalog.push(await readAll(job, sql, [schema]));
  } catch (e) {
    rec.add(
      O,
      'objects.catalog',
      'Read QSYS2.SYSCOLUMNS / SYSCST / SYSREFCST / SYSCHKCST / SYSINDEXES',
      'FAIL',
      describeError(e),
    );
    return false;
  }
  const [cols, csts, refs, checks, idx] = catalog;

  const tableBy = new Map(state.tables.map((t) => [str(t.TABLE_NAME), t]));
  const colSet = new Set(cols.map((c) => `${str(c.TABLE_NAME)}.${str(c.COLUMN_NAME)}`));
  const cstBy = new Map(csts.map((c) => [str(c.CONSTRAINT_NAME), c]));
  const refBy = new Map(refs.map((c) => [str(c.CONSTRAINT_NAME), c]));
  const chkBy = new Map(checks.map((c) => [str(c.CONSTRAINT_NAME), c]));
  const idxBy = new Map(idx.map((c) => [str(c.INDEX_NAME), c]));

  const problems = new Map<number, string[]>();
  const counts = new Map<number, number>();
  const note = (mig: number, p?: string) => {
    counts.set(mig, (counts.get(mig) ?? 0) + 1);
    if (p) problems.set(mig, [...(problems.get(mig) ?? []), p]);
  };
  for (const t of expected.tables) {
    const row = tableBy.get(t.name);
    if (!row) note(t.migration, `table ${t.name} is missing`);
    else if (str(row.TABLE_TYPE) !== 'T')
      note(t.migration, `${t.name} has TABLE_TYPE ${str(row.TABLE_TYPE)}, expected T (SQL table)`);
    else if (t.label !== undefined && str(row.TABLE_TEXT) !== t.label)
      note(t.migration, `${t.name} label is "${str(row.TABLE_TEXT)}", expected "${t.label}"`);
    else note(t.migration);
  }
  for (const c of expected.columns)
    note(
      c.migration,
      colSet.has(`${c.table}.${c.name}`) ? undefined : `column ${c.table}.${c.name} is missing`,
    );
  for (const c of expected.constraints) {
    const row = cstBy.get(c.name);
    if (!row) {
      note(c.migration, `constraint ${c.name} (${c.type}) on ${c.table} is missing`);
      continue;
    }
    const issues: string[] = [];
    if (str(row.CONSTRAINT_TYPE) !== c.type)
      issues.push(`type ${str(row.CONSTRAINT_TYPE)}, expected ${c.type}`);
    if (str(row.TABLE_NAME) !== c.table)
      issues.push(`on ${str(row.TABLE_NAME)}, expected ${c.table}`);
    if (str(row.CONSTRAINT_STATE) && str(row.CONSTRAINT_STATE) !== 'ESTABLISHED')
      issues.push(`state ${str(row.CONSTRAINT_STATE)}`);
    if (str(row.ENABLED) === 'NO') issues.push('disabled');
    if (str(row.CHECK_PENDING) === 'YES') issues.push('in check-pending state');
    if (c.type === 'FOREIGN KEY') {
      const rule = str(refBy.get(c.name)?.DELETE_RULE);
      if (rule !== c.deleteRule) issues.push(`ON DELETE ${rule || '?'}, expected ${c.deleteRule}`);
    }
    if (c.type === 'CHECK') {
      const clause = str(chkBy.get(c.name)?.CHECK_CLAUSE);
      const missing = (c.checkLiterals ?? []).filter((l) => !clause.includes(`'${l}'`));
      if (!clause) issues.push('no CHECK_CLAUSE in QSYS2.SYSCHKCST');
      else if (missing.length)
        issues.push(`check clause lacks ${missing.map((l) => `'${l}'`).join(', ')}: ${clause}`);
    }
    note(c.migration, issues.length ? `constraint ${c.name}: ${issues.join('; ')}` : undefined);
  }
  for (const i of expected.indexes) {
    const row = idxBy.get(i.name);
    if (!row) note(i.migration, `index ${i.name} on ${i.table} is missing`);
    else if (str(row.TABLE_NAME) !== i.table || str(row.IS_UNIQUE) !== i.unique)
      note(
        i.migration,
        `index ${i.name}: on ${str(row.TABLE_NAME)} IS_UNIQUE ${str(row.IS_UNIQUE)}, expected ${i.table} ${i.unique}`,
      );
    else note(i.migration);
  }
  for (const m of expected.migrations) {
    const p = problems.get(m.version) ?? [];
    if (p.some((x) => x.includes('missing'))) allPresent = false;
    const what = [
      m.tables.length && `${m.tables.length} table(s)`,
      m.columns.length && `${m.columns.length} added column(s)`,
      m.constraints.length && `${m.constraints.length} constraint(s)`,
      m.indexes.length && `${m.indexes.length} index(es)`,
    ]
      .filter(Boolean)
      .join(', ');
    rec.add(
      O,
      `objects.${m.version}`,
      `${m.file}: ${what || 'labels only'}`,
      p.length ? 'FAIL' : 'PASS',
      p.join('\n'),
      m.version,
    );
  }
  const known = new Set([...expected.tables.map((t) => t.name), VERSION_TABLE, MARKER_TABLE]);
  const extra = state.tables.map((t) => str(t.TABLE_NAME)).filter((n) => !known.has(n));
  if (extra.length || state.foreign.length)
    rec.add(
      O,
      'objects.extra',
      `Objects in ${schema} that no migration creates`,
      'WARN',
      [...extra, ...state.foreign.map((f) => str(f.TABLE_NAME))].join(', '),
    );
  try {
    const j = await readAll(
      job,
      `SELECT OBJNAME FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*JRN')) X`,
      [schema],
    );
    rec.add(
      O,
      'objects.journal',
      `Library ${schema} has a journal (needed for the app's commit-controlled transactions)`,
      j.length ? 'PASS' : 'FAIL',
      j.length
        ? j.map((r) => str(r.OBJNAME)).join(', ')
        : 'No *JRN object. Create the library with CREATE SCHEMA (not CRTLIB) so QSQJRN is created.',
    );
  } catch (e) {
    rec.add(O, 'objects.journal', 'Check for a journal in the library', 'WARN', describeError(e));
  }
  return allPresent;
}

async function separationCheck(
  cfg: AppConfig,
  factory: JobFactory,
  rec: Recorder,
  schema: string,
  reportUser: string,
) {
  let job: SqlJobLike | undefined;
  try {
    job = await openJob(cfg, cfg.reporting, reportingJdbcOptions(cfg), factory);
    const r = await readAll(
      job,
      'SELECT QSYS2.SQL_CHECK_AUTHORITY(?, ?) AS OK FROM SYSIBM.SYSDUMMY1',
      [schema, T.users],
    );
    const can = Number(r[0]?.OK ?? 0) === 1;
    rec.add(
      'Schema objects',
      'objects.separation',
      `Reporting profile ${reportUser} cannot read ${schema}.${T.users}`,
      can ? 'FAIL' : 'PASS',
      can
        ? 'The reporting profile can read the metadata tables. Revoke its authority (and *PUBLIC) to them.'
        : undefined,
    );
  } catch (e) {
    rec.add(
      'Schema objects',
      'objects.separation',
      'Check the reporting profile cannot read the metadata tables',
      'WARN',
      describeError(e),
    );
  } finally {
    await job?.close().catch(() => undefined);
  }
}

/** Run the app's own read queries (unchanged repository code) against the library. */
async function metadataQueries(job: SqlJobLike, rec: Recorder, schema: string) {
  const Q = 'Metadata queries';
  const db = readOnlyMetadataDb(job);
  const nobody = randomUUID();
  const groups = new GroupRepository(db, schema);
  const reports = new ReportRepository(db, schema);
  const folders = new FolderRepository(db, schema);
  const folderAccess = new FolderAccessService(db, schema, folders, groups);
  const access = new AccessService(db, schema, reports, groups);
  const schedules = new ScheduleRepository(db, schema);
  const steps: [string, () => Promise<unknown>][] = [
    [
      'Reports: list own, list shared, admin list',
      async () => {
        await reports.list(nobody, { sort: 'name' });
        await reports.listShared(nobody, ['verify-group']);
        await reports.listAdmin();
      },
    ],
    ['Report sharing audit (FETCH FIRST)', () => access.listAudit(nobody)],
    [
      'Share expiry checks (migration 014: EXPIRES_AT read, and compared with a bound TIMESTAMP)',
      async () => {
        const someone = { id: nobody, role: 'USER' as const };
        const report = { id: nobody, ownerId: randomUUID(), name: 'x' } as Report;
        await access.roleFor(someone, report);
        await access.listShares(nobody);
        await folderAccess.roleFor(someone, { id: nobody, ownerId: randomUUID() });
        await folderAccess.listShares(nobody);
        await new RecipientService(db, schema, new UserRepository(db, schema), access, {
          recipientDomains: [],
        }).options(report);
      },
    ],
    [
      'Folders and favorites',
      async () => {
        await folders.list(nobody);
        await folders.prefs(nobody);
      },
    ],
    [
      'Shared folders, folder report sharing and folder audit (OFFSET paging)',
      async () => {
        await folderAccess.listAccessible({ id: nobody, role: 'USER' });
        await folderAccess.reportSharingFor([nobody]);
        await folderAccess.auditPage(nobody, 25, 25);
      },
    ],
    [
      'Folder deletion audit and audit export (migration 013, keyset paging)',
      async () => {
        await folders.listDeletions(25, 25);
        await folders.findDeletion(nobody);
        await folderAccess.auditBatch(
          nobody,
          { occurredAt: '2026-01-01 00:00:00.000000', id: nobody },
          25,
        );
      },
    ],
    [
      'Share notifications (migration 015: reminders due, per-user settings)',
      async () => {
        const notifier = new ShareNotifier(db, schema, {
          notifications: {
            publicBaseUrl: 'https://verify.invalid',
            reminderDays: 3,
            reminderToRecipient: false,
            timezone: 'UTC',
          },
          scheduler: { recipientDomains: [] },
        });
        // a window in 1970: exercises the SQL (TIMESTAMP casts, NOT EXISTS) and matches no share
        const t = new Date(0);
        await notifier.pendingReminders('REPORT', t, new Date(1000));
        await notifier.pendingReminders('FOLDER', t, new Date(1000));
        await new UserSettingsRepository(db, schema).get(nobody);
      },
    ],
    [
      'In-app notifications (share audit, share end dates, failed deliveries; keyset paging)',
      async () => {
        // Works on 001-015 too: without migration 016 the read state is reported as unavailable.
        const inbox = new NotificationInbox(
          db,
          schema,
          { reports, access, folderAccess, groups },
          { soonDays: 3 },
        );
        const someone = { id: nobody, role: 'USER' as const };
        await inbox.count(someone);
        const page = await inbox.page(someone, { limit: 5 });
        await inbox.page(someone, {
          limit: 5,
          cursor: page.nextCursor ?? 'eyJ0IjoxNzAwMDAwMDAwMDAwLCJpIjoicnM6eCJ9',
        });
      },
    ],
    ['Dashboard tile order', () => new TileOrderRepository(db, schema).positions(nobody)],
    [
      'Schedules, due runs and delivery history',
      async () => {
        await schedules.listForUser(nobody, ['verify-group'], false, [nobody]);
        await schedules.due(new Date());
        await schedules.listDeliveries(nobody);
      },
    ],
    ['Execution history', () => new HistoryRepository(db, schema).list(nobody)],
    [
      'History retention: rows past each cutoff (COUNT only, nothing is deleted)',
      () =>
        new RetentionService(db, schema, {
          deliveryDays: 365,
          reminderDays: 180,
          executionDays: 30,
          auditDays: 365,
          batchSize: 1000,
          maxBatches: 1,
        }).countEligible(),
    ],
  ];
  for (const [title, fn] of steps) {
    try {
      await fn();
      rec.add(Q, `mq.${title}`, title, 'PASS');
    } catch (e) {
      rec.add(Q, `mq.${title}`, title, 'FAIL', describeError(e));
    }
  }
}

/** Write smoke test through the app's repositories, confined to the disposable library. */
async function smokeTest(
  cfg: AppConfig,
  factory: JobFactory,
  policy: WritePolicy,
  log: StatementLogEntry[],
  rec: Recorder,
  schema: string,
  metaUser: string,
) {
  const S = 'Smoke test (disposable library)';
  const db = new MapepireMetadataDb(cfg, confinedFactory(factory, policy, metaUser, log));
  const groups = new GroupRepository(db, schema);
  const users = new UserRepository(db, schema);
  const reports = new ReportRepository(db, schema);
  const folders = new FolderRepository(db, schema);
  const folderAccess = new FolderAccessService(db, schema, folders, groups);
  const pw = () => randomBytes(18).toString('base64url');
  const step = async <R>(
    title: string,
    fn: () => Promise<R>,
    check?: (r: R) => string | undefined,
  ): Promise<R | undefined> => {
    try {
      const r = await fn();
      const problem = check?.(r);
      rec.add(S, `smoke.${title}`, title, problem ? 'FAIL' : 'PASS', problem);
      return r;
    } catch (e) {
      rec.add(S, `smoke.${title}`, title, 'FAIL', describeError(e));
      return undefined;
    }
  };
  try {
    const owner = await step('Create two users (QF_USERS)', async () => {
      const a = await users.upsert({
        username: 'ubverify.owner',
        displayName: 'Verify Owner',
        password: pw(),
        role: 'USER',
      });
      const b = await users.upsert({
        username: 'ubverify.viewer',
        displayName: 'Verify Viewer',
        password: pw(),
        role: 'USER',
      });
      return { a, b };
    });
    if (!owner) return;
    const report = await step('Save a report (QF_REPORTS, CLOB columns)', () =>
      reports.create(
        owner.a.id,
        reportInputSchema.parse({
          name: 'Verification report',
          sql: 'SELECT 1 AS N FROM SYSIBM.SYSDUMMY1',
          parameters: [],
        }),
      ),
    );
    const folder = await step('Create a folder (QF_FOLDERS)', () =>
      folders.create(owner.a.id, 'Verification folder'),
    );
    if (!report || !folder) return;
    await step(
      'File the report in the folder (QF_REPORT_PREFS, commit-controlled transaction)',
      () => folders.setPref(owner.a.id, report.id, { folderId: folder.id }),
    );
    await step(
      'Share the folder and its reports (QF_FOLDER_SHARES, QF_FOLDER_REPORT_SHARING, audit with PRINCIPAL_TYPE REPORTS)',
      () =>
        folderAccess.replaceShares(
          { id: folder.id, ownerId: owner.a.id },
          owner.a.id,
          [{ type: 'USER', id: owner.b.id, role: 'VIEWER' }],
          async () => true,
          'VIEWER',
        ),
    );
    await step(
      'Read the folder audit back (migration 012 check constraint accepted REPORTS)',
      () => folderAccess.auditPage(folder.id, 25, 0),
      (p) =>
        p.events.some((e) => e.principalType === 'REPORTS')
          ? undefined
          : 'No REPORTS audit row was read back.',
    );
    await step(
      'Viewer sees the shared folder',
      () => folderAccess.listAccessible({ id: owner.b.id, role: 'USER' }),
      (f) =>
        f.some((x) => x.id === folder.id)
          ? undefined
          : 'The shared folder was not listed for the viewer.',
    );
    await step(
      'In-app notifications: the viewer is told, then marks all read (QF_USER_SETTINGS.NOTICES_READ_AT, migration 016)',
      async () => {
        await groups.sync(owner.b.id, 'LOCAL', ['ubverify-group']); // exercises the group IN list
        const inbox = new NotificationInbox(
          db,
          schema,
          {
            reports,
            access: new AccessService(db, schema, reports, groups),
            folderAccess,
            groups,
          },
          { soonDays: 3 },
        );
        const viewer = { id: owner.b.id, role: 'USER' as const };
        const before = await inbox.page(viewer, { limit: 10 });
        const told = before.items.some(
          (x) => x.kind === 'SHARED' && x.targetType === 'FOLDER' && x.target?.id === folder.id,
        );
        await inbox.markAllRead(viewer);
        const after = await inbox.count(viewer);
        const state = await inbox.readState(viewer.id);
        return { told, unread: after.unread, available: state.available, readAt: state.readAt };
      },
      (r) =>
        r.told && r.unread === 0 && r.available && r.readAt !== null
          ? undefined
          : `Listed the share: ${r.told}; unread after "Mark all read": ${r.unread}; read state stored: ${r.available && r.readAt !== null}.`,
    );
    // Share expiry (migration 014): set one an hour ahead, read the EXPIRY audit row back, and
    // check the share stops working at that instant (a later clock), without waiting for it.
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
    inAnHour.setUTCMilliseconds(0);
    await step(
      'Set an expiry on the folder share (QF_FOLDER_SHARES.EXPIRES_AT, migration 014)',
      () =>
        folderAccess.replaceShares(
          { id: folder.id, ownerId: owner.a.id },
          owner.a.id,
          [{ type: 'USER', id: owner.b.id, role: 'VIEWER', expiresAt: inAnHour.toISOString() }],
          async () => true,
        ),
      (shares) =>
        shares[0]?.expiresAt === inAnHour.toISOString() && !shares[0]?.expired
          ? undefined
          : `Read back ${JSON.stringify(shares)}; expected expiresAt ${inAnHour.toISOString()}, not expired.`,
    );
    await step(
      'Read the expiry change back from the audit (migration 014 check constraint accepted EXPIRY)',
      () => folderAccess.auditPage(folder.id, 25, 0),
      (p) =>
        p.events.some((e) => e.action === 'EXPIRY' && e.newExpiresAt === inAnHour.toISOString())
          ? undefined
          : 'No EXPIRY audit row with the new expiry was read back.',
    );
    await step(
      'The share works before its expiry and not at or after it (EXPIRES_AT compared as UTC)',
      async () => {
        const at = (t: number) =>
          new FolderAccessService(db, schema, folders, groups, () => new Date(t));
        const viewer = { id: owner.b.id, role: 'USER' as const };
        const f = { id: folder.id, ownerId: owner.a.id };
        return {
          before: await at(inAnHour.getTime() - 1000).roleFor(viewer, f),
          atExpiry: await at(inAnHour.getTime()).roleFor(viewer, f),
          listedAfter: (await at(inAnHour.getTime() + 1000).listAccessible(viewer)).some(
            (x) => x.id === folder.id,
          ),
        };
      },
      (r) =>
        r.before === 'VIEWER' && r.atExpiry === null && !r.listedAfter
          ? undefined
          : `Role a second before: ${r.before}; at expiry: ${r.atExpiry}; listed after: ${r.listedAfter}. Expected VIEWER, null, false.`,
    );
    // Share notifications (migration 015): the folder share above ends within the hour, so one
    // reminder is due. Two runs (two "instances") must claim it once: the unique key decides.
    // Mail goes to an in-memory mailer only; nothing is sent.
    await step(
      'Claim a share expiry reminder exactly once (QF_SHARE_REMINDERS unique key, migration 015)',
      async () => {
        const make = () =>
          new ShareNotifier(
            db,
            schema,
            { ...cfg, notifications: { ...cfg.notifications, reminderDays: 1 } },
            new MemoryMailer(),
          );
        const first = await make().runReminders(new Date(), 'ubverify-a');
        const second = await make().runReminders(new Date(), 'ubverify-b');
        const rows = await db.query<{ N: number }>(
          `SELECT COUNT(*) AS N FROM ${schema}.${T.shareReminders} WHERE TARGET_ID = ?`,
          [folder.id],
        );
        return { first, second, rows: Number(rows[0]?.N ?? 0) };
      },
      (r) =>
        r.first.sent + r.first.skipped === 1 &&
        r.second.sent + r.second.skipped + r.second.failed === 0 &&
        r.rows === 1
          ? undefined
          : `First run ${JSON.stringify(r.first)}, second run ${JSON.stringify(r.second)}, rows ${r.rows}; expected one reminder claimed once.`,
    );
    // History retention (no migration): the batched DELETE ... IN (SELECT ... FETCH FIRST n ROWS
    // ONLY) on a table that names itself in the subselect. Rows are seeded here, in the
    // disposable library only; QF_SHARE_REMINDERS has no foreign keys.
    await step(
      'Retention deletes old history in batches and keeps recent rows (QF_SHARE_REMINDERS)',
      async () => {
        const day = 24 * 60 * 60 * 1000;
        const ids: string[] = [];
        const seed = async (expiresMs: number) => {
          const id = randomUUID();
          ids.push(id);
          await db.update(
            `INSERT INTO ${schema}.${T.shareReminders} (REMINDER_ID, SHARE_KIND, TARGET_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, EXPIRES_AT, STATUS, ATTEMPTS, RECIPIENT_COUNT, CLAIMED_BY, CREATED_AT, UPDATED_AT)
             VALUES (?, 'REPORT', ?, 'USER', 'ubverify', CAST(? AS TIMESTAMP), 'SENT', 1, 1, 'ubverify', ${NOW_UTC}, ${NOW_UTC})`,
            [id, randomUUID(), toDbTimestamp(new Date(expiresMs))],
          );
        };
        const now = Date.now();
        for (let i = 0; i < 3; i++) await seed(now - (400 + i) * day);
        await seed(now + 2 * day); // a future end date: must survive
        const retention = new RetentionService(db, schema, {
          deliveryDays: 0,
          reminderDays: 7,
          executionDays: 0,
          auditDays: 0,
          batchSize: 2,
          maxBatches: 10,
        });
        const run = await retention.run({ now: new Date(now) });
        const left = await db.query<{ REMINDER_ID: string }>(
          `SELECT REMINDER_ID FROM ${schema}.${T.shareReminders} WHERE PRINCIPAL_ID = 'ubverify'`,
        );
        const t = run.tables.find((x) => x.key === 'reminders')!;
        return { t, left: left.map((r) => r.REMINDER_ID), future: ids[3] };
      },
      (r) =>
        r.t.error
          ? `DELETE failed: ${r.t.error}`
          : r.t.deleted === 3 && r.t.batches === 2 && r.left.length === 1 && r.left[0] === r.future
            ? undefined
            : `Deleted ${r.t.deleted} in ${r.t.batches} batch(es), ${r.left.length} left; expected 3 in 2 batches and only the future reminder left.`,
    );
    await step(
      'Save and change a per-user setting (QF_USER_SETTINGS, migration 015)',
      async () => {
        const settings = new UserSettingsRepository(db, schema);
        const off = await settings.set(owner.b.id, { shareEmails: false });
        const on = await settings.set(owner.b.id, { shareEmails: true });
        return { off: off.shareEmails, on: on.shareEmails };
      },
      (r) =>
        r.off === false && r.on === true
          ? undefined
          : `Read back ${JSON.stringify(r)}; expected off then on.`,
    );
    await step(
      'Check constraint rejects an unknown audit principal type',
      async () => {
        try {
          await db.update(
            `INSERT INTO ${schema}.${T.folderShareAudit} (AUDIT_ID, FOLDER_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, ACTOR_ID, OCCURRED_AT) VALUES (?, ?, 'GRANT', 'BOGUS', 'x', ?, ${NOW_UTC})`,
            [randomUUID(), folder.id, owner.a.id],
          );
          return 'accepted';
        } catch (e) {
          return describeError(e);
        }
      },
      (r) =>
        r === 'accepted'
          ? 'Db2 accepted PRINCIPAL_TYPE BOGUS.'
          : /23513|-545/.test(r)
            ? undefined
            : `Rejected, but not by the check constraint: ${r}`,
    );
    await step(
      'Metadata reads return more than 100 rows (Mapepire returns 100 per fetch)',
      async () => {
        const all = await readAllViaDb(cfg, factory, policy, metaUser, log, schema);
        const viaApp = await db.query(
          `SELECT TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ?`,
          [schema],
        );
        return { all, viaApp: viaApp.length };
      },
      (r) =>
        r.viaApp === r.all
          ? undefined
          : `MapepireMetadataDb.query returned ${r.viaApp} of ${r.all} rows. App lists longer than 100 rows would be cut short.`,
    );
    await step(
      'Delete the folder: shares and report sharing cascade, the report stays',
      async () => {
        await folders.remove(owner.a.id, folder.id);
        const left = await db.query<{ N: number }>(
          `SELECT COUNT(*) AS N FROM ${schema}.${T.folderReportSharing} WHERE FOLDER_ID = ?`,
          [folder.id],
        );
        const rpt = await reports.findById(report.id);
        return { left: Number(left[0]?.N ?? 0), report: !!rpt };
      },
      (r) =>
        r.left === 0 && r.report
          ? undefined
          : `QF_FOLDER_REPORT_SHARING rows left: ${r.left}; report kept: ${r.report}`,
    );
    await step(
      'The deletion is audited (QF_FOLDER_DELETIONS, migration 013)',
      () => folders.findDeletion(folder.id),
      (d) =>
        !d
          ? 'No QF_FOLDER_DELETIONS row was read back.'
          : d.shareCount !== 1 || d.reportsRole !== 'VIEWER'
            ? `Deletion row has SHARE_COUNT ${d.shareCount}, REPORTS_ROLE ${d.reportsRole}; expected 1, VIEWER.`
            : undefined,
    );
    await step(
      "The deleted folder's sharing history survives and exports one row per batch (keyset cursor bound back as a TIMESTAMP)",
      async () => {
        const seen: string[] = [];
        for await (const batch of folderAccess.auditAll(folder.id, 1))
          seen.push(...batch.map((e) => `${e.action}:${e.principalType}`));
        return seen;
      },
      (seen) =>
        seen.length === 5 &&
        seen.filter((x) => x.startsWith('REVOKE')).length === 2 &&
        seen.includes('EXPIRY:USER')
          ? undefined
          : `Read ${seen.length} audit rows (${seen.join(', ')}); expected 2 GRANT, 1 EXPIRY and 2 REVOKE.`,
    );
    await step('Delete the report', () => reports.delete(owner.a.id, report.id));
  } finally {
    await db.close();
  }
}

async function readAllViaDb(
  cfg: AppConfig,
  factory: JobFactory,
  policy: WritePolicy,
  metaUser: string,
  log: StatementLogEntry[],
  schema: string,
) {
  const job = await openJob(
    cfg,
    cfg.metadata,
    metadataJdbcOptions(cfg),
    confinedFactory(factory, policy, metaUser, log),
  );
  try {
    return (
      await readAll(
        job,
        'SELECT TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ?',
        [schema],
      )
    ).length;
  } finally {
    await job.close().catch(() => undefined);
  }
}

async function cleanup(job: SqlJobLike, rec: Recorder, schema: string) {
  const C = 'Cleanup';
  try {
    const state = await libraryState(job, schema);
    if (!state.exists) {
      rec.add(C, 'cleanup', `Library ${schema} does not exist; nothing to drop`, 'PASS');
      return;
    }
    if (!state.marked || state.foreign.length) {
      rec.add(
        C,
        'cleanup',
        `Refused to drop ${schema}`,
        'FAIL',
        !state.marked
          ? `It has no ${MARKER_TABLE} table, so this kit did not create it.`
          : `It holds objects the kit did not create: ${state.foreign.map((f) => str(f.TABLE_NAME)).join(', ')}`,
      );
      return;
    }
    // DROP SCHEMA ... CASCADE removes every object, so only proceed if the library holds nothing but
    // files (tables, indexes, catalog views) and the journal CREATE SCHEMA made.
    const others = (
      await readAll(
        job,
        `SELECT OBJNAME, OBJTYPE FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*ALL')) X`,
        [schema],
      )
    ).filter((r) => !['*FILE', '*JRN', '*JRNRCV'].includes(str(r.OBJTYPE)));
    if (others.length) {
      rec.add(
        C,
        'cleanup',
        `Refused to drop ${schema}`,
        'FAIL',
        `It holds objects the kit did not create: ${others.map((r) => `${str(r.OBJNAME)} (${str(r.OBJTYPE)})`).join(', ')}`,
      );
      return;
    }
    await job.execute(`DROP SCHEMA ${schema} CASCADE`);
    const after = await libraryState(job, schema);
    rec.add(
      C,
      'cleanup',
      `Dropped disposable library ${schema}`,
      after.exists ? 'FAIL' : 'PASS',
      after.exists ? 'The library still exists.' : undefined,
    );
  } catch (e) {
    rec.add(C, 'cleanup', `Drop disposable library ${schema}`, 'FAIL', describeError(e));
  }
}
