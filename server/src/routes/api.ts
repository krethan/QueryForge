import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z, ZodError } from 'zod';
import type { AppConfig } from '../config/config.js';
import type { SessionService } from '../auth/session.js';
import type { UserRepository } from '../auth/users.js';
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
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const uuid = z.string().uuid();
const executeSchema = z.object({ sql: z.string(), executionId: uuid.optional() });
const exportSchema = z.object({
  sql: z.string().optional(),
  reportId: uuid.optional(),
  name: z.string().max(128).optional(),
});

export function apiRouter(d: ApiDeps): Router {
  const r = Router();
  const { cfg, sessions } = d;
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
        .object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) })
        .parse(req.body);
      const user = await d.users.verifyCredentials(body.username, body.password);
      if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
      const s = await sessions.issue(res, user);
      res.json({ user, expiresAt: new Date(s.expiresAt).toISOString() });
    }),
  );

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
      res.json({ user: s.user, expiresAt: new Date(expiresAt).toISOString() });
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
        await d.execution.runAdhoc(req.session!.user, body.sql, body.executionId ?? randomUUID()),
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
      const file = await d.execution.exportXlsx(req.session!.user, body);
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

  // ---- saved reports ----
  r.get(
    '/reports',
    h(async (req, res) => {
      const sort = (['name', 'created', 'lastRun', 'updated'] as const).includes(
        req.query.sort as SortKey,
      )
        ? (req.query.sort as SortKey)
        : 'name';
      const reports = await d.reports.list(req.session!.user.id, {
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 128) : undefined,
        category:
          typeof req.query.category === 'string' ? req.query.category.slice(0, 128) : undefined,
        sort,
      });
      res.json({ reports });
    }),
  );
  r.post(
    '/reports',
    h(async (req, res) => {
      const input = reportInputSchema.parse(req.body);
      if (input.sql.length > cfg.limits.maxQueryLength)
        throw new AppError(400, 'SQL_TOO_LONG', 'Query is too long.');
      res.status(201).json({ report: await d.reports.create(req.session!.user.id, input) });
    }),
  );
  r.get(
    '/reports/:id',
    h(async (req, res) => {
      res.json({ report: await d.reports.get(req.session!.user.id, uuid.parse(req.params.id)) });
    }),
  );
  r.put(
    '/reports/:id',
    h(async (req, res) => {
      const input = reportUpdateSchema.parse(req.body);
      if (input.sql.length > cfg.limits.maxQueryLength)
        throw new AppError(400, 'SQL_TOO_LONG', 'Query is too long.');
      res.json({
        report: await d.reports.update(req.session!.user.id, uuid.parse(req.params.id), input),
      });
    }),
  );
  r.delete(
    '/reports/:id',
    h(async (req, res) => {
      await d.reports.delete(req.session!.user.id, uuid.parse(req.params.id));
      res.status(204).end();
    }),
  );
  r.post(
    '/reports/:id/execute',
    execLimiter,
    h(async (req, res) => {
      const body = z.object({ executionId: uuid.optional() }).parse(req.body ?? {});
      res.json(
        await d.execution.runReport(
          req.session!.user,
          uuid.parse(req.params.id),
          body.executionId ?? randomUUID(),
        ),
      );
    }),
  );
  r.get(
    '/reports/:id/history',
    h(async (req, res) => {
      const id = uuid.parse(req.params.id);
      await d.reports.get(req.session!.user.id, id);
      res.json({
        executions: await d.history.list(req.session!.user.id, { reportId: id, limit: 50 }),
      });
    }),
  );
  r.get(
    '/history',
    h(async (req, res) => {
      res.json({
        executions: await d.history.list(req.session!.user.id, {
          limit: Number(req.query.limit) || 50,
        }),
      });
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
