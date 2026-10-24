import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );
const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);
const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_#@$]{0,127}$/, 'must be an unquoted Db2 for i identifier');

/** Connection profile for one restricted IBM i identity. */
export interface DbIdentity {
  user: string;
  password: string;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(3001),
  HOST: z.string().default('127.0.0.1'),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  TRUST_PROXY: bool.default(false),

  // Mapepire daemon (websocket transport)
  MAPEPIRE_HOST: z.string().min(1),
  MAPEPIRE_PORT: int(8076),
  MAPEPIRE_REJECT_UNAUTHORIZED: bool.default(true),
  MAPEPIRE_CA_FILE: z.string().optional(),
  IBMI_DISPLAY_NAME: z.string().optional(),

  // Reporting identity: read-only authority to approved business objects
  REPORT_DB_USER: z.string().min(1),
  REPORT_DB_PASSWORD: z.string().min(1),
  REPORT_DEFAULT_SCHEMA: identifier.optional(),
  REPORT_LIBRARIES: z.string().optional(),
  REPORT_NAMING: z.enum(['sql', 'system']).default('sql'),

  // Metadata identity: CRUD on QueryForge metadata tables only
  META_DB_USER: z.string().min(1),
  META_DB_PASSWORD: z.string().min(1),
  META_SCHEMA: identifier.default('QFMETA'),
  META_POOL_SIZE: int(2),

  // Limits
  QUERY_TIMEOUT_MS: int(60000),
  CONNECT_TIMEOUT_MS: int(15000),
  MAX_RESULT_ROWS: int(5000),
  MAX_EXPORT_ROWS: int(100000),
  FETCH_BATCH_SIZE: int(500),
  MAX_CONCURRENT_EXECUTIONS: int(4),
  MAX_QUERY_LENGTH: int(32000),
  RATE_LIMIT_WINDOW_MS: int(60000),
  RATE_LIMIT_MAX: int(120),
  EXECUTE_RATE_LIMIT_MAX: int(30),
  LOGIN_RATE_LIMIT_MAX: int(10),

  // Sessions
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_MINUTES: int(480),
  COOKIE_SECURE: bool.optional(),

  // Additional protected schemas (comma-separated) user SQL may never reference
  PROTECTED_SCHEMAS: z.string().optional(),
  XLSX_FORMULA_ESCAPE: z.enum(['prefix', 'none']).default('prefix'),
});

export type Env = z.infer<typeof schema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  host: string;
  appOrigin: string;
  trustProxy: boolean;
  mapepire: {
    host: string;
    port: number;
    rejectUnauthorized: boolean;
    caFile?: string;
    displayName: string;
  };
  reporting: DbIdentity & { defaultSchema?: string; libraries: string[]; naming: 'sql' | 'system' };
  metadata: DbIdentity & { schema: string; poolSize: number };
  limits: {
    queryTimeoutMs: number;
    connectTimeoutMs: number;
    maxResultRows: number;
    maxExportRows: number;
    fetchBatchSize: number;
    maxConcurrentExecutions: number;
    maxQueryLength: number;
    rateLimitWindowMs: number;
    rateLimitMax: number;
    executeRateLimitMax: number;
    loginRateLimitMax: number;
  };
  session: { secret: string; ttlMinutes: number; cookieSecure: boolean };
  protectedSchemas: string[];
  xlsxFormulaEscape: 'prefix' | 'none';
}

const list = (s?: string) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (
    e.REPORT_DB_USER.toUpperCase() === e.META_DB_USER.toUpperCase() &&
    e.NODE_ENV === 'production'
  ) {
    throw new Error(
      'REPORT_DB_USER and META_DB_USER must be different IBM i profiles in production (least privilege).',
    );
  }
  const metaSchema = e.META_SCHEMA.toUpperCase();
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    appOrigin: e.APP_ORIGIN,
    trustProxy: e.TRUST_PROXY,
    mapepire: {
      host: e.MAPEPIRE_HOST,
      port: e.MAPEPIRE_PORT,
      rejectUnauthorized: e.MAPEPIRE_REJECT_UNAUTHORIZED,
      caFile: e.MAPEPIRE_CA_FILE,
      displayName: e.IBMI_DISPLAY_NAME ?? e.MAPEPIRE_HOST,
    },
    reporting: {
      user: e.REPORT_DB_USER,
      password: e.REPORT_DB_PASSWORD,
      defaultSchema: e.REPORT_DEFAULT_SCHEMA?.toUpperCase(),
      libraries: list(e.REPORT_LIBRARIES),
      naming: e.REPORT_NAMING,
    },
    metadata: {
      user: e.META_DB_USER,
      password: e.META_DB_PASSWORD,
      schema: metaSchema,
      poolSize: e.META_POOL_SIZE,
    },
    limits: {
      queryTimeoutMs: e.QUERY_TIMEOUT_MS,
      connectTimeoutMs: e.CONNECT_TIMEOUT_MS,
      maxResultRows: e.MAX_RESULT_ROWS,
      maxExportRows: Math.min(e.MAX_EXPORT_ROWS, 1_048_575),
      fetchBatchSize: e.FETCH_BATCH_SIZE,
      maxConcurrentExecutions: e.MAX_CONCURRENT_EXECUTIONS,
      maxQueryLength: e.MAX_QUERY_LENGTH,
      rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: e.RATE_LIMIT_MAX,
      executeRateLimitMax: e.EXECUTE_RATE_LIMIT_MAX,
      loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
    },
    session: {
      secret: e.SESSION_SECRET,
      ttlMinutes: e.SESSION_TTL_MINUTES,
      cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    },
    protectedSchemas: Array.from(new Set([metaSchema, ...list(e.PROTECTED_SCHEMAS)])),
    xlsxFormulaEscape: e.XLSX_FORMULA_ESCAPE,
  };
}
