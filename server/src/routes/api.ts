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
} from '../reports/parameters.js';
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
import type { QueryExecutor } from '../sql/executor.js';
import type { MetadataDb } from '../db/types.js';
import { AppError, DbError, sanitizeErrorMessage } from '../util/errors.js';

export interface ApiDeps {
  cfg: AppConfig;
  sessions: SessionService;
  users: UserRepository;
  reports: ReportRepository;
  history: HistoryRepository;
  execution: ExecutionService;
  executor: QueryExecutor;
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
const exportSchema = z.object({
  sql: z.string().optional(),
  reportId: uuid.optional(),
  name: z.string().max(128).optional(),
  parameters: parameterListSchema.optional(),
  values: parameterValuesSchema.optional(),
});

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
      res.setHeader('X-QF-Row-Count', String(file.rowCount));
      res.setHeader('X-QF-Truncated', String(file.truncated));
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-QF-Row-Count, X-QF-Truncated, Content-Disposition',
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
  r.post(
    '/reports',
    h(async (req, res) => {
      const input = reportInputSchema.parse(req.body);
      checkLength(input.sql);
      res
        .status(201)
        .json({ report: { ...(await d.reports.create(user(req).id, input)), access: 'OWNER' } });
    }),
  );
  r.get(
    '/reports/:id',
    h(async (req, res) => {
      const { report, access } = await d.access.require(user(req), reportId(req), 'VIEW');
      res.json({ report: { ...report, access } });
    }),
  );
  r.put(
    '/reports/:id',
    h(async (req, res) => {
      const input = reportUpdateSchema.parse(req.body);
      checkLength(input.sql);
      const { report, access } = await d.access.require(user(req), reportId(req), 'EDIT');
      const updated = await d.reports.update(report.ownerId, report.id, input);
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
