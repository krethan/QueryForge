import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { SignJWT, jwtVerify } from 'jose';
import { z, ZodError } from 'zod';
import type { AppConfig } from '../config/config.js';
import type { SessionService } from '../auth/session.js';
import type { AppUser, ExternalIdentity, UserRepository } from '../auth/users.js';
import type { OidcChecks, OidcProvider } from '../auth/oidc.js';
import type { LdapAuthenticator } from '../auth/ldap.js';
import { checkRecipients, type Mailer } from '../mail/mailer.js';
import {
  parameterListSchema,
  parameterValuesSchema,
  resolveParameters,
  type ParameterDef,
  type RawValues,
} from '../reports/parameters.js';
import {
  AGGREGATE_FNS,
  FILTER_OPS,
  HAVING_OPS,
  MAX_AGGREGATES,
  MAX_FILTERS,
  MAX_HAVING,
  MAX_IN_VALUES,
  MAX_VALUE_LENGTH,
} from '../catalog/filter-builder.js';
import { datePresetSchema } from '../reports/date-presets.js';
import { validateCron } from '../scheduler/cron.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import {
  normaliseScheduleBody,
  scheduleBodySchema,
  type ScheduleInput,
  type ScheduleRepository,
} from '../scheduler/schedules.js';
import {
  cadenceSchema,
  cadenceToCron,
  cronToCadence,
  describeCadence,
} from '../scheduler/cadence.js';
import type { RecipientService } from '../scheduler/recipients.js';
import { sharesInputSchema, type AccessService, type ShareChange } from '../sharing/access.js';
import type { ShareNotifier } from '../notifications/share-notifier.js';
import type { UserSettingsRepository } from '../notifications/settings.js';
import { RetentionRunningError, type RetentionService } from '../retention/retention.js';
import { mapExternalGroups, type GroupRepository } from '../sharing/groups.js';
import type { AccessibleReport, Report } from '../reports/reports.js';
import {
  formattingSchema,
  matchFormatting,
  matchPivotFormatting,
  pivotExportFormatting,
} from '../reports/formatting.js';
import {
  folderDeletionsQuerySchema,
  folderInputSchema,
  type FolderRepository,
} from '../reports/folders.js';
import { csvFileName, streamCsv } from '../export/csv.js';
import {
  folderAddInputSchema,
  folderAuditQuerySchema,
  folderOrderInputSchema,
  mergeVisibleOrder,
  type FolderAccessService,
  type FolderMember,
  type FolderShareAuditEvent,
} from '../sharing/folder-access.js';
import {
  folderSharesInputSchema,
  folderSkipReason,
  type FolderReportGrants,
  type FolderReportSkipReason,
} from '../sharing/folder-report-grants.js';
import {
  applyTileOrder,
  tileOrderInputSchema,
  type TileOrderRepository,
} from '../reports/tile-order.js';
import type { HistoryRepository } from '../history/history.js';
import {
  reportInputSchema,
  reportUpdateSchema,
  type ReportRepository,
  type SortKey,
} from '../reports/reports.js';
import type { ExecutionService } from '../sql/execution-service.js';
import { MAX_TABLES, displayType, type CatalogService } from '../catalog/catalog.js';
import { buildReportSql, suggestReportName, type ReportSpec } from '../catalog/sql-builder.js';
import {
  JOIN_TYPES,
  MAX_JOINS,
  buildJoinedReportSql,
  suggestJoinConditions,
  suggestJoinedReportName,
  type JoinedReportSpec,
  type OutputColumn,
  type ResolvedSource,
  validateCalculation,
  type CalculatedFieldSpec,
} from '../catalog/join-builder.js';
import { MAX_CALCULATED, MAX_EXPRESSION_LENGTH, TYPE_HINT } from '../catalog/calc-expr.js';
import {
  availableColumns,
  defaultDetailColumns,
  deriveDetailSpec,
  drillDefSchema,
  drillLabel,
  groupFields,
  mapTargetValues,
  MAX_DETAIL_COLUMNS,
  type DrillDef,
  type GroupField,
} from '../reports/drill.js';
import type { QueryExecutor } from '../sql/executor.js';
import type { MetadataDb } from '../db/types.js';
import { AppError, DbError, sanitizeErrorMessage } from '../util/errors.js';
import { chartDefSchema } from '../charts/chart-def.js';
import {
  MAX_PIVOT_GROUPS,
  MAX_PIVOT_ROW_FIELDS,
  PIVOT_FNS,
  PIVOT_FN_LABELS,
  expandPivot,
  pivotRows,
  pivotTable,
  type PivotSpec,
} from '../reports/pivot.js';

export interface ApiDeps {
  cfg: AppConfig;
  sessions: SessionService;
  users: UserRepository;
  reports: ReportRepository;
  history: HistoryRepository;
  execution: ExecutionService;
  executor: QueryExecutor;
  catalog: CatalogService;
  metadataDb: MetadataDb;
  access: AccessService;
  groups: GroupRepository;
  schedules: ScheduleRepository;
  folders: FolderRepository;
  folderAccess: FolderAccessService;
  folderGrants: FolderReportGrants;
  tileOrder: TileOrderRepository;
  scheduler: Scheduler;
  recipients: RecipientService;
  mailer?: Mailer;
  notifier: ShareNotifier;
  userSettings: UserSettingsRepository;
  retention: RetentionService;
  oidc?: OidcProvider;
  ldap?: LdapAuthenticator;
}

export const OIDC_COOKIE = 'qf_oidc';
const OIDC_COOKIE_PATH = '/api/auth/oidc';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const uuid = z.string().uuid();
const executeSchema = z.object({
  sql: z.string(),
  executionId: uuid.optional(),
  parameters: parameterListSchema.optional(),
  values: parameterValuesSchema.optional(),
});
/**
 * Report Builder input: object/column names and sort directions only. The server
 * resolves every name against the cached QSYS2 catalog and builds the SELECT itself
 * (see catalog/sql-builder.ts), so no SQL text is ever accepted from the client.
 */
const name128 = z.string().min(1).max(128);
const alias = z.string().min(1).max(10);
const columnRef = z.object({ table: alias.optional(), column: name128 });
const scalar = z.union([z.string().max(MAX_VALUE_LENGTH), z.number()]);
const filterSchema = z.object({
  table: alias.optional(),
  column: name128,
  op: z.enum(FILTER_OPS),
  value: scalar.nullable().optional(),
  value2: scalar.nullable().optional(),
  // a little over the limit so the builder can report it with a clear message
  values: z
    .array(scalar)
    .max(MAX_IN_VALUES + 1)
    .optional(),
  preset: datePresetSchema.nullable().optional(),
  ask: z
    .object({
      name: z.string().max(30),
      label: z.string().max(80),
      defaultValue: scalar.nullable().optional(),
      defaultValue2: scalar.nullable().optional(),
    })
    .nullable()
    .optional(),
});
const filterGroupSchema = z.object({
  logic: z.enum(['AND', 'OR']),
  filters: z.array(filterSchema).min(1).max(MAX_FILTERS),
});
const calculatedSchema = z.object({
  id: z.string().min(1).max(30),
  name: z.string().min(1).max(64),
  // a little over the limit so the parser can report it with a clear message
  expression: z.string().max(MAX_EXPRESSION_LENGTH + 1),
  type: z.enum(['integer', 'decimal', 'char', 'date', 'timestamp']).optional(),
});
const reportSpecBase = z.object({
  schema: name128,
  table: name128,
  /** Correlation name of the base table (generated as T1 when omitted). */
  alias: alias.optional(),
  joins: z
    .array(
      z.object({
        schema: name128,
        table: name128,
        alias: alias.optional(),
        type: z.enum(JOIN_TYPES),
        on: z
          .array(
            z.object({
              left: z.object({ table: alias, column: name128 }),
              right: z.object({ column: name128 }),
            }),
          )
          .max(16),
      }),
    )
    .max(MAX_JOINS)
    .optional(),
  columns: z
    .array(z.union([name128, z.object({ table: alias.optional(), column: name128 })]))
    .max(400),
  sort: z
    .array(
      z.object({
        table: alias.optional(),
        column: name128.optional(),
        aggregate: z.string().min(1).max(64).optional(),
        direction: z.enum(['ASC', 'DESC']),
      }),
    )
    .max(50)
    .optional(),
  filters: z
    .array(z.union([filterSchema, filterGroupSchema]))
    .max(MAX_FILTERS)
    .optional(),
  filterLogic: z.enum(['AND', 'OR']).optional(),
  groupBy: z.array(columnRef).max(100).optional(),
  aggregates: z
    .array(
      z.object({
        fn: z.enum(AGGREGATE_FNS),
        table: alias.optional(),
        column: name128.nullable().optional(),
        name: z.string().max(64).optional(),
      }),
    )
    .max(MAX_AGGREGATES)
    .optional(),
  having: z
    .array(
      z.object({
        aggregate: z.string().min(1).max(64),
        op: z.enum(HAVING_OPS),
        value: scalar.nullable(),
        value2: scalar.nullable().optional(),
      }),
    )
    .max(MAX_HAVING)
    .optional(),
  /** Calculated fields (expression text is parsed and checked server-side, never run as SQL). */
  calculated: z.array(calculatedSchema).max(MAX_CALCULATED).optional(),
  /** Pivot / crosstab layout; the server builds the GROUP BY and reshapes the rows. */
  pivot: z
    .object({
      rows: z.array(columnRef).min(1).max(MAX_PIVOT_ROW_FIELDS),
      column: columnRef,
      value: z.object({
        fn: z.enum(PIVOT_FNS),
        table: alias.optional(),
        column: name128.nullable().optional(),
      }),
    })
    .optional(),
});
const needsOutput = (
  s: { columns: unknown[]; aggregates?: unknown[]; pivot?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (s.columns.length === 0 && !s.aggregates?.length && !s.pivot)
    ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Choose at least one column.' });
};
const reportSpecSchema = reportSpecBase.superRefine(needsOutput);
const builderQuerySchema = reportSpecBase
  .extend({
    executionId: uuid.optional(),
    /** Values for "Ask when run" filters (fixed filter values are never taken from here). */
    values: parameterValuesSchema.optional(),
  })
  .superRefine(needsOutput);
const calcValidateSchema = z.object({
  schema: name128,
  table: name128,
  alias: alias.optional(),
  joins: z
    .array(z.object({ schema: name128, table: name128, alias: alias.optional() }))
    .max(MAX_JOINS)
    .optional(),
  expression: z.string().max(MAX_EXPRESSION_LENGTH + 1),
});
const joinSuggestSchema = z.object({
  tables: z
    .array(z.object({ alias, schema: name128, table: name128 }))
    .min(1)
    .max(MAX_JOINS + 1),
  schema: name128,
  table: name128,
});

type BuilderInput = z.infer<typeof reportSpecSchema>;

/** Single-table selections without aliases, filters or totals keep the original, unqualified SQL. */
const isSimple = (spec: BuilderInput) =>
  !spec.pivot &&
  !spec.calculated?.length &&
  !spec.joins?.length &&
  !spec.alias &&
  !spec.filters?.length &&
  !spec.groupBy?.length &&
  !spec.aggregates?.length &&
  !spec.having?.length &&
  spec.columns.length > 0 &&
  (spec.sort ?? []).every((s) => s.column !== undefined && s.aggregate === undefined) &&
  spec.columns.every((c) => typeof c === 'string') &&
  (spec.sort ?? []).every((s) => s.table === undefined);

/** Shared by preview and run: resolve every table, validate every name, build the SELECT. */
async function buildQuery(d: ApiDeps, ownerId: string, spec: BuilderInput) {
  if (isSimple(spec)) {
    const simple = spec as ReportSpec;
    const resolved = await d.catalog.resolveTable(ownerId, spec.schema, spec.table);
    const sql = buildReportSql(simple, resolved.table, resolved.columns);
    d.executor.validate(sql); // defence in depth: the built statement must pass the validator
    return {
      sql,
      name: suggestReportName(simple),
      table: resolved.table,
      warnings: [] as string[],
      parameters: [] as ParameterDef[],
      aliases: undefined as string[] | undefined,
      columns: undefined as OutputColumn[] | undefined,
      sources: [resolved] as ResolvedSource[],
      calculated: [] as CalculatedFieldSpec[],
      effective: spec as JoinedReportSpec,
    };
  }
  const joins = spec.joins ?? [];
  const sources = [];
  for (const t of [{ schema: spec.schema, table: spec.table }, ...joins])
    sources.push(await d.catalog.resolveTable(ownerId, t.schema, t.table));
  // a pivot runs as an ordinary grouped query; drill-down works on that expanded spec
  const joined = expandPivot(spec as JoinedReportSpec & { pivot?: PivotSpec });
  const built = buildJoinedReportSql(joined, sources);
  d.executor.validate(built.sql);
  return {
    sql: built.sql,
    name: suggestJoinedReportName(joined, built.columns),
    table: sources[0].table,
    warnings: built.warnings,
    aliases: built.aliases,
    parameters: built.parameters,
    columns: built.columns as OutputColumn[] | undefined,
    sources: sources as ResolvedSource[],
    calculated: built.calculated,
    effective: joined,
  };
}

/**
 * Versioned Report Builder definition stored in QF_REPORTS.BUILDER_DEF (a JSON column,
 * so new versions need no database migration).
 *  - v1: the original shape; it cannot carry calculated fields.
 *  - v2: adds `spec.calculated` ({ id, name, expression, type }). Written only when a
 *    report has calculated fields, so reports without them keep saving as v1.
 *  - v3: adds `spec.pivot` ({ rows, column, value }). Written only for pivot reports;
 *    v1 and v2 definitions load unchanged.
 */
export const BUILDER_DEF_VERSION = 3;
const builderDefSchema = z.union([
  z.object({
    version: z.literal(1),
    spec: reportSpecSchema
      .refine((s) => !s.calculated?.length, {
        message: 'Version 1 definitions cannot contain calculated fields; use version 2.',
        path: ['calculated'],
      })
      .refine((s) => !s.pivot, {
        message: 'Only version 3 definitions can contain a pivot.',
        path: ['pivot'],
      }),
  }),
  z.object({
    version: z.literal(2),
    spec: reportSpecSchema.refine((s) => !s.pivot, {
      message: 'Only version 3 definitions can contain a pivot.',
      path: ['pivot'],
    }),
  }),
  z.object({ version: z.literal(3), spec: reportSpecSchema }),
]);
export type BuilderDef = z.infer<typeof builderDefSchema>;

/**
 * Validate a stored or submitted builder definition: shape, version, and every name
 * against the catalog. Returns the regenerated SQL and parameters; the returned
 * definition carries the server-inferred type of every calculated field.
 */
async function rebuildFromDef(d: ApiDeps, ownerId: string, raw: unknown) {
  const parsed = builderDefSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      400,
      'INVALID_BUILDER_DEF',
      `The Report Builder definition is not valid: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`)
        .join('; ')}`,
    );
  const built = await buildQuery(d, ownerId, parsed.data.spec);
  const spec = built.calculated.length
    ? { ...parsed.data.spec, calculated: built.calculated }
    : parsed.data.spec;
  const def: BuilderDef = spec.pivot
    ? { version: 3, spec }
    : built.calculated.length
      ? { version: 2, spec }
      : parsed.data;
  return { def, ...built };
}

/** Chart settings in a request body: validated strictly; null clears / disables. */
const chartInput = z
  .unknown()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null) return v as null | undefined;
    const p = chartDefSchema.safeParse(v);
    if (p.success) return p.data;
    ctx.addIssue({
      code: 'custom',
      message: `Invalid chart settings: ${p.error.issues.map((i) => `${i.path.join('.') || 'chart'}: ${i.message}`).join('; ')}`,
    });
    return z.NEVER;
  });

const exportSchema = z.object({
  chart: chartInput,
  sql: z.string().optional(),
  reportId: uuid.optional(),
  name: z.string().max(128).optional(),
  parameters: parameterListSchema.optional(),
  values: parameterValuesSchema.optional(),
});

type XlsxFile = Awaited<ReturnType<ExecutionService['exportXlsx']>>;
async function sendXlsx(res: Response, file: XlsxFile) {
  res.setHeader('X-QF-Row-Count', String(file.rowCount));
  res.setHeader(
    'X-QF-Chart',
    file.chart ? 'included' : file.chartNote ? encodeURIComponent(file.chartNote) : 'none',
  );
  res.setHeader('X-QF-Truncated', String(file.truncated));
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-QF-Row-Count, X-QF-Truncated, X-QF-Chart, Content-Disposition',
  );
  res.setHeader('Cache-Control', 'no-store');
  await new Promise<void>((resolve, reject) =>
    res.download(
      file.path,
      file.filename,
      {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      },
      (e) => (e ? reject(e) : resolve()),
    ),
  ).finally(() => file.cleanup());
}

/** Columns of a folder audit CSV export, in order. */
export const FOLDER_AUDIT_CSV_HEADER = [
  'Occurred at (UTC)',
  'Action',
  'Principal type',
  'Principal ID',
  'Principal name',
  'Role before',
  'Role after',
  'Expiry before (UTC)',
  'Expiry after (UTC)',
  'Changed by (user ID)',
  'Changed by',
  'Folder ID',
  'Folder name',
  'Event ID',
] as const;
const folderAuditCsvCells = (folderName: string) => (e: FolderShareAuditEvent) => [
  e.occurredAt,
  e.action,
  e.principalType,
  e.principalId,
  e.principalName ?? '',
  e.oldRole ?? '',
  e.newRole ?? '',
  e.oldExpiresAt ?? '',
  e.newExpiresAt ?? '',
  e.actorId,
  e.actorName ?? '',
  e.folderId,
  folderName,
  e.id,
];
const folderAuditCsvName = (folderName: string, deleted: boolean) => {
  const label = `${folderName} audit${deleted ? ' - deleted' : ''}`;
  return {
    filename: csvFileName(label, 'folder-audit'),
    utf8Filename: `${label.replace(/[\\/]+/g, '_')}.csv`,
    header: FOLDER_AUDIT_CSV_HEADER,
  };
};

export function apiRouter(d: ApiDeps): Router {
  const r = Router();
  const { cfg, sessions } = d;
  const oidcKey = new TextEncoder().encode(`${cfg.session.secret}:oidc`);
  const limiter = (max: number) =>
    rateLimit({
      windowMs: cfg.limits.rateLimitWindowMs,
      limit: max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => req.session?.user.id ?? req.ip ?? 'unknown',
      handler: (_req, _res, next) =>
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.')),
    });

  r.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // ---- authentication ----
  r.post(
    '/auth/login',
    limiter(cfg.limits.loginRateLimitMax),
    h(async (req, res) => {
      sessions.checkOrigin(req);
      const body = z
        .object({
          username: z.string().min(1).max(128),
          password: z.string().min(1).max(1024),
          method: z.enum(['local', 'ldap']).default('local'),
        })
        .parse(req.body);
      let user: AppUser;
      if (body.method === 'ldap') {
        if (!d.ldap) throw new AppError(400, 'LDAP_DISABLED', 'Directory sign-in is not enabled.');
        const identity = await d.ldap.authenticate(body.username, body.password);
        if (!identity)
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
        user = await externalSignIn(identity);
      } else {
        if (!cfg.auth.localEnabled)
          throw new AppError(
            403,
            'LOCAL_DISABLED',
            'Local sign-in is disabled. Use single sign-on.',
          );
        const found = await d.users.verifyCredentials(body.username, body.password);
        if (!found)
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
        user = found;
      }
      const s = await sessions.issue(res, user);
      res.json({ user, expiresAt: new Date(s.expiresAt).toISOString() });
    }),
  );

  r.get('/auth/providers', (_req, res) => {
    res.json({
      local: cfg.auth.localEnabled,
      oidc: d.oidc ? { label: d.oidc.label, startUrl: '/api/auth/oidc/start' } : null,
      ldap: d.ldap ? { label: d.ldap.label } : null,
    });
  });

  // ---- OpenID Connect (authorization code + PKCE) ----
  r.get(
    '/auth/oidc/start',
    limiter(cfg.limits.loginRateLimitMax),
    h(async (_req, res) => {
      if (!d.oidc) throw new AppError(404, 'NOT_FOUND', 'Single sign-on is not enabled.');
      const { url, checks } = await d.oidc.start();
      const token = await new SignJWT({ ...checks })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('qf-oidc')
        .setIssuer('queryforge')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(oidcKey);
      res.cookie(OIDC_COOKIE, token, {
        httpOnly: true,
        secure: cfg.session.cookieSecure,
        sameSite: 'lax', // must survive the top-level redirect back from the IdP
        path: OIDC_COOKIE_PATH,
        maxAge: 10 * 60_000,
      });
      res.redirect(302, url);
    }),
  );
  r.get(
    '/auth/oidc/callback',
    limiter(cfg.limits.loginRateLimitMax),
    h(async (req, res) => {
      const fail = (code: string) =>
        res.redirect(302, `/login?sso_error=${encodeURIComponent(code)}`);
      if (!d.oidc) return fail('SSO_DISABLED');
      const raw = req.cookies?.[OIDC_COOKIE];
      res.clearCookie(OIDC_COOKIE, {
        path: OIDC_COOKIE_PATH,
        sameSite: 'lax',
        secure: cfg.session.cookieSecure,
        httpOnly: true,
      });
      if (typeof raw !== 'string') return fail('SSO_STATE_MISSING');
      let checks: OidcChecks;
      try {
        const { payload } = await jwtVerify(raw, oidcKey, {
          audience: 'qf-oidc',
          issuer: 'queryforge',
        });
        checks = {
          state: String(payload.state),
          nonce: String(payload.nonce),
          codeVerifier: String(payload.codeVerifier),
        };
      } catch {
        return fail('SSO_STATE_INVALID');
      }
      try {
        // Rebuild the callback URL from configuration, never from the Host header.
        const cb = new URL(cfg.auth.oidc?.redirectUri ?? 'http://localhost/api/auth/oidc/callback');
        cb.search = new URL(req.originalUrl, 'http://placeholder').search;
        const identity = await d.oidc.finish(cb, checks);
        const user = await externalSignIn(identity);
        await sessions.issue(res, user);
        res.redirect(302, '/');
      } catch (e) {
        console.warn('OIDC sign-in failed:', sanitizeErrorMessage(e));
        return fail(e instanceof AppError ? e.code : 'SSO_FAILED');
      }
    }),
  );

  async function externalSignIn(identity: ExternalIdentity): Promise<AppUser> {
    const appGroups = mapExternalGroups(identity.groups, cfg.auth.groupMap);
    const role = appGroups.some((g) => cfg.auth.adminGroups.includes(g)) ? 'ADMIN' : 'USER';
    const user = await d.users.upsertExternal(identity, role);
    await d.groups.sync(user.id, identity.source, appGroups);
    return user;
  }

  const auth = sessions.requireAuth();
  r.use(auth);
  r.use(limiter(cfg.limits.rateLimitMax));

  r.post('/auth/logout', (_req, res) => {
    sessions.clear(res);
    res.status(204).end();
  });

  r.get(
    '/auth/me',
    h(async (req, res) => {
      const s = req.session!;
      // Sliding renewal: re-check the account is active and refresh once past half of the TTL.
      const half = (s.expiresAt - s.issuedAt) / 2;
      let expiresAt = s.expiresAt;
      if (Date.now() - s.issuedAt > half) {
        const fresh = await d.users.findById(s.user.id);
        if (!fresh) {
          sessions.clear(res);
          throw new AppError(401, 'UNAUTHENTICATED', 'Your account is no longer active.');
        }
        expiresAt = (await sessions.issue(res, fresh)).expiresAt;
      }
      res.json({
        user: s.user,
        groups: await d.groups.forUser(s.user.id),
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }),
  );

  // ---- data source / health ----
  r.get(
    '/datasource',
    h(async (req, res) => {
      const check = async (fn: () => Promise<unknown>) => {
        const t0 = Date.now();
        try {
          await fn();
          return { ok: true, ms: Date.now() - t0 };
        } catch (e) {
          return { ok: false, ms: Date.now() - t0, error: sanitizeErrorMessage(e) };
        }
      };
      const live = req.query.check === '1';
      res.json({
        name: cfg.mapepire.displayName,
        host: cfg.mapepire.host,
        port: cfg.mapepire.port,
        tlsVerification: cfg.mapepire.rejectUnauthorized,
        customCa: Boolean(cfg.mapepire.caFile),
        reportingUser: cfg.reporting.user.toUpperCase(),
        defaultSchema: cfg.reporting.defaultSchema ?? null,
        libraries: cfg.reporting.libraries,
        naming: cfg.reporting.naming,
        metadataSchema: cfg.metadata.schema,
        limits: {
          queryTimeoutMs: cfg.limits.queryTimeoutMs,
          maxResultRows: cfg.limits.maxResultRows,
          maxExportRows: cfg.limits.maxExportRows,
          maxConcurrentExecutions: cfg.limits.maxConcurrentExecutions,
          maxQueryLength: cfg.limits.maxQueryLength,
        },
        activeExecutions: d.executor.activeExecutions,
        checks: live
          ? {
              metadata: await check(() => d.metadataDb.ping()),
              reporting: await check(() =>
                d.executor.run('VALUES 1', req.session!.user.id, { maxRows: 1 }),
              ),
            }
          : undefined,
      });
    }),
  );

  // ---- ad-hoc queries ----
  const execLimiter = limiter(cfg.limits.executeRateLimitMax);
  r.post(
    '/query/validate',
    h(async (req, res) => {
      const { sql } = z.object({ sql: z.string() }).parse(req.body);
      d.executor.validate(sql);
      res.json({ ok: true });
    }),
  );
  r.post(
    '/query/execute',
    execLimiter,
    h(async (req, res) => {
      const body = executeSchema.parse(req.body);
      res.json(
        await d.execution.runAdhoc(req.session!.user, body.sql, body.executionId ?? randomUUID(), {
          definitions: body.parameters,
          values: body.values,
        }),
      );
    }),
  );
  r.post(
    '/query/:executionId/cancel',
    h(async (req, res) => {
      const ok = d.execution.cancel(req.session!.user, uuid.parse(req.params.executionId));
      res.status(ok ? 202 : 404).json({ cancelled: ok });
    }),
  );

  // ---- Report Builder: catalog browsing + server-built SELECT (read-only) ----
  r.get(
    '/schema/tables',
    h(async (req, res) => {
      const search =
        typeof req.query.search === 'string' ? req.query.search.slice(0, 128) : undefined;
      const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      const result = await d.catalog.listTables(req.session!.user.id, { search, limit });
      res.json({
        tables: result.tables.map((t) => ({
          schema: t.schema,
          name: t.name,
          type: t.type,
          typeLabel: t.typeLabel,
          text: t.text,
        })),
        truncated: result.truncated,
        cachedAt: result.cachedAt,
        maxTables: MAX_TABLES,
      });
    }),
  );
  r.get(
    '/schema/tables/:schema/:table/columns',
    h(async (req, res) => {
      const schema = String(req.params.schema ?? '').slice(0, 128);
      const table = String(req.params.table ?? '').slice(0, 128);
      const resolved = await d.catalog.resolveTable(req.session!.user.id, schema, table);
      res.json({
        schema: resolved.table.schema,
        table: resolved.table.name,
        type: resolved.table.type,
        text: resolved.table.text,
        cachedAt: resolved.cachedAt,
        columns: resolved.columns.map((c) => ({
          name: c.name,
          type: c.type,
          displayType: displayType(c),
          length: c.length,
          precision: c.precision,
          scale: c.scale,
          nullable: c.nullable,
          text: c.text,
          ordinal: c.ordinal,
        })),
      });
    }),
  );
  // Preview: validates the selection and returns the exact SELECT that Run would execute.
  r.post(
    '/schema/sql',
    h(async (req, res) => {
      const spec = reportSpecSchema.parse(req.body);
      const built = await buildQuery(d, req.session!.user.id, spec);
      res.json({
        sql: built.sql,
        name: built.name,
        schema: built.table.schema,
        table: built.table.name,
        // Joined, filtered or grouped reports also report aliases and any warnings.
        ...(built.aliases
          ? { warnings: built.warnings, aliases: built.aliases, parameters: built.parameters }
          : {}),
        ...(built.calculated.length ? { calculated: built.calculated } : {}),
      });
    }),
  );
  // Calculated-field editor: parse and type-check one expression against the report's
  // tables. Expression problems are an ordinary answer (ok: false), not an HTTP error.
  r.post(
    '/schema/calc/validate',
    h(async (req, res) => {
      const body = calcValidateSchema.parse(req.body);
      const owner = req.session!.user.id;
      const sources = [];
      for (const t of [{ schema: body.schema, table: body.table }, ...(body.joins ?? [])])
        sources.push(await d.catalog.resolveTable(owner, t.schema, t.table));
      try {
        const v = validateCalculation(body, sources, body.expression);
        res.json({
          ok: true,
          type: v.type,
          hint: TYPE_HINT[v.type],
          sql: v.sql,
          columns: v.columns,
        });
      } catch (e) {
        if (e instanceof AppError && e.code === 'INVALID_CALCULATION') {
          const position = typeof e.details?.position === 'number' ? e.details.position : null;
          res.json({
            ok: false,
            error: { message: e.message.replace(/^Calculated field "Check": /, ''), position },
          });
          return;
        }
        throw e;
      }
    }),
  );
  // Join suggestions: catalog foreign keys first, then same-name, same-type columns.
  r.post(
    '/schema/join-suggestions',
    h(async (req, res) => {
      const body = joinSuggestSchema.parse(req.body);
      const owner = req.session!.user.id;
      const existing = [];
      for (const t of body.tables)
        existing.push({
          alias: t.alias,
          source: await d.catalog.resolveTable(owner, t.schema, t.table),
        });
      const target = await d.catalog.resolveTable(owner, body.schema, body.table);
      const fks = await d.catalog.listForeignKeys(owner, target.table.schema, target.table.name);
      res.json({ suggestions: suggestJoinConditions(existing, target, fks) });
    }),
  );
  // Run: builds the SELECT server-side and executes it through the normal read-only path.
  r.post(
    '/schema/run',
    execLimiter,
    h(async (req, res) => {
      const body = builderQuerySchema.parse(req.body);
      const built = await buildQuery(d, req.session!.user.id, body);
      const out = await d.execution.runAdhoc(
        req.session!.user,
        built.sql,
        body.executionId ?? randomUUID(),
        { definitions: built.parameters, values: body.values ?? {} },
      );
      res.json({ ...out, builder: { name: built.name, sql: built.sql } });
    }),
  );

  // ---- pivot / crosstab: grouped SQL built here, reshaped here (no dynamic column SQL) ----
  type Built = Awaited<ReturnType<typeof buildQuery>>;
  const pivotOf = (spec: { pivot?: PivotSpec }) => {
    if (!spec.pivot) throw new AppError(400, 'NOT_PIVOT', 'This report is not a pivot.');
    return spec.pivot;
  };
  const pivotValueLabel = (p: PivotSpec, calculated: CalculatedFieldSpec[]) => {
    const fn = PIVOT_FN_LABELS[p.value.fn];
    if (!p.value.column) return `${fn} of rows`;
    const calc =
      p.value.table === '@CALC' ? calculated.find((c) => c.id === p.value.column) : undefined;
    return `${fn} of ${calc?.name ?? p.value.column}`;
  };
  async function runPivot(
    u: AppUser,
    built: Built,
    p: PivotSpec,
    src: {
      values?: Record<string, unknown>;
      executionId?: string;
      report?: Report;
      kind?: 'RUN' | 'EXPORT';
    },
  ) {
    const max = Math.min(MAX_PIVOT_GROUPS, cfg.limits.maxResultRows);
    const out = await d.execution.runGrouped(
      u,
      {
        sql: built.sql,
        definitions: built.parameters,
        values: (src.values ?? {}) as RawValues,
        executionId: src.executionId,
        reportId: src.report?.id,
        reportOwnerId: src.report?.ownerId,
        kind: src.kind,
      },
      max,
    );
    if (out.truncated)
      throw new AppError(
        400,
        'PIVOT_TOO_LARGE',
        `This pivot has more than ${max.toLocaleString('en-US')} row and column combinations. Add a filter or use fewer row fields.`,
        { limit: max },
      );
    const pivot = pivotRows(
      out.columns,
      out.rows,
      p.rows.length,
      p.value.fn,
      pivotValueLabel(p, built.calculated),
    );
    return { out, pivot };
  }
  const pivotReports = new WeakMap<object, Report>();
  const pivotJson = (built: Built, run: Awaited<ReturnType<typeof runPivot>>) => ({
    pivot: run.pivot,
    executionId: run.out.executionId,
    completedAt: run.out.completedAt,
    durationMs: run.out.durationMs,
    parameters: run.out.parameters,
    dataSource: run.out.dataSource,
    builder: { name: built.name, sql: built.sql },
    warnings: built.warnings,
    ...(pivotReports.get(run.pivot)
      ? {
          formatting: pivotReports.get(run.pivot)!.formatting,
          formatStyles: matchPivotFormatting(pivotReports.get(run.pivot)!.formatting, run.pivot),
        }
      : {}),
  });
  async function savedPivot(u: AppUser, id: string) {
    const { report } = await d.access.require(u, id, 'VIEW');
    if (report.builderDef === null)
      throw new AppError(400, 'NOT_PIVOT', 'This report is not a pivot.');
    const rebuilt = await rebuildFromDef(d, u.id, report.builderDef);
    return { report, built: rebuilt as Built, pivot: pivotOf(rebuilt.def.spec) };
  }
  const pivotRunBody = z.object({
    executionId: uuid.optional(),
    values: parameterValuesSchema.optional(),
  });
  async function sendPivotXlsx(
    res: Response,
    u: AppUser,
    built: Built,
    run: Awaited<ReturnType<typeof runPivot>>,
    title: string,
    description?: string | null,
  ) {
    const table = pivotTable(run.pivot);
    const report = pivotReports.get(run.pivot);
    const excelFormatting = report ? pivotExportFormatting(report.formatting, run.pivot) : null;
    // The flattened pivot uses row-field names and a single PIVOT_VALUE name.
    table.columns = table.columns.map((c, i) => ({
      ...c,
      name: i < run.pivot.rowFields.length ? run.pivot.rowFields[i].name : 'PIVOT_VALUE',
    }));
    const file = await d.execution.writeTableXlsx(u, table, {
      title,
      description,
      sql: built.sql,
      executedAt: run.out.completedAt,
      definitions: built.parameters,
      parameters: run.out.parameters,
      formatting: excelFormatting,
      note: `Pivot: ${run.pivot.value.label} by ${run.pivot.rowFields.map((f) => f.label).join(', ')} and ${run.pivot.columnField.label} (values only)`,
    });
    await sendXlsx(res, file);
  }
  r.post(
    '/schema/pivot',
    execLimiter,
    h(async (req, res) => {
      const body = builderQuerySchema.parse(req.body);
      const p = pivotOf(body);
      const built = await buildQuery(d, user(req).id, body);
      const run = await runPivot(user(req), built, p, body);
      res.json(pivotJson(built, run));
    }),
  );
  r.post(
    '/schema/pivot/export',
    execLimiter,
    h(async (req, res) => {
      const body = builderQuerySchema
        .and(z.object({ name: z.string().max(128).optional() }))
        .parse(req.body);
      const p = pivotOf(body);
      const built = await buildQuery(d, user(req).id, body);
      const run = await runPivot(user(req), built, p, { ...body, kind: 'EXPORT' });
      await sendPivotXlsx(res, user(req), built, run, body.name?.trim() || built.name);
    }),
  );
  r.post(
    '/reports/:id/pivot',
    execLimiter,
    h(async (req, res) => {
      const body = pivotRunBody.parse(req.body ?? {});
      const s = await savedPivot(user(req), reportId(req));
      const run = await runPivot(user(req), s.built, s.pivot, { ...body, report: s.report });
      pivotReports.set(run.pivot, s.report);
      res.json({ ...pivotJson(s.built, run), report: { id: s.report.id, name: s.report.name } });
    }),
  );
  r.post(
    '/reports/:id/pivot/export',
    execLimiter,
    h(async (req, res) => {
      const body = pivotRunBody.parse(req.body ?? {});
      const s = await savedPivot(user(req), reportId(req));
      const run = await runPivot(user(req), s.built, s.pivot, {
        ...body,
        report: s.report,
        kind: 'EXPORT',
      });
      pivotReports.set(run.pivot, s.report);
      await sendPivotXlsx(res, user(req), s.built, run, s.report.name, s.report.description);
    }),
  );

  // ---- server-side result paging (cursor owned by the caller, short TTL) ----
  r.post(
    '/results/:cursorId/next',
    limiter(cfg.limits.rateLimitMax),
    h(async (req, res) => {
      res.json(await d.execution.fetchPage(req.session!.user, uuid.parse(req.params.cursorId)));
    }),
  );
  r.delete(
    '/results/:cursorId',
    h(async (req, res) => {
      const ok = await d.execution.closeCursor(req.session!.user, uuid.parse(req.params.cursorId));
      res.status(ok ? 204 : 404).end();
    }),
  );

  r.post(
    '/export',
    execLimiter,
    h(async (req, res) => {
      const body = exportSchema.parse(req.body);
      if (!body.sql && !body.reportId)
        throw new AppError(400, 'BAD_REQUEST', 'Provide sql or reportId.');
      const file = await d.execution.exportXlsx(req.session!.user, {
        ...body,
        definitions: body.parameters,
      });
      await sendXlsx(res, file);
    }),
  );

  // ---- saved reports (owner, or shared VIEWER / EDITOR; enforced by AccessService) ----
  const user = (req: Request) => req.session!.user;
  const reportId = (req: Request) => uuid.parse(req.params.id);
  const checkLength = (sql: string) => {
    if (sql.length > cfg.limits.maxQueryLength)
      throw new AppError(400, 'SQL_TOO_LONG', 'Query is too long.');
  };

  /**
   * Every report the user can see on the dashboard: their own, plus reports shared with them
   * (directly, through a group, or through a folder its owner shared with its reports), or
   * every other report for a global ADMIN. This is the same owner/share filtering
   * AccessService applies to a single report.
   */
  /** Reports shared with a (non-admin) user: direct and group shares, plus folder grants (011). */
  const sharedWith = async (userId: string): Promise<AccessibleReport[]> => {
    const groups = await d.groups.forUser(userId);
    const [direct, viaFolders] = await Promise.all([
      d.reports.listShared(userId, groups),
      d.folderGrants.reportRolesFor(userId, groups),
    ]);
    if (!viaFolders.size) return direct;
    const out = direct.map((x) => {
      const f = viaFolders.get(x.id);
      viaFolders.delete(x.id);
      // the stronger access wins; a direct share is never weakened by a folder
      return f === 'EDITOR' && x.access === 'VIEWER'
        ? { ...x, access: 'EDITOR' as const, viaFolder: true }
        : x;
    });
    const extra = (await d.reports.listByIds([...viaFolders.keys()]))
      .filter((x) => x.ownerId !== userId)
      .map((x) => ({ ...x, access: viaFolders.get(x.id)!, viaFolder: true }));
    if (!extra.length) return out;
    return [...out, ...extra].sort(
      (a, b) =>
        a.name.toUpperCase().localeCompare(b.name.toUpperCase()) || a.id.localeCompare(b.id),
    );
  };
  const visibleReports = async (
    u: { id: string; role: string },
    opts: { search?: string; category?: string; sort?: SortKey } = {},
  ) => {
    const owned = await d.reports.list(u.id, opts);
    const needle = opts.search?.trim().toUpperCase();
    const category = opts.category?.trim();
    const shared = (
      u.role === 'ADMIN'
        ? (await d.reports.listAdmin()).filter((report) => report.ownerId !== u.id)
        : await sharedWith(u.id)
    ).filter(
      (x) =>
        (!needle || x.name.toUpperCase().includes(needle)) &&
        (!category || x.category === category),
    );
    return { owned, shared };
  };

  r.get(
    '/reports',
    h(async (req, res) => {
      // 'custom' is the viewing user's own dashboard tile order (migration 008); reports
      // without a saved position follow in name order, so no saved order = name order.
      const custom = req.query.sort === 'custom';
      const sort = (['name', 'created', 'lastRun', 'updated'] as const).includes(
        req.query.sort as SortKey,
      )
        ? (req.query.sort as SortKey)
        : 'name';
      const search =
        typeof req.query.search === 'string' ? req.query.search.slice(0, 128) : undefined;
      const category =
        typeof req.query.category === 'string' ? req.query.category.slice(0, 128) : undefined;
      let { owned, shared } = await visibleReports(user(req), { search, category, sort });
      // Folders and favorites are the viewing user's own (migration 006).
      const prefs = await d.folders.prefs(user(req).id);
      // Saved positions are only ever looked up for reports already authorised above, so an
      // order entry for a report the user lost access to is ignored, never shown.
      const positions = await d.tileOrder.positions(user(req).id);
      const visibleIds = new Set([...owned, ...shared].map((x) => x.id));
      const rank = new Map(
        [...positions]
          .filter(([id]) => visibleIds.has(id))
          .sort((a, b) => a[1] - b[1])
          .map(([id], i) => [id, i]),
      );
      if (custom) {
        owned = applyTileOrder(owned, rank);
        shared = applyTileOrder(shared, rank);
      }
      const withPref = <R extends { id: string }>(x: R) => ({
        ...x,
        folderId: prefs.get(x.id)?.folderId ?? null,
        favorite: prefs.get(x.id)?.favorite ?? false,
        tilePos: rank.get(x.id) ?? null,
      });
      res.json({
        reports: owned.map((x) => withPref({ ...x, access: 'OWNER' as const })),
        shared: shared.map(withPref),
      });
    }),
  );

  // ---- Per-user dashboard tile order (migration 008). Scoped to the signed-in user. ----
  const savedTileOrder = async (u: { id: string; role: string }) => {
    const { owned, shared } = await visibleReports(u);
    const visible = new Set([...owned, ...shared].map((x) => x.id));
    const positions = await d.tileOrder.positions(u.id);
    return [...positions]
      .filter(([id]) => visible.has(id))
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  };
  r.get(
    '/dashboard/tile-order',
    h(async (req, res) => {
      res.json({ reportIds: await savedTileOrder(user(req)) });
    }),
  );
  r.put(
    '/dashboard/tile-order',
    h(async (req, res) => {
      const { reportIds } = tileOrderInputSchema.parse(req.body ?? {});
      const { owned, shared } = await visibleReports(user(req));
      const visible = new Set([...owned, ...shared].map((x) => x.id));
      // Only reports the user can see are stored. Anything else (deleted, never shared,
      // or revoked) is silently dropped, so the response does not reveal whether it exists.
      // Replacing the whole list also prunes rows for reports the user has lost access to.
      const kept = reportIds.filter((id) => visible.has(id));
      await d.tileOrder.replace(user(req).id, kept);
      res.json({ reportIds: kept });
    }),
  );
  r.delete(
    '/dashboard/tile-order',
    h(async (req, res) => {
      await d.tileOrder.clear(user(req).id);
      res.json({ reportIds: [] });
    }),
  );

  // ---- Folders (006) and shared folders (009). ----
  // Personal filing and favorites are scoped to the signed-in user (FolderRepository). Who may
  // see or change a folder is decided by FolderAccessService; which reports in it a person sees
  // is always reduced to the reports they can already see (visibleReports), so sharing a
  // folder never reveals a report, and a hidden report is never counted or listed.
  const folderId = (req: Request) => {
    const r = uuid.safeParse(req.params.folderId);
    if (!r.success) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found.');
    return r.data;
  };
  const visibleIdSet = async (u: Pick<AppUser, 'id' | 'role'>) => {
    const { owned, shared } = await visibleReports(u);
    return new Set([...owned, ...shared].map((x) => x.id));
  };
  const viewFolders = async (u: Pick<AppUser, 'id' | 'role'>, only?: string) => {
    let list = await d.folderAccess.listAccessible(u);
    if (only) list = list.filter((f) => f.id === only);
    const [members, visible] = await Promise.all([d.folderAccess.members(list), visibleIdSet(u)]);
    return list.map((f) => ({
      ...f,
      reportIds: (members.get(f.id) ?? []).map((m) => m.reportId).filter((id) => visible.has(id)),
    }));
  };
  const oneFolder = async (u: Pick<AppUser, 'id' | 'role'>, id: string) => {
    const [f] = await viewFolders(u, id);
    if (!f) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found.');
    return f;
  };
  /**
   * A folder's shares and its "also share the reports" option (migration 011), with which of
   * the reports in it are (or would be) shared through it and which are skipped and why. Only
   * reports the caller (the owner, or an admin reading) can see are listed.
   */
  const folderSharing = async (
    u: Pick<AppUser, 'id' | 'role'>,
    folder: { id: string; ownerId: string },
  ) => {
    const [shares, setting, members, visible] = await Promise.all([
      d.folderAccess.listShares(folder.id),
      d.folderAccess.reportSharingFor([folder.id]),
      d.folderAccess.members([folder]),
      visibleIdSet(u),
    ]);
    const mine = (members.get(folder.id) ?? []).filter((m) => visible.has(m.reportId));
    const byId = new Map(
      (await d.reports.listByIds(mine.map((m) => m.reportId))).map((x) => [x.id, x]),
    );
    const included: { id: string; name: string }[] = [];
    const skipped: {
      id: string;
      name: string;
      ownerName: string;
      reason: FolderReportSkipReason;
    }[] = [];
    for (const m of mine) {
      const rep = byId.get(m.reportId);
      if (!rep) continue;
      const reason = folderSkipReason(folder.ownerId, m);
      if (reason) skipped.push({ id: rep.id, name: rep.name, ownerName: rep.ownerName, reason });
      else included.push({ id: rep.id, name: rep.name });
    }
    return {
      shares,
      shareReports: setting.get(folder.id) ?? null,
      reports: { included, skipped },
      // Only whether e-mail is set up, for the "Notify people" option; never any SMTP setting.
      mailConfigured: d.notifier.mailConfigured,
    };
  };
  /** The report must exist and be visible to the caller, else 404 (never 403: no leak). */
  const requireVisibleReport = async (u: Pick<AppUser, 'id' | 'role'>, id: string) => {
    await d.access.require(u, id, 'VIEW');
  };
  r.get(
    '/folders',
    h(async (req, res) => {
      res.json({ folders: await viewFolders(user(req)) });
    }),
  );
  r.post(
    '/folders',
    h(async (req, res) => {
      const { name } = folderInputSchema.parse(req.body ?? {});
      const f = await d.folders.create(user(req).id, name);
      res.status(201).json({ folder: await oneFolder(user(req), f.id) });
    }),
  );
  r.get(
    '/folders/:folderId',
    h(async (req, res) => {
      const id = folderId(req);
      await d.folderAccess.require(user(req), id, 'VIEW');
      res.json({ folder: await oneFolder(user(req), id) });
    }),
  );
  r.put(
    '/folders/:folderId',
    h(async (req, res) => {
      const id = folderId(req);
      const { name } = folderInputSchema.parse(req.body ?? {});
      await d.folderAccess.require(user(req), id, 'OWNER');
      await d.folders.rename(user(req).id, id, name);
      res.json({ folder: await oneFolder(user(req), id) });
    }),
  );
  r.delete(
    '/folders/:folderId',
    h(async (req, res) => {
      const id = folderId(req);
      // Owner only. Shares and shared placements go with the folder; no report is deleted.
      await d.folderAccess.require(user(req), id, 'OWNER');
      res.json(await d.folders.remove(user(req).id, id));
    }),
  );
  r.get(
    '/folders/:folderId/shares',
    h(async (req, res) => {
      const { folder, access } = await d.folderAccess.require(user(req), folderId(req), 'VIEW');
      if (access !== 'OWNER' && access !== 'ADMIN')
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the folder owner can see who it is shared with.',
        );
      res.json(await folderSharing(user(req), folder));
    }),
  );
  r.put(
    '/folders/:folderId/shares',
    h(async (req, res) => {
      const { shares, shareReports, notify } = folderSharesInputSchema.parse(req.body);
      const { folder } = await d.folderAccess.require(user(req), folderId(req), 'OWNER');
      let changes: ShareChange[] = [];
      await d.folderAccess.replaceShares(
        folder,
        user(req).id,
        shares,
        async (id) => Boolean(await d.users.findById(id)),
        shareReports,
        (c) => (changes = c),
      );
      // E-mails go out after the commit, in the background; the outcome only says what happened.
      const notification = d.notifier.notifyChanges(
        { kind: 'FOLDER', id: folder.id, name: folder.name, ownerId: folder.ownerId },
        user(req),
        changes,
        notify === true,
      );
      res.json({ ...(await folderSharing(user(req), folder)), notification });
    }),
  );
  /**
   * Folder access and audit follow the report rule (AccessService.canViewAudit): only the owner,
   * or a global admin, may read them. Viewers and editors get 403; anyone who cannot see the
   * folder at all, including an admin looking at someone's personal (never shared) folder, 404.
   */
  const requireFolderAuditor = async (req: Request) => {
    const { folder, access } = await d.folderAccess.require(user(req), folderId(req), 'VIEW');
    if (access !== 'OWNER' && access !== 'ADMIN')
      throw new AppError(
        403,
        'FORBIDDEN',
        'Only the folder owner or an admin can view access audit.',
      );
    return folder;
  };
  r.get(
    '/folders/:folderId/access',
    h(async (req, res) => {
      const folder = await requireFolderAuditor(req);
      const owner = await d.users.findById(folder.ownerId);
      const [shares, page, sharing] = await Promise.all([
        d.folderAccess.listShares(folder.id),
        d.folderAccess.auditPage(folder.id, Number(req.query.limit) || 100, 0),
        d.folderAccess.reportSharingFor([folder.id]),
      ]);
      res.json({
        owner: { id: folder.ownerId, displayName: owner?.displayName ?? folder.ownerId },
        shares,
        shareReports: sharing.get(folder.id) ?? null,
        events: page.events,
        hasMore: page.hasMore,
      });
    }),
  );
  r.get(
    '/folders/:folderId/audit',
    h(async (req, res) => {
      const folder = await requireFolderAuditor(req);
      const { limit, offset } = folderAuditQuerySchema.parse(req.query);
      const page = await d.folderAccess.auditPage(folder.id, limit, offset);
      res.json({ ...page, limit, offset });
    }),
  );
  /**
   * The folder's whole sharing history as CSV, newest first, for the same people who may read
   * it above (owner or admin). Streamed a batch at a time with keyset paging, so a long history
   * is never cut off and is never held in memory.
   */
  r.get(
    '/folders/:folderId/audit/export',
    h(async (req, res) => {
      const folder = await requireFolderAuditor(req);
      await streamCsv(
        res,
        folderAuditCsvName(folder.name, false),
        d.folderAccess.auditAll(folder.id),
        folderAuditCsvCells(folder.name),
      );
    }),
  );

  // ---- Deleted folders (migration 013): app admins only. ----
  // A deleted folder has no owner view left, and its history names everyone who had access, so
  // only a global admin may read it. Everyone else gets 403 whether or not anything was deleted.
  const requireAdmin = (req: Request, message = 'Only an admin can view deleted folders.') => {
    if (user(req).role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', message);
  };
  /**
   * A deleted folder's deletion record. A folder that still exists is 404 here even for an
   * admin, so this can never be used to read a live (possibly never-shared, personal) folder's
   * history past the normal owner / admin rule above.
   */
  const requireDeletedFolder = async (req: Request) => {
    requireAdmin(req);
    const id = folderId(req);
    const [live, deletion] = await Promise.all([
      d.folders.findById(id),
      d.folders.findDeletion(id),
    ]);
    if (live || !deletion)
      throw new AppError(404, 'DELETION_NOT_FOUND', 'No deletion is recorded for this folder.');
    return deletion;
  };
  r.get(
    '/admin/folder-deletions',
    h(async (req, res) => {
      requireAdmin(req);
      const { limit, offset } = folderDeletionsQuerySchema.parse(req.query);
      res.json({ ...(await d.folders.listDeletions(limit, offset)), limit, offset });
    }),
  );
  r.get(
    '/admin/folder-deletions/:folderId/audit',
    h(async (req, res) => {
      const deletion = await requireDeletedFolder(req);
      const { limit, offset } = folderAuditQuerySchema.parse(req.query);
      const page = await d.folderAccess.auditPage(deletion.folderId, limit, offset);
      res.json({ deletion, ...page, limit, offset });
    }),
  );
  r.get(
    '/admin/folder-deletions/:folderId/audit/export',
    h(async (req, res) => {
      const deletion = await requireDeletedFolder(req);
      await streamCsv(
        res,
        folderAuditCsvName(deletion.folderName, true),
        d.folderAccess.auditAll(deletion.folderId),
        folderAuditCsvCells(deletion.folderName),
      );
    }),
  );

  // ---- History retention (no migration): app admins only. ----
  const retentionState = () => ({
    settings: d.retention.settings(),
    batchSize: d.retention.batchSize,
    maxBatches: d.retention.maxBatches,
    /** Automatic daily runs happen only on the scheduler leader, so only once it has started. */
    automatic: cfg.scheduler.enabled && d.scheduler.started,
    running: d.retention.isRunning,
    nextAutomaticAfter: d.retention.nextAutomaticAfter,
    lastRun: d.retention.lastRun,
  });
  const ADMIN_RETENTION = 'Only an admin can manage data retention.';
  r.get(
    '/admin/retention',
    h(async (req, res) => {
      requireAdmin(req, ADMIN_RETENTION);
      res.json(retentionState());
    }),
  );
  r.post(
    '/admin/retention/run',
    h(async (req, res) => {
      requireAdmin(req, ADMIN_RETENTION);
      try {
        const run = await d.retention.run({ trigger: 'MANUAL', requestedBy: user(req).username });
        res.json({ ...retentionState(), run });
      } catch (e) {
        if (e instanceof RetentionRunningError)
          throw new AppError(409, 'RETENTION_RUNNING', e.message);
        throw e;
      }
    }),
  );
  r.post(
    '/folders/:folderId/reports',
    h(async (req, res) => {
      const { reportId: rid } = folderAddInputSchema.parse(req.body ?? {});
      const { folder } = await d.folderAccess.require(user(req), folderId(req), 'EDIT');
      // An editor can only place reports they can see themselves.
      await requireVisibleReport(user(req), rid);
      await d.folderAccess.addReport(folder, rid, user(req).id);
      res.json({ folder: await oneFolder(user(req), folder.id) });
    }),
  );
  r.delete(
    '/folders/:folderId/reports/:id',
    h(async (req, res) => {
      const rid = reportId(req);
      const { folder } = await d.folderAccess.require(user(req), folderId(req), 'EDIT');
      // Nobody can act on (or learn about) a report they cannot see.
      await requireVisibleReport(user(req), rid);
      await d.folderAccess.removeReport(folder, rid);
      res.json({ folder: await oneFolder(user(req), folder.id) });
    }),
  );
  r.put(
    '/folders/:folderId/order',
    h(async (req, res) => {
      const { reportIds } = folderOrderInputSchema.parse(req.body ?? {});
      const { folder } = await d.folderAccess.require(user(req), folderId(req), 'EDIT');
      const members: FolderMember[] = (await d.folderAccess.members([folder])).get(folder.id) ?? [];
      const visible = await visibleIdSet(user(req));
      const visibleMembers = new Set(
        members.map((m) => m.reportId).filter((id) => visible.has(id)),
      );
      // Reports the caller cannot see keep their place; ids that are not visible members of
      // this folder are silently ignored so the response does not reveal whether they exist.
      const merged = mergeVisibleOrder(
        members.map((m) => m.reportId),
        visibleMembers,
        reportIds.filter((id) => visibleMembers.has(id)),
      );
      const byId = new Map(members.map((m) => [m.reportId, m]));
      await d.folderAccess.saveOrder(
        folder.id,
        merged.map((id) => byId.get(id)!),
        user(req).id,
      );
      res.json({ folder: await oneFolder(user(req), folder.id) });
    }),
  );
  const prefSchema = z
    .object({ folderId: uuid.nullable().optional(), favorite: z.boolean().optional() })
    .strict()
    .refine((v) => v.folderId !== undefined || v.favorite !== undefined, 'Nothing to change.');
  r.put(
    '/reports/:id/prefs',
    h(async (req, res) => {
      const id = reportId(req);
      const change = prefSchema.parse(req.body ?? {});
      // Anyone who can see a report may file or star it for themselves; nobody else's view changes.
      await d.access.require(user(req), id, 'VIEW');
      const prefs = await d.folders.setPref(user(req).id, id, change);
      // "Move to folder" puts the report in exactly one of the caller's own folders (or none),
      // so it also leaves any of their own shared folders it had been placed in.
      if (change.folderId !== undefined)
        await d.folderAccess.removeFromOwnFoldersExcept(user(req).id, id, change.folderId);
      res.json({ prefs });
    }),
  );
  /**
   * A report saved from the Report Builder sends its definition. The server validates
   * it against the catalog and regenerates SQL and parameters from it; any SQL or
   * parameters in the request body are ignored.
   */
  const withBuilderDef = async (req: Request) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.builderDef === undefined || body.builderDef === null)
      return { body, builderDef: body.builderDef as null | undefined };
    const rebuilt = await rebuildFromDef(d, user(req).id, body.builderDef);
    return {
      body: { ...body, sql: rebuilt.sql, parameters: rebuilt.parameters },
      builderDef: rebuilt.def,
    };
  };
  r.post(
    '/reports',
    h(async (req, res) => {
      const { body, builderDef } = await withBuilderDef(req);
      const input = reportInputSchema.parse(body);
      checkLength(input.sql);
      const { chartDef } = z.object({ chartDef: chartInput }).parse(body);
      const created = await d.reports.create(user(req).id, {
        ...input,
        builderDef,
        chartDef: chartDef ?? null,
      });
      res.status(201).json({ report: { ...created, access: 'OWNER' } });
    }),
  );
  r.get(
    '/reports/:id',
    h(async (req, res) => {
      const { report, access } = await d.access.require(user(req), reportId(req), 'VIEW');
      // Re-validate a saved builder definition so the UI knows whether it can reopen it.
      let builder: { valid: boolean; error?: string } | undefined;
      let fields: GroupField[] = [];
      if (report.builderDef !== null) {
        try {
          const rebuilt = await rebuildFromDef(d, user(req).id, report.builderDef);
          builder = { valid: true };
          if (rebuilt.columns) fields = groupFields(rebuilt.effective, rebuilt.columns);
        } catch (e) {
          builder = {
            valid: false,
            error: e instanceof AppError ? e.message : 'The definition could not be checked.',
          };
        }
      }
      res.json({
        report: { ...report, access },
        ...(builder ? { builder } : {}),
        drill: await drillInfo(user(req), report, fields),
      });
    }),
  );
  r.put(
    '/reports/:id',
    h(async (req, res) => {
      const { report, access } = await d.access.require(user(req), reportId(req), 'EDIT');
      const { body, builderDef } = await withBuilderDef(req);
      const input = reportUpdateSchema.parse(body);
      checkLength(input.sql);
      // An edit without a definition (e.g. in the SQL editor) keeps the stored one only
      // while the SQL and parameters are unchanged; otherwise it no longer describes the SQL.
      let def: unknown | null = builderDef ?? null;
      if (builderDef === undefined && report.builderDef !== null) {
        const same =
          input.sql === report.sql &&
          JSON.stringify(input.parameters ?? []) === JSON.stringify(report.parameters);
        def = same ? report.builderDef : null;
      }
      const updated = await d.reports.update(report.ownerId, report.id, {
        ...input,
        builderDef: def,
      });
      res.json({ report: { ...updated, access } });
    }),
  );
  r.put(
    '/reports/:id/chart',
    h(async (req, res) => {
      const { chartDef } = z
        .object({ chartDef: chartInput })
        .strict()
        .parse(req.body ?? {});
      if (chartDef === undefined)
        throw new AppError(400, 'BAD_REQUEST', 'Provide chartDef (or null to remove the chart).');
      const { report, access } = await d.access.require(user(req), reportId(req), 'EDIT');
      const updated = await d.reports.setChart(report.ownerId, report.id, chartDef);
      res.json({ report: { ...updated, access } });
    }),
  );
  r.put(
    '/reports/:id/formatting',
    h(async (req, res) => {
      const body = z.object({ formatting: formattingSchema.nullable() }).strict().parse(req.body);
      const { report, access } = await d.access.require(user(req), reportId(req), 'EDIT');
      res.json({
        report: {
          ...(await d.reports.setFormatting(report.ownerId, report.id, body.formatting)),
          access,
        },
      });
    }),
  );

  r.delete(
    '/reports/:id',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'OWNER');
      if (user(req).id !== report.ownerId)
        throw new AppError(403, 'FORBIDDEN', 'Only the report owner can delete it.');
      await d.reports.delete(report.ownerId, report.id);
      res.status(204).end();
    }),
  );
  r.post(
    '/reports/:id/execute',
    execLimiter,
    h(async (req, res) => {
      const body = z
        .object({ executionId: uuid.optional(), values: parameterValuesSchema.optional() })
        .parse(req.body ?? {});
      res.json(
        await d.execution.runReport(
          user(req),
          reportId(req),
          body.executionId ?? randomUUID(),
          body.values ?? {},
        ),
      );
    }),
  );
  // ---- drill-down (see reports/drill.ts) ----
  const drillBody = z
    .object({
      executionId: uuid.optional(),
      /** The source report's own parameter values (ask-when-run filters). */
      values: parameterValuesSchema.optional(),
      /** Clicked group field (result column name) -> value; null means IS NULL. */
      keys: z
        .record(z.string().min(1).max(128), z.union([scalar, z.null()]))
        .refine((k) => Object.keys(k).length <= 20, 'At most 20 drill fields.'),
      mode: z.enum(['builder', 'target']).optional(),
      /** Detail columns (builder mode); defaults to the derived ones. */
      columns: z.array(columnRef).min(1).max(MAX_DETAIL_COLUMNS).optional(),
    })
    .strict();
  type DrillBody = z.infer<typeof drillBody>;

  /** The drill target, if configured and the user can run it (null otherwise). */
  async function drillTarget(u: AppUser, report: Report) {
    if (!report.drillDef) return null;
    try {
      return (await d.access.require(u, report.drillDef.targetReportId, 'VIEW')).report;
    } catch (e) {
      if (e instanceof AppError && (e.status === 403 || e.status === 404)) return null;
      throw e;
    }
  }

  /** What the UI may offer for a report: builder fields and / or a runnable target. */
  async function drillInfo(u: AppUser, report: Report, fields?: GroupField[]) {
    if (fields === undefined) {
      fields = [];
      if (report.builderDef !== null)
        try {
          const rebuilt = await rebuildFromDef(d, u.id, report.builderDef);
          if (rebuilt.columns) fields = groupFields(rebuilt.effective, rebuilt.columns);
        } catch {
          fields = [];
        }
    }
    const target = await drillTarget(u, report);
    return {
      builder:
        report.builderDef !== null && fields.length > 0
          ? { fields: fields.map((f) => f.name) }
          : null,
      target:
        target && report.drillDef
          ? {
              id: target.id,
              name: target.name,
              fields: report.drillDef.mapping.map((m) => m.field),
            }
          : null,
      /** A target is configured but this user cannot run it. */
      targetUnavailable: !!report.drillDef && !target,
    };
  }

  async function planDrill(u: AppUser, sourceId: string, body: DrillBody) {
    const { report } = await d.access.require(u, sourceId, 'VIEW');
    const mode = body.mode ?? (report.drillDef ? 'target' : 'builder');
    if (mode === 'target') {
      if (!report.drillDef)
        throw new AppError(400, 'NO_DRILL_TARGET', 'This report has no drill target.');
      if (body.columns)
        throw new AppError(400, 'BAD_REQUEST', 'Columns can only be chosen for builder drills.');
      // Access is checked again for the person clicking, not the owner who configured it.
      const target = (await d.access.require(u, report.drillDef.targetReportId, 'VIEW')).report;
      const values = mapTargetValues(report.drillDef, body.keys, target.parameters);
      const applied = Object.entries(body.keys).map(([field, value]) => ({ field, value }));
      return { kind: 'target' as const, report, target, values, applied };
    }
    if (report.builderDef === null)
      throw new AppError(
        400,
        'NOT_DRILLABLE',
        'Only Report Builder reports can be drilled into without a drill target.',
      );
    const rebuilt = await rebuildFromDef(d, u.id, report.builderDef);
    if (!rebuilt.columns || !rebuilt.aliases)
      throw new AppError(400, 'NOT_DRILLABLE', 'This report is not grouped.');
    const spec = rebuilt.effective;
    const fields = groupFields(spec, rebuilt.columns);
    const columns =
      body.columns ?? defaultDetailColumns(spec, rebuilt.aliases, rebuilt.sources, fields);
    const derived = deriveDetailSpec(spec, fields, body.keys, columns);
    const built = await buildQuery(d, u.id, derived.spec as BuilderInput);
    return {
      kind: 'builder' as const,
      report,
      built,
      applied: derived.applied,
      columns,
      available: availableColumns(rebuilt.aliases, rebuilt.sources, rebuilt.calculated),
    };
  }

  r.post(
    '/reports/:id/drill',
    execLimiter,
    h(async (req, res) => {
      const body = drillBody.parse(req.body ?? {});
      const plan = await planDrill(user(req), reportId(req), body);
      const execId = body.executionId ?? randomUUID();
      const label = drillLabel(plan.applied);
      if (plan.kind === 'target') {
        const out = await d.execution.runReport(user(req), plan.target.id, execId, plan.values);

        res.json({
          ...out,
          drill: {
            mode: 'target',
            sourceId: plan.report.id,
            sourceName: plan.report.name,
            label,
            applied: plan.applied,
            target: { id: plan.target.id, name: plan.target.name },
            values: plan.values,
            next: await drillInfo(user(req), plan.target),
          },
        });
        return;
      }
      const out = await d.execution.runAdhoc(user(req), plan.built.sql, execId, {
        definitions: plan.built.parameters,
        values: body.values ?? {},
      });
      res.json({
        ...out,
        ...(plan.report.formatting
          ? {
              formatting: plan.report.formatting,
              formatStyles: matchFormatting(plan.report.formatting, out.columns, out.rows),
            }
          : {}),
        drill: {
          mode: 'builder',
          sourceId: plan.report.id,
          sourceName: plan.report.name,
          label,
          applied: plan.applied,
          columns: plan.columns,
          available: plan.available,
        },
      });
    }),
  );
  r.post(
    '/reports/:id/drill/export',
    execLimiter,
    h(async (req, res) => {
      const body = drillBody.parse(req.body ?? {});
      const plan = await planDrill(user(req), reportId(req), body);
      const label = drillLabel(plan.applied);
      const file =
        plan.kind === 'target'
          ? await d.execution.exportXlsx(user(req), {
              reportId: plan.target.id,
              values: plan.values,
              chart: null,
            })
          : await d.execution.exportXlsx(user(req), {
              sql: plan.built.sql,
              definitions: plan.built.parameters,
              values: body.values ?? {},
              name: `${plan.report.name} - ${label}`.slice(0, 128),
              chart: null,
            });
      await sendXlsx(res, file);
    }),
  );
  /** Reports the editor may pick as a drill target (ones they can run), with parameters. */
  r.get(
    '/reports/:id/drill-targets',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'EDIT');
      const owned = await d.reports.list(user(req).id, { sort: 'name' });
      const groups = await d.groups.forUser(user(req).id);
      const shared =
        user(req).role === 'ADMIN'
          ? (await d.reports.listAdmin()).filter((report) => report.ownerId !== user(req).id)
          : await d.reports.listShared(user(req).id, groups);
      const seen = new Set<string>([report.id]);
      const targets = [];
      for (const x of [...owned, ...shared]) {
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        targets.push({
          id: x.id,
          name: x.name,
          parameters: x.parameters
            .filter((p) => !p.fixed)
            .map((p) => ({ name: p.name, label: p.label, type: p.type })),
        });
      }
      res.json({ targets });
    }),
  );
  r.put(
    '/reports/:id/drill',
    h(async (req, res) => {
      const { drillDef } = z
        .object({ drillDef: drillDefSchema.nullable() })
        .strict()
        .parse(req.body ?? {});
      const { report, access } = await d.access.require(user(req), reportId(req), 'EDIT');
      if (drillDef) await checkDrillDef(user(req), report, drillDef);
      const updated = await d.reports.setDrill(report.ownerId, report.id, drillDef);
      res.json({ report: { ...updated, access }, drill: await drillInfo(user(req), updated) });
    }),
  );
  async function checkDrillDef(u: AppUser, report: Report, def: DrillDef) {
    if (def.targetReportId === report.id)
      throw new AppError(400, 'INVALID_DRILL_TARGET', 'A report cannot drill to itself.');
    const target = (await d.access.require(u, def.targetReportId, 'VIEW')).report;
    for (const m of def.mapping)
      if (!target.parameters.some((p) => p.name === m.parameter && !p.fixed))
        throw new AppError(
          400,
          'INVALID_DRILL_TARGET',
          `${target.name} has no parameter named ${m.parameter}.`,
        );
  }

  r.get(
    '/reports/:id/history',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'VIEW');
      res.json({
        executions: await d.history.list(user(req).id, { reportId: report.id, limit: 50 }),
      });
    }),
  );
  r.get(
    '/history',
    h(async (req, res) => {
      res.json({
        executions: await d.history.list(user(req).id, { limit: Number(req.query.limit) || 50 }),
      });
    }),
  );

  // ---- sharing ----
  r.get(
    '/reports/:id/shares',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'OWNER');
      const [shares, folderGrants] = await Promise.all([
        d.access.listShares(report.id),
        d.folderGrants.grantsForReport(report),
      ]);
      // folderGrants: read-only here; they change with the folder, not the report's shares
      res.json({ shares, folderGrants, mailConfigured: d.notifier.mailConfigured });
    }),
  );
  r.put(
    '/reports/:id/shares',
    h(async (req, res) => {
      const { shares, notify } = sharesInputSchema.parse(req.body);
      const { report } = await d.access.require(user(req), reportId(req), 'OWNER');
      let changes: ShareChange[] = [];
      const out = await d.access.replaceShares(
        report,
        user(req).id,
        shares,
        async (id) => Boolean(await d.users.findById(id)),
        (c) => (changes = c),
      );
      // E-mails go out after the commit, in the background; the outcome only says what happened.
      const notification = d.notifier.notifyChanges(
        { kind: 'REPORT', id: report.id, name: report.name, ownerId: report.ownerId },
        user(req),
        changes,
        notify === true,
      );
      res.json({ shares: out, notification });
    }),
  );
  r.get(
    '/reports/:id/access',
    h(async (req, res) => {
      // owner-only: who can reach the report now, and how that changed over time
      const { report } = await d.access.require(user(req), reportId(req), 'EDIT');
      if (!d.access.canViewAudit(user(req), report))
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the report owner or an admin can view access audit.',
        );
      const limit = Number(req.query.limit) || 100;
      const owner = await d.users.findById(report.ownerId);
      const [shares, events, folderGrants] = await Promise.all([
        d.access.listShares(report.id),
        d.access.listAudit(report.id, limit),
        d.folderGrants.grantsForReport(report),
      ]);
      res.json({
        owner: { id: report.ownerId, displayName: owner?.displayName ?? report.ownerId },
        shares,
        folderGrants,
        events,
      });
    }),
  );
  r.get(
    '/users',
    h(async (req, res) => {
      const term = typeof req.query.search === 'string' ? req.query.search.slice(0, 64) : '';
      if (term.trim().length < 1) return res.json({ users: [] });
      res.json({ users: (await d.users.search(term)).filter((u) => u.id !== user(req).id) });
    }),
  );
  // ---- account settings (migration 015) ----
  const accountSettings = async (u: Pick<AppUser, 'id'>) => {
    const [settings, me] = await Promise.all([d.userSettings.get(u.id), d.users.findById(u.id)]);
    return { settings, hasEmail: Boolean(me?.email), mailConfigured: d.notifier.mailConfigured };
  };
  r.get(
    '/account/settings',
    h(async (req, res) => {
      res.json(await accountSettings(user(req)));
    }),
  );
  r.put(
    '/account/settings',
    h(async (req, res) => {
      const body = z.object({ shareEmails: z.boolean() }).strict().parse(req.body);
      await d.userSettings.set(user(req).id, body);
      res.json(await accountSettings(user(req)));
    }),
  );
  r.get(
    '/groups',
    h(async (_req, res) => {
      res.json({ groups: await d.groups.allNames() });
    }),
  );

  // ---- schedules ----
  // Mail settings (SMTP host, user, password) never leave the server: the browser only learns
  // whether e-mail delivery is configured.
  const scheduleSettings = () => ({
    enabled: cfg.scheduler.enabled,
    mailConfigured: Boolean(d.mailer),
    recipientDomains: cfg.scheduler.recipientDomains,
    maxRecipients: cfg.scheduler.maxRecipients,
    minIntervalMinutes: cfg.scheduler.minIntervalMinutes,
    defaultTimezone: cfg.scheduler.defaultTimezone,
    datePresetTimezone: cfg.datePresetTimezone,
    maxFailures: cfg.scheduler.maxFailures,
  });
  const requireMail = () => {
    if (!d.mailer)
      throw new AppError(
        503,
        'MAIL_NOT_CONFIGURED',
        'Scheduled e-mail is not set up on this server (SMTP). Ask an administrator to configure it. You can still save the schedule as paused.',
      );
  };
  /** Every recipient must be someone who can already open the report. */
  const requireRecipientAccess = async (report: Report, recipients: string[]) => {
    const { blocked, expired } = await d.recipients.check(report, recipients);
    if (blocked.length)
      throw new AppError(
        400,
        'RECIPIENT_NO_ACCESS',
        `${blocked.join(', ')} ${blocked.length === 1 ? 'is not an Uncle Bob user who can' : 'are not Uncle Bob users who can'} open this report. Share the report with them first, or remove them.${
          expired.length
            ? ` Access has expired for ${expired.join(', ')}: renew the share first.`
            : ''
        }`,
        { blocked, expired },
      );
  };
  const prepareSchedule = async (report: Report, input: ScheduleInput) => {
    const upcoming = validateCron(input.cron, input.timezone, cfg.scheduler.minIntervalMinutes);
    const rc = checkRecipients(input.recipients, cfg.scheduler);
    if (!rc.ok) throw new AppError(400, 'INVALID_RECIPIENTS', rc.message);
    await requireRecipientAccess(report, rc.recipients);
    // a paused schedule may be saved without SMTP; an active one would only fail at run time
    if (input.enabled) requireMail();
    // validate required parameters now so the schedule doesn't fail at run time
    const p = resolveParameters(report.sql, report.parameters, input.parameters, {
      timeZone: cfg.datePresetTimezone,
    });
    return {
      // Preserve the rolling definition rather than the dates resolved during validation.
      input: {
        ...input,
        recipients: rc.recipients,
        parameters: {
          ...p.used,
          ...Object.fromEntries(
            report.parameters.filter((d) => d.datePreset).map((d) => [d.name, d.defaultValue]),
          ),
        },
      },
      next: input.enabled ? upcoming[0] : null,
      upcoming,
    };
  };
  const loadSchedule = async (req: Request) => {
    const s = await d.schedules.get(uuid.parse(req.params.id));
    const { report } = await d.access.require(user(req), s.reportId, 'EDIT').catch((e) => {
      if (e instanceof AppError && e.status === 404)
        throw new AppError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found.');
      throw e;
    });
    return { s, report };
  };
  const versionBody = z.object({ version: z.number().int().positive().optional() });

  r.get('/schedules/settings', (_req, res) => {
    res.json(scheduleSettings());
  });
  r.post(
    '/schedules/preview',
    h(async (req, res) => {
      const b = z
        .object({
          cron: z.string().max(128).optional(),
          cadence: cadenceSchema.optional(),
          timezone: z.string().max(64),
        })
        .parse(req.body);
      if (!b.cron && !b.cadence)
        throw new AppError(
          400,
          'INVALID_CADENCE',
          'Choose how often the report should be delivered.',
        );
      const cron = b.cadence ? cadenceToCron(b.cadence) : b.cron!;
      const upcoming = validateCron(cron, b.timezone, cfg.scheduler.minIntervalMinutes);
      res.json({
        upcoming: upcoming.map((x) => x.toISOString()),
        cron,
        description: describeCadence(cronToCadence(cron), cron),
      });
    }),
  );
  const schedulesFor = async (u: Pick<AppUser, 'id' | 'role'>) => {
    const admin = u.role === 'ADMIN';
    const groups = await d.groups.forUser(u.id);
    const viaFolders = admin ? [] : [...(await d.folderGrants.reportRolesFor(u.id, groups)).keys()];
    return d.schedules.listForUser(u.id, groups, admin, viaFolders);
  };
  r.get(
    '/schedules',
    h(async (req, res) => {
      res.json({
        schedules: await schedulesFor(user(req)),
        settings: scheduleSettings(),
      });
    }),
  );
  r.get(
    '/reports/:id/schedules',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'EDIT');
      res.json({
        schedules: await d.schedules.listForReport(report.id),
        settings: scheduleSettings(),
      });
    }),
  );
  r.get(
    '/reports/:id/schedule-recipients',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'EDIT');
      res.json({ recipients: await d.recipients.options(report) });
    }),
  );
  r.post(
    '/reports/:id/schedules',
    h(async (req, res) => {
      const body = normaliseScheduleBody(scheduleBodySchema.parse(req.body));
      const { report } = await d.access.require(user(req), reportId(req), 'EDIT');
      const p = await prepareSchedule(report, body);
      res
        .status(201)
        .json({ schedule: await d.schedules.create(report.id, user(req).id, p.input, p.next) });
    }),
  );
  r.put(
    '/schedules/:id',
    h(async (req, res) => {
      const raw = scheduleBodySchema
        .extend({ version: z.number().int().positive() })
        .parse(req.body);
      const body = normaliseScheduleBody(raw);
      const { s, report } = await loadSchedule(req);
      const p = await prepareSchedule(report, body);
      res.json({ schedule: await d.schedules.update(s.id, p.input, p.next, raw.version) });
    }),
  );
  r.post(
    '/schedules/:id/pause',
    h(async (req, res) => {
      const { version } = versionBody.parse(req.body ?? {});
      const { s } = await loadSchedule(req);
      res.json({ schedule: await d.schedules.setEnabled(s.id, false, null, version) });
    }),
  );
  r.post(
    '/schedules/:id/resume',
    h(async (req, res) => {
      const { version } = versionBody.parse(req.body ?? {});
      const { s, report } = await loadSchedule(req);
      requireMail();
      const rc = checkRecipients(s.recipients, cfg.scheduler);
      if (!rc.ok) throw new AppError(400, 'INVALID_RECIPIENTS', rc.message);
      await requireRecipientAccess(report, rc.recipients);
      // the next occurrence after now: runs missed while paused are not replayed
      const [next] = validateCron(s.cron, s.timezone, cfg.scheduler.minIntervalMinutes);
      res.json({ schedule: await d.schedules.setEnabled(s.id, true, next, version) });
    }),
  );
  r.get(
    '/schedules/:id/deliveries',
    h(async (req, res) => {
      const { s } = await loadSchedule(req);
      const limit = z.coerce.number().int().min(1).max(100).default(25).parse(req.query.limit);
      res.json({ deliveries: await d.schedules.listDeliveries(s.id, limit) });
    }),
  );
  r.delete(
    '/schedules/:id',
    h(async (req, res) => {
      const { s } = await loadSchedule(req);
      await d.schedules.delete(s.id);
      res.status(204).end();
    }),
  );
  r.post(
    '/schedules/:id/run',
    execLimiter,
    h(async (req, res) => {
      const { s } = await loadSchedule(req);
      requireMail();
      const result = await d.scheduler.run(s, { trigger: 'MANUAL', requestedBy: user(req).id });
      res.json({ result, schedule: await d.schedules.get(s.id) });
    }),
  );

  return r;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: err.issues.map((i) => i.message).join('; '),
        fields: err.flatten().fieldErrors,
      },
    });
    return;
  }
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { code: err.code, message: err.message };
    if (err instanceof DbError) {
      body.sqlState = err.sqlState;
      body.sqlCode = err.sqlCode;
    } else if (err.details) Object.assign(body, err.details);
    res.status(err.status).json({ error: body });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large.' } });
    return;
  }
  console.error('Unhandled error:', sanitizeErrorMessage(err));
  res
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
}
