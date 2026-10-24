import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import type { AppConfig } from './config/config.js';
import { SessionService } from './auth/session.js';
import { UserRepository } from './auth/users.js';
import { HistoryRepository } from './history/history.js';
import { ReportRepository } from './reports/reports.js';
import { ExecutionService } from './sql/execution-service.js';
import { QueryExecutor } from './sql/executor.js';
import type { JobFactory, MetadataDb } from './db/types.js';
import { apiRouter, errorHandler } from './routes/api.js';

export interface AppOptions {
  cfg: AppConfig;
  metadataDb: MetadataDb;
  jobFactory?: JobFactory;
  staticDir?: string;
}

export function createApp({ cfg, metadataDb, jobFactory, staticDir }: AppOptions) {
  const sessions = new SessionService(cfg);
  const users = new UserRepository(metadataDb, cfg.metadata.schema);
  const reports = new ReportRepository(metadataDb, cfg.metadata.schema);
  const history = new HistoryRepository(metadataDb, cfg.metadata.schema);
  const executor = new QueryExecutor(cfg, jobFactory);
  const execution = new ExecutionService(cfg, executor, reports, history);

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: `${Math.ceil((cfg.limits.maxQueryLength * 4) / 1024) + 16}kb` }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    apiRouter({ cfg, sessions, users, reports, history, execution, executor, metadataDb }),
  );
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }
  app.use(errorHandler);
  return { app, executor, execution, reports, history, users, sessions };
}
