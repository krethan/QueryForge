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
import { validateCron } from '../scheduler/cron.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import {
  scheduleInputSchema,
  type ScheduleInput,
  type ScheduleRepository,
} from '../scheduler/schedules.js';
import { sharesInputSchema, type AccessService } from '../sharing/access.js';
import { mapExternalGroups, type GroupRepository } from '../sharing/groups.js';
import type { Report } from '../reports/reports.js';
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
} from '../catalog/join-builder.js';
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
  scheduler: Scheduler;
  mailer?: Mailer;
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
});
const needsOutput = (s: { columns: unknown[]; aggregates?: unknown[] }, ctx: z.RefinementCtx) => {
  if (s.columns.length === 0 && !s.aggregates?.length)
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
    };
  }
  const joins = spec.joins ?? [];
  const sources = [];
  for (const t of [{ schema: spec.schema, table: spec.table }, ...joins])
    sources.push(await d.catalog.resolveTable(ownerId, t.schema, t.table));
  const joined = spec as JoinedReportSpec;
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
  };
}

/** Versioned Report Builder definition stored in QF_REPORTS.BUILDER_DEF. */
export const BUILDER_DEF_VERSION = 1;
const builderDefSchema = z.object({
  version: z.literal(BUILDER_DEF_VERSION),
  spec: reportSpecSchema,
});
export type BuilderDef = z.infer<typeof builderDefSchema>;

/**
 * Validate a stored or submitted builder definition: shape, version, and every name
 * against the catalog. Returns the regenerated SQL and parameters.
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
  return { def: parsed.data, ...built };
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
      });
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

  r.get(
    '/reports',
    h(async (req, res) => {
      const sort = (['name', 'created', 'lastRun', 'updated'] as const).includes(
        req.query.sort as SortKey,
      )
        ? (req.query.sort as SortKey)
        : 'name';
      const search =
        typeof req.query.search === 'string' ? req.query.search.slice(0, 128) : undefined;
      const category =
        typeof req.query.category === 'string' ? req.query.category.slice(0, 128) : undefined;
      const owned = await d.reports.list(user(req).id, { search, category, sort });
      const groups = await d.groups.forUser(user(req).id);
      const needle = search?.trim().toUpperCase();
      const shared = (await d.reports.listShared(user(req).id, groups)).filter(
        (x) =>
          (!needle || x.name.toUpperCase().includes(needle)) &&
          (!category?.trim() || x.category === category.trim()),
      );
      res.json({ reports: owned.map((x) => ({ ...x, access: 'OWNER' as const })), shared });
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
          if (rebuilt.columns)
            fields = groupFields(rebuilt.def.spec as JoinedReportSpec, rebuilt.columns);
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
  r.delete(
    '/reports/:id',
    h(async (req, res) => {
      const { report } = await d.access.require(user(req), reportId(req), 'OWNER');
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
          if (rebuilt.columns)
            fields = groupFields(rebuilt.def.spec as JoinedReportSpec, rebuilt.columns);
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
    const spec = rebuilt.def.spec as JoinedReportSpec;
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
      available: availableColumns(rebuilt.aliases, rebuilt.sources),
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
      const shared = await d.reports.listShared(user(req).id, groups);
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
      res.json({ shares: await d.access.listShares(report.id) });
    }),
  );
  r.put(
    '/reports/:id/shares',
    h(async (req, res) => {
      const { shares } = sharesInputSchema.parse(req.body);
      const { report } = await d.access.require(user(req), reportId(req), 'OWNER');
      const out = await d.access.replaceShares(report, user(req).id, shares, async (id) =>
        Boolean(await d.users.findById(id)),
      );
      res.json({ shares: out });
    }),
  );
  r.get(
    '/reports/:id/access',
    h(async (req, res) => {
      // owner-only: who can reach the report now, and how that changed over time
      const { report } = await d.access.require(user(req), reportId(req), 'OWNER');
      const limit = Number(req.query.limit) || 100;
      const [shares, events] = await Promise.all([
        d.access.listShares(report.id),
        d.access.listAudit(report.id, limit),
      ]);
      res.json({
        owner: { id: report.ownerId, displayName: user(req).displayName },
        shares,
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
  r.get(
    '/groups',
    h(async (_req, res) => {
      res.json({ groups: await d.groups.allNames() });
    }),
  );

  // ---- schedules ----
  const scheduleSettings = () => ({
    enabled: cfg.scheduler.enabled,
    mailConfigured: Boolean(d.mailer),
    recipientDomains: cfg.scheduler.recipientDomains,
    maxRecipients: cfg.scheduler.maxRecipients,
    minIntervalMinutes: cfg.scheduler.minIntervalMinutes,
    defaultTimezone: cfg.scheduler.defaultTimezone,
    maxFailures: cfg.scheduler.maxFailures,
  });
  const prepareSchedule = (report: Report, input: ScheduleInput) => {
    const upcoming = validateCron(input.cron, input.timezone, cfg.scheduler.minIntervalMinutes);
    const rc = checkRecipients(input.recipients, cfg.scheduler);
    if (!rc.ok) throw new AppError(400, 'INVALID_RECIPIENTS', rc.message);
    // validate required parameters now so the schedule doesn't fail at run time
    const p = resolveParameters(report.sql, report.parameters, input.parameters);
    return {
      input: { ...input, recipients: rc.recipients, parameters: p.used },
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

  r.get('/schedules/settings', (_req, res) => {
    res.json(scheduleSettings());
  });
  r.post(
    '/schedules/preview',
    h(async (req, res) => {
      const b = z
        .object({ cron: z.string().max(128), timezone: z.string().max(64) })
        .parse(req.body);
      const upcoming = validateCron(b.cron, b.timezone, cfg.scheduler.minIntervalMinutes);
      res.json({ upcoming: upcoming.map((x) => x.toISOString()) });
    }),
  );
  r.get(
    '/schedules',
    h(async (req, res) => {
      res.json({
        schedules: await d.schedules.listForUser(user(req).id),
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
  r.post(
    '/reports/:id/schedules',
    h(async (req, res) => {
      const body = scheduleInputSchema.parse(req.body);
      const { report } = await d.access.require(user(req), reportId(req), 'EDIT');
      const p = prepareSchedule(report, body);
      res
        .status(201)
        .json({ schedule: await d.schedules.create(report.id, user(req).id, p.input, p.next) });
    }),
  );
  r.put(
    '/schedules/:id',
    h(async (req, res) => {
      const body = scheduleInputSchema
        .extend({ version: z.number().int().positive() })
        .parse(req.body);
      const { s, report } = await loadSchedule(req);
      const p = prepareSchedule(report, body);
      res.json({ schedule: await d.schedules.update(s.id, p.input, p.next, body.version) });
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
      const result = await d.scheduler.run(s);
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
