/**
 * Command-line and environment handling for the IBM i verification kit, plus the safety guard that
 * decides whether it may connect at all. Nothing here opens a connection.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';

export interface Identity {
  user: string;
  password: string;
}

export interface VerifyOptions {
  /** Value of QF_VERIFY_TARGET; must be exactly "nonprod". */
  target?: string;
  confirmNonprod: boolean;
  host?: string;
  port: number;
  rejectUnauthorized: boolean;
  caFile?: string;
  /** The app's read-only reporting profile (REPORT_DB_USER in the app). */
  report?: Partial<Identity>;
  /** Profile that owns the disposable metadata library (only needed for schema checks and writes). */
  meta?: Partial<Identity>;
  /** Disposable metadata library, e.g. UBVERIFY. */
  schema?: string;
  /** Application data libraries the reporting profile must only be able to read. */
  dataLibraries: string[];
  /** Hosts that are production; the kit refuses to connect to any of them. */
  productionHosts: string[];
  applyMigrations: boolean;
  /** Library name repeated after --cleanup; must equal `schema`. */
  cleanup?: string;
  allowQfmeta: boolean;
  adoptEmptyLibrary: boolean;
  smoke: boolean;
  dryRun: boolean;
  jsonPath: string;
  nodeEnv?: string;
  help: boolean;
}

export const USAGE = `Uncle Bob IBM i verification kit (non-production systems only)

  npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod [options]

Required: QF_VERIFY_TARGET=nonprod in the environment or config file, and --confirm-nonprod.
By default every statement is a read (SELECT / VALUES); nothing is created or changed.

Options:
  --config <file>          KEY=VALUE file with QF_VERIFY_* settings (environment wins)
  --confirm-nonprod        confirm the target is a non-production IBM i
  --apply-migrations       create QF_VERIFY_SCHEMA (a new, disposable library) and apply
                           migrations 001-012 into it, then run a small write smoke test there
  --no-smoke               with --apply-migrations, skip the write smoke test
  --adopt-empty-library    use an existing QF_VERIFY_SCHEMA that has no tables (e.g. a DBA created it)
  --allow-qfmeta           allow QF_VERIFY_SCHEMA=QFMETA (never on a shared system)
  --cleanup <LIBRARY>      drop the disposable library afterwards; repeat its name to confirm
  --dry-run                check settings and print the plan; connect to nothing
  --json <file>            where to write the JSON report (default ibmi-verification-report.json)
  --help                   show this help
`;

const NAME_RE = /^[A-Z][A-Z0-9_#@$]{0,9}$/;
/** IBM-supplied and Db2 catalog libraries the kit never writes to. */
const SYSTEM_LIBRARIES = new Set([
  'QSYS',
  'QSYS2',
  'QGPL',
  'QTEMP',
  'QUSRSYS',
  'QRECOVERY',
  'QSPL',
  'QIWS',
  'SYSIBM',
  'SYSIBMADM',
  'SYSTOOLS',
  'SYSPROC',
  'SYSCAT',
  'SYSFUN',
  'SYSSTAT',
]);

const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const truthy = (v?: string, def = true) =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/** Read a KEY=VALUE config file, keeping only QF_VERIFY_* keys (and NODE_ENV). */
export function readConfigFile(path: string): Record<string, string> {
  const parsed = dotenv.parse(readFileSync(path, 'utf8'));
  return Object.fromEntries(
    Object.entries(parsed).filter(([k]) => k.startsWith('QF_VERIFY_') || k === 'NODE_ENV'),
  );
}

/**
 * Parse argv and environment. `baseDir` resolves relative paths (npm sets INIT_CWD to the
 * directory the operator ran npm from).
 */
export function parseOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
  baseDir: string = env.INIT_CWD ?? process.cwd(),
  readFile: (p: string) => Record<string, string> = readConfigFile,
): VerifyOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      config: { type: 'string' },
      'confirm-nonprod': { type: 'boolean', default: false },
      'apply-migrations': { type: 'boolean', default: false },
      'no-smoke': { type: 'boolean', default: false },
      'adopt-empty-library': { type: 'boolean', default: false },
      'allow-qfmeta': { type: 'boolean', default: false },
      cleanup: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  const at = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const file = values.config ? readFile(at(values.config)) : {};
  const e: Record<string, string | undefined> = { ...file };
  for (const [k, v] of Object.entries(env))
    if ((k.startsWith('QF_VERIFY_') || k === 'NODE_ENV') && v !== undefined) e[k] = v;
  const ident = (u?: string, p?: string) => (u || p ? { user: u, password: p } : undefined);
  const upper = (s?: string) => (s ? s.trim().toUpperCase() : undefined);
  return {
    target: e.QF_VERIFY_TARGET?.trim(),
    confirmNonprod: values['confirm-nonprod'] === true,
    host: e.QF_VERIFY_HOST?.trim() || undefined,
    port: Number(e.QF_VERIFY_PORT || 8076),
    rejectUnauthorized: truthy(e.QF_VERIFY_REJECT_UNAUTHORIZED, true),
    caFile: e.QF_VERIFY_CA_FILE ? at(e.QF_VERIFY_CA_FILE) : undefined,
    report: ident(e.QF_VERIFY_REPORT_USER?.trim(), e.QF_VERIFY_REPORT_PASSWORD),
    meta: ident(e.QF_VERIFY_META_USER?.trim(), e.QF_VERIFY_META_PASSWORD),
    schema: upper(e.QF_VERIFY_SCHEMA),
    dataLibraries: list(e.QF_VERIFY_DATA_LIBRARIES).map((s) => s.toUpperCase()),
    productionHosts: list(e.QF_VERIFY_PRODUCTION_HOSTS).map((s) => s.toLowerCase()),
    applyMigrations: values['apply-migrations'] === true,
    cleanup: upper(values.cleanup),
    allowQfmeta: values['allow-qfmeta'] === true,
    adoptEmptyLibrary: values['adopt-empty-library'] === true,
    smoke: values['no-smoke'] !== true,
    dryRun: values['dry-run'] === true,
    jsonPath: at(values.json ?? 'ibmi-verification-report.json'),
    nodeEnv: e.NODE_ENV,
    help: values.help === true,
  };
}

export interface GuardResult {
  ok: boolean;
  /** Reasons the kit refuses to run. Any entry means nothing connects. */
  errors: string[];
  warnings: string[];
  /** True when the run may only read (no --apply-migrations and no --cleanup). */
  readOnly: boolean;
}

/** Decide whether the kit may run at all. Pure: no I/O. */
export function evaluateGuard(o: VerifyOptions): GuardResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (o.target !== 'nonprod')
    errors.push(
      'Refusing to run: set QF_VERIFY_TARGET=nonprod to state that the target IBM i is not production.',
    );
  if (!o.confirmNonprod)
    errors.push('Refusing to run: pass --confirm-nonprod to confirm the target is not production.');
  if (o.nodeEnv === 'production') errors.push('Refusing to run with NODE_ENV=production.');
  if (!o.host) errors.push('QF_VERIFY_HOST is required (the Mapepire server host name).');
  else if (o.productionHosts.includes(o.host.toLowerCase()))
    errors.push(`Refusing to run: ${o.host} is listed in QF_VERIFY_PRODUCTION_HOSTS.`);
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)
    errors.push('QF_VERIFY_PORT must be a port number.');
  if (!o.report?.user || !o.report.password)
    errors.push(
      'QF_VERIFY_REPORT_USER and QF_VERIFY_REPORT_PASSWORD are required (the read-only reporting profile).',
    );
  if (o.meta && (!o.meta.user || !o.meta.password))
    errors.push('Set both QF_VERIFY_META_USER and QF_VERIFY_META_PASSWORD, or neither.');
  if (!o.rejectUnauthorized)
    warnings.push(
      'QF_VERIFY_REJECT_UNAUTHORIZED=false: the TLS certificate is not checked. Prefer QF_VERIFY_CA_FILE.',
    );

  for (const lib of o.dataLibraries)
    if (!NAME_RE.test(lib))
      errors.push(`QF_VERIFY_DATA_LIBRARIES: "${lib}" is not a library name.`);
  if (!o.dataLibraries.length)
    warnings.push(
      'QF_VERIFY_DATA_LIBRARIES is empty, so the read-only authority checks on data libraries are skipped.',
    );

  const writes = o.applyMigrations || o.cleanup !== undefined;
  if (o.schema !== undefined) {
    const s = o.schema;
    if (!NAME_RE.test(s))
      errors.push(
        `QF_VERIFY_SCHEMA "${s}" must be a system library name: a letter, then up to 9 letters, digits or _.`,
      );
    else if (s === 'QFMETA') {
      if (!o.allowQfmeta)
        errors.push(
          'QF_VERIFY_SCHEMA=QFMETA needs --allow-qfmeta. Use a disposable library such as UBVERIFY instead; never QFMETA on a shared system.',
        );
    } else if (SYSTEM_LIBRARIES.has(s) || s.startsWith('Q') || s.startsWith('SYS'))
      errors.push(
        `QF_VERIFY_SCHEMA "${s}" looks like an IBM-supplied library (Q* or SYS*). Choose a new disposable name such as UBVERIFY.`,
      );
    if (o.dataLibraries.includes(s))
      errors.push(
        `QF_VERIFY_SCHEMA "${s}" is also listed as a data library; it must be disposable.`,
      );
  }
  if (writes) {
    if (!o.schema)
      errors.push('--apply-migrations and --cleanup need QF_VERIFY_SCHEMA (a disposable library).');
    if (!o.meta?.user || !o.meta.password)
      errors.push(
        '--apply-migrations and --cleanup need QF_VERIFY_META_USER and QF_VERIFY_META_PASSWORD.',
      );
  }
  if (o.cleanup !== undefined && o.cleanup !== o.schema)
    errors.push(
      `--cleanup ${o.cleanup || '(empty)'} does not match QF_VERIFY_SCHEMA ${o.schema ?? '(unset)'}; repeat the disposable library name to confirm.`,
    );
  if (o.adoptEmptyLibrary && !o.applyMigrations)
    warnings.push('--adopt-empty-library only matters with --apply-migrations.');
  if (o.meta?.user && o.report?.user && o.meta.user.toUpperCase() === o.report.user.toUpperCase())
    warnings.push(
      'The metadata and reporting profiles are the same; the app expects two different profiles.',
    );
  if (!o.schema && !writes)
    warnings.push('QF_VERIFY_SCHEMA is not set, so metadata catalog checks are skipped.');
  return { ok: errors.length === 0, errors, warnings, readOnly: !writes };
}
