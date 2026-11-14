import { FolderRepository } from './reports/folders.js';
import { TileOrderRepository } from './reports/tile-order.js';
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
import { CatalogService } from './catalog/catalog.js';
import type { JobFactory, MetadataDb } from './db/types.js';
import { apiRouter, errorHandler } from './routes/api.js';
import { OpenIdClientProvider, type OidcProvider } from './auth/oidc.js';
import { LdaptsAuthenticator, type LdapAuthenticator } from './auth/ldap.js';
import { SmtpMailer, type Mailer } from './mail/mailer.js';
import { Scheduler } from './scheduler/scheduler.js';
import { ScheduleRepository } from './scheduler/schedules.js';
import { RecipientService } from './scheduler/recipients.js';
import { AccessService } from './sharing/access.js';
import { GroupRepository } from './sharing/groups.js';
import { FolderAccessService } from './sharing/folder-access.js';
import { FolderReportGrants } from './sharing/folder-report-grants.js';
import { systemClock, type Clock } from './sharing/expiry.js';
import { ShareNotifier } from './notifications/share-notifier.js';
import { UserSettingsRepository } from './notifications/settings.js';
import { NotificationInbox } from './notifications/inbox.js';
import { RetentionService } from './retention/retention.js';

export interface AppOptions {
  cfg: AppConfig;
  metadataDb: MetadataDb;
  jobFactory?: JobFactory;
  staticDir?: string;
  /** Override providers (tests / demo mode). Defaults are built from configuration. */
  oidc?: OidcProvider | null;
  ldap?: LdapAuthenticator | null;
  mailer?: Mailer | null;
  /**
   * Where "now" comes from for share expiry checks (migration 014). Tests pass a movable clock;
   * defaults to the system clock.
   */
  clock?: Clock;
}

export function createApp({ cfg, metadataDb, jobFactory, staticDir, ...o }: AppOptions) {
  const clock = o.clock ?? systemClock;
  const sessions = new SessionService(cfg);
  const users = new UserRepository(metadataDb, cfg.metadata.schema);
  const reports = new ReportRepository(metadataDb, cfg.metadata.schema, clock);
  const history = new HistoryRepository(metadataDb, cfg.metadata.schema);
  const executor = new QueryExecutor(cfg, jobFactory);
  const catalog = new CatalogService(cfg, executor);
  const groups = new GroupRepository(metadataDb, cfg.metadata.schema);
  const folders = new FolderRepository(metadataDb, cfg.metadata.schema);
  const folderAccess = new FolderAccessService(
    metadataDb,
    cfg.metadata.schema,
    folders,
    groups,
    clock,
  );
  const folderGrants = new FolderReportGrants(metadataDb, cfg.metadata.schema, folderAccess, clock);
  const access = new AccessService(
    metadataDb,
    cfg.metadata.schema,
    reports,
    groups,
    folderGrants,
    clock,
  );
  const execution = new ExecutionService(cfg, executor, access, history);
  const schedules = new ScheduleRepository(metadataDb, cfg.metadata.schema, clock);
  const tileOrder = new TileOrderRepository(metadataDb, cfg.metadata.schema);
  const pick = <T>(v: T | null | undefined, make: () => T | undefined) =>
    v === null ? undefined : (v ?? make());
  const oidc = pick(o.oidc, () =>
    cfg.auth.oidc ? new OpenIdClientProvider(cfg.auth.oidc) : undefined,
  );
  const ldap = pick(o.ldap, () =>
    cfg.auth.ldap ? new LdaptsAuthenticator(cfg.auth.ldap) : undefined,
  );
  const mailer = pick(o.mailer, () => (cfg.smtp ? new SmtpMailer(cfg.smtp) : undefined));
  const recipients = new RecipientService(
    metadataDb,
    cfg.metadata.schema,
    users,
    access,
    cfg.scheduler,
    folderGrants,
    clock,
  );
  const userSettings = new UserSettingsRepository(metadataDb, cfg.metadata.schema);
  const notifier = new ShareNotifier(metadataDb, cfg.metadata.schema, cfg, mailer, clock);
  const inbox = new NotificationInbox(
    metadataDb,
    cfg.metadata.schema,
    { reports, access, folderAccess, groups },
    { soonDays: cfg.notifications.reminderDays },
    clock,
  );
  const retention = new RetentionService(metadataDb, cfg.metadata.schema, cfg.retention, clock);
  const scheduler = new Scheduler(
    cfg,
    schedules,
    users,
    access,
    execution,
    mailer,
    recipients,
    notifier,
    retention,
  );

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
    apiRouter({
      cfg,
      sessions,
      users,
      reports,
      history,
      execution,
      executor,
      catalog,
      metadataDb,
      access,
      groups,
      schedules,
      folders,
      folderAccess,
      folderGrants,
      tileOrder,
      scheduler,
      recipients,
      mailer,
      notifier,
      userSettings,
      inbox,
      retention,
      oidc,
      ldap,
    }),
  );
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }
  app.use(errorHandler);
  return {
    app,
    executor,
    catalog,
    execution,
    reports,
    history,
    users,
    sessions,
    groups,
    access,
    schedules,
    folders,
    folderAccess,
    folderGrants,
    tileOrder,
    scheduler,
    recipients,
    mailer,
    notifier,
    userSettings,
    inbox,
    retention,
  };
}
