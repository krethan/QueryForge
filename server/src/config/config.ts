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

  // Metadata identity: CRUD on Uncle Bob metadata tables only
  META_DB_USER: z.string().min(1),
  META_DB_PASSWORD: z.string().min(1),
  META_SCHEMA: identifier.default('QFMETA'),
  META_POOL_SIZE: int(2),

  // Limits
  QUERY_TIMEOUT_MS: int(60000),
  CONNECT_TIMEOUT_MS: int(15000),
  MAX_RESULT_ROWS: int(50000),
  RESULT_PAGE_SIZE: int(500),
  CURSOR_IDLE_TTL_MS: int(120000),
  CURSOR_MAX_LIFETIME_MS: int(600000),
  MAX_OPEN_CURSORS: int(8),
  MAX_OPEN_CURSORS_PER_USER: int(2),
  MAX_EXPORT_ROWS: int(100000),
  FETCH_BATCH_SIZE: int(500),
  MAX_CONCURRENT_EXECUTIONS: int(4),
  MAX_QUERY_LENGTH: int(32000),
  /** How long QSYS2 catalog (SYSTABLES / SYSCOLUMNS) results stay cached for the Report Builder. */
  CATALOG_CACHE_TTL_MS: int(60000, 0),
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

  // Sign-in methods
  AUTH_LOCAL_ENABLED: bool.default(true),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_USERNAME_CLAIM: z.string().default('preferred_username'),
  OIDC_LABEL: z.string().default('Single sign-on'),
  LDAP_URL: z.string().optional(),
  LDAP_STARTTLS: bool.default(false),
  LDAP_REJECT_UNAUTHORIZED: bool.default(true),
  LDAP_CA_FILE: z.string().optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_SEARCH_BASE: z.string().optional(),
  LDAP_USER_FILTER: z.string().default('(sAMAccountName={{username}})'),
  LDAP_GROUP_ATTRIBUTE: z.string().default('memberOf'),
  LDAP_LABEL: z.string().default('Directory (LDAP / AD)'),
  LDAP_TIMEOUT_MS: int(10000),
  /** IdP or directory group -> application group, e.g. "QF-Finance=finance;CN=Sales,OU=Groups,DC=corp=sales" */
  GROUP_MAP: z.string().optional(),
  /** Application groups whose members get the ADMIN role on sign-in. */
  ADMIN_GROUPS: z.string().optional(),

  // Scheduled runs and email
  SCHEDULER_ENABLED: bool.default(false),
  SCHEDULER_POLL_MS: int(30000, 1000),
  SCHEDULER_LEASE_MS: int(120000, 5000),
  SCHEDULE_MAX_FAILURES: int(3),
  SCHEDULE_MIN_INTERVAL_MINUTES: int(15),
  SCHEDULE_MAX_RECIPIENTS: int(20),
  SCHEDULE_RECIPIENT_DOMAINS: z.string().optional(),
  SCHEDULE_DEFAULT_TIMEZONE: z.string().default('UTC'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_REJECT_UNAUTHORIZED: bool.default(true),
  SMTP_CA_FILE: z.string().optional(),
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
    /** Rows per interactive page fetched through a server-side cursor. */
    resultPageSize: number;
    cursorIdleTtlMs: number;
    cursorMaxLifetimeMs: number;
    maxOpenCursors: number;
    maxOpenCursorsPerUser: number;
    maxExportRows: number;
    fetchBatchSize: number;
    maxConcurrentExecutions: number;
    maxQueryLength: number;
    /** Report Builder catalog cache TTL (ms); 0 disables caching. */
    catalogCacheTtlMs: number;
    rateLimitWindowMs: number;
    rateLimitMax: number;
    executeRateLimitMax: number;
    loginRateLimitMax: number;
  };
  session: { secret: string; ttlMinutes: number; cookieSecure: boolean };
  protectedSchemas: string[];
  xlsxFormulaEscape: 'prefix' | 'none';
  auth: {
    localEnabled: boolean;
    oidc?: {
      issuer: string;
      clientId: string;
      clientSecret?: string;
      redirectUri: string;
      scopes: string;
      groupsClaim: string;
      usernameClaim: string;
      label: string;
    };
    ldap?: {
      url: string;
      startTls: boolean;
      rejectUnauthorized: boolean;
      caFile?: string;
      bindDn?: string;
      bindPassword?: string;
      searchBase: string;
      userFilter: string;
      groupAttribute: string;
      label: string;
      timeoutMs: number;
    };
    /** lower-cased external group -> application group */
    groupMap: Map<string, string>;
    adminGroups: string[];
  };
  scheduler: {
    enabled: boolean;
    pollMs: number;
    leaseMs: number;
    maxFailures: number;
    minIntervalMinutes: number;
    maxRecipients: number;
    recipientDomains: string[];
    defaultTimezone: string;
  };
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
    rejectUnauthorized: boolean;
    caFile?: string;
  };
}

/** Parse "external=app;external2=app2". Keys compare case-insensitively. */
export function parseGroupMap(s?: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (s ?? '').split(';')) {
    const i = part.lastIndexOf('=');
    if (i <= 0) continue;
    const ext = part.slice(0, i).trim();
    const app = part
      .slice(i + 1)
      .trim()
      .toLowerCase();
    if (!ext || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(app))
      throw new Error(
        `Invalid configuration: GROUP_MAP entry "${part}" (app group must match [a-z0-9._-])`,
      );
    m.set(ext.toLowerCase(), app);
  }
  return m;
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
  const prod = e.NODE_ENV === 'production';
  const oidcVars = [e.OIDC_ISSUER_URL, e.OIDC_CLIENT_ID, e.OIDC_REDIRECT_URI];
  if (oidcVars.some(Boolean) && !oidcVars.every(Boolean))
    throw new Error(
      'Invalid configuration: OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_REDIRECT_URI must be set together.',
    );
  if (prod && e.OIDC_ISSUER_URL && !e.OIDC_ISSUER_URL.startsWith('https://'))
    throw new Error('Invalid configuration: OIDC_ISSUER_URL must use https in production.');
  if (e.LDAP_URL) {
    if (!/^ldaps?:\/\//.test(e.LDAP_URL))
      throw new Error('Invalid configuration: LDAP_URL must start with ldap:// or ldaps://');
    if (!e.LDAP_SEARCH_BASE)
      throw new Error('Invalid configuration: LDAP_SEARCH_BASE is required with LDAP_URL.');
    if (!e.LDAP_USER_FILTER.includes('{{username}}'))
      throw new Error('Invalid configuration: LDAP_USER_FILTER must contain {{username}}.');
    if (prod && e.LDAP_URL.startsWith('ldap://') && !e.LDAP_STARTTLS)
      throw new Error('Invalid configuration: use ldaps:// or LDAP_STARTTLS=true in production.');
  }
  if (!e.AUTH_LOCAL_ENABLED && !e.OIDC_ISSUER_URL && !e.LDAP_URL)
    throw new Error(
      'Invalid configuration: AUTH_LOCAL_ENABLED=false requires OIDC or LDAP to be configured.',
    );
  if (e.SMTP_HOST && !e.SMTP_FROM)
    throw new Error('Invalid configuration: SMTP_FROM is required with SMTP_HOST.');
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
      resultPageSize: Math.min(e.RESULT_PAGE_SIZE, e.MAX_RESULT_ROWS),
      cursorIdleTtlMs: e.CURSOR_IDLE_TTL_MS,
      cursorMaxLifetimeMs: Math.max(e.CURSOR_MAX_LIFETIME_MS, e.CURSOR_IDLE_TTL_MS),
      maxOpenCursors: e.MAX_OPEN_CURSORS,
      maxOpenCursorsPerUser: Math.min(e.MAX_OPEN_CURSORS_PER_USER, e.MAX_OPEN_CURSORS),
      maxExportRows: Math.min(e.MAX_EXPORT_ROWS, 1_048_575),
      fetchBatchSize: e.FETCH_BATCH_SIZE,
      maxConcurrentExecutions: e.MAX_CONCURRENT_EXECUTIONS,
      maxQueryLength: e.MAX_QUERY_LENGTH,
      catalogCacheTtlMs: e.CATALOG_CACHE_TTL_MS,
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
    auth: {
      localEnabled: e.AUTH_LOCAL_ENABLED,
      oidc: e.OIDC_ISSUER_URL
        ? {
            issuer: e.OIDC_ISSUER_URL,
            clientId: e.OIDC_CLIENT_ID!,
            clientSecret: e.OIDC_CLIENT_SECRET || undefined,
            redirectUri: e.OIDC_REDIRECT_URI!,
            scopes: e.OIDC_SCOPES,
            groupsClaim: e.OIDC_GROUPS_CLAIM,
            usernameClaim: e.OIDC_USERNAME_CLAIM,
            label: e.OIDC_LABEL,
          }
        : undefined,
      ldap: e.LDAP_URL
        ? {
            url: e.LDAP_URL,
            startTls: e.LDAP_STARTTLS,
            rejectUnauthorized: e.LDAP_REJECT_UNAUTHORIZED,
            caFile: e.LDAP_CA_FILE,
            bindDn: e.LDAP_BIND_DN,
            bindPassword: e.LDAP_BIND_PASSWORD,
            searchBase: e.LDAP_SEARCH_BASE!,
            userFilter: e.LDAP_USER_FILTER,
            groupAttribute: e.LDAP_GROUP_ATTRIBUTE,
            label: e.LDAP_LABEL,
            timeoutMs: e.LDAP_TIMEOUT_MS,
          }
        : undefined,
      groupMap: parseGroupMap(e.GROUP_MAP),
      adminGroups: (e.ADMIN_GROUPS ?? '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    },
    scheduler: {
      enabled: e.SCHEDULER_ENABLED,
      pollMs: e.SCHEDULER_POLL_MS,
      leaseMs: e.SCHEDULER_LEASE_MS,
      maxFailures: e.SCHEDULE_MAX_FAILURES,
      minIntervalMinutes: e.SCHEDULE_MIN_INTERVAL_MINUTES,
      maxRecipients: e.SCHEDULE_MAX_RECIPIENTS,
      recipientDomains: (e.SCHEDULE_RECIPIENT_DOMAINS ?? '')
        .split(',')
        .map((x) => x.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
      defaultTimezone: e.SCHEDULE_DEFAULT_TIMEZONE,
    },
    smtp: e.SMTP_HOST
      ? {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: e.SMTP_SECURE,
          user: e.SMTP_USER || undefined,
          password: e.SMTP_PASSWORD || undefined,
          from: e.SMTP_FROM!,
          rejectUnauthorized: e.SMTP_REJECT_UNAUTHORIZED,
          caFile: e.SMTP_CA_FILE,
        }
      : undefined,
  };
}
