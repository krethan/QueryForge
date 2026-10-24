import { readFileSync } from 'node:fs';
import { SQLJob } from '@ibm/mapepire-js';
import type { AppConfig, DbIdentity } from '../config/config.js';
import { AppError, toDbError } from '../util/errors.js';
import type { DaemonServer, JDBCOptions, JobFactory, MetadataDb, SqlJobLike } from './types.js';

export const APPLICATION_NAME = 'IBM i Query Reports';

export const defaultJobFactory: JobFactory = (options) =>
  new SQLJob(options) as unknown as SqlJobLike;

export function daemonServer(cfg: AppConfig, identity: DbIdentity): DaemonServer {
  return {
    host: cfg.mapepire.host,
    port: cfg.mapepire.port,
    user: identity.user,
    password: identity.password,
    rejectUnauthorized: cfg.mapepire.rejectUnauthorized,
    ca: cfg.mapepire.caFile ? readFileSync(cfg.mapepire.caFile) : undefined,
  };
}

/** JDBC options for the reporting identity. `access: read only` is a toolbox-level guard on top of IBM i object authority. */
export function reportingJdbcOptions(cfg: AppConfig): JDBCOptions {
  const libs = [
    ...(cfg.reporting.defaultSchema ? [cfg.reporting.defaultSchema] : []),
    ...cfg.reporting.libraries,
  ];
  return {
    naming: cfg.reporting.naming,
    ...(libs.length ? { libraries: Array.from(new Set(libs)) } : {}),
    access: 'read only',
    'auto commit': true,
    'date format': 'iso',
    'time format': 'iso',
    errors: 'full',
    'translate binary': false,
  };
}

export function metadataJdbcOptions(cfg: AppConfig, autoCommit = true): JDBCOptions {
  return {
    naming: 'sql',
    libraries: [cfg.metadata.schema],
    'date format': 'iso',
    'time format': 'iso',
    'auto commit': autoCommit,
    ...(autoCommit ? {} : { 'transaction isolation': 'read committed' as const }),
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new AppError(504, 'TIMEOUT', `Operation exceeded ${ms} ms`));
    }, ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Open and connect a fresh Mapepire job for an identity. Caller owns close(). */
export async function openJob(
  cfg: AppConfig,
  identity: DbIdentity,
  options: JDBCOptions,
  factory: JobFactory = defaultJobFactory,
): Promise<SqlJobLike> {
  const job = factory(options);
  try {
    await withTimeout(
      job.connect(daemonServer(cfg, identity), APPLICATION_NAME),
      cfg.limits.connectTimeoutMs,
      () => {
        void job.close().catch(() => undefined);
      },
    );
    return job;
  } catch (err) {
    await job.close().catch(() => undefined);
    if (err instanceof AppError && err.code === 'TIMEOUT')
      throw new AppError(503, 'CONNECTION_ERROR', 'Timed out connecting to the Mapepire server');
    throw toDbError(err, 'CONNECTION_ERROR');
  }
}

/**
 * Metadata access over Mapepire. Uses a small set of reusable SQLJobs owned
 * by this class (rather than mapepire's Pool, whose jobs cannot be health-checked
 * from outside) so broken jobs can be discarded and reconnected transparently.
 */
export class MapepireMetadataDb implements MetadataDb {
  private idle: SqlJobLike[] = [];
  private open = 0;
  private waiters: Array<(j: SqlJobLike | null) => void> = [];

  constructor(
    private readonly cfg: AppConfig,
    private readonly factory: JobFactory = defaultJobFactory,
  ) {}

  private async acquire(): Promise<SqlJobLike> {
    const j = this.idle.pop();
    if (j) return j;
    if (this.open < this.cfg.metadata.poolSize) {
      this.open++;
      try {
        return await openJob(
          this.cfg,
          this.cfg.metadata,
          metadataJdbcOptions(this.cfg),
          this.factory,
        );
      } catch (e) {
        this.open--;
        throw e;
      }
    }
    const next = await new Promise<SqlJobLike | null>((r) => this.waiters.push(r));
    return next ?? this.acquire();
  }

  private release(job: SqlJobLike, broken: boolean) {
    if (broken) {
      this.open--;
      void job.close().catch(() => undefined);
      const w = this.waiters.shift();
      if (w) w(null);
      return;
    }
    const w = this.waiters.shift();
    if (w) w(job);
    else this.idle.push(job);
  }

  private async run<R>(fn: (job: SqlJobLike) => Promise<R>, retry = true): Promise<R> {
    const job = await this.acquire();
    try {
      const r = await withTimeout(fn(job), this.cfg.limits.queryTimeoutMs);
      this.release(job, false);
      return r;
    } catch (err) {
      const dbErr = toDbError(err);
      const broken =
        dbErr.code === 'CONNECTION_ERROR' || (err instanceof AppError && err.code === 'TIMEOUT');
      this.release(job, broken);
      if (broken && retry) return this.run(fn, false); // one reconnect attempt
      throw dbErr;
    }
  }

  async query<T>(sql: string, params: (string | number | null)[] = []): Promise<T[]> {
    return this.run(async (job) => {
      const res = await job.execute<T>(sql, params.length ? { parameters: params } : undefined);
      return res.data ?? [];
    });
  }

  async update(sql: string, params: (string | number | null)[] = []): Promise<number> {
    return this.run(async (job) => {
      const res = await job.execute(sql, params.length ? { parameters: params } : undefined);
      return res.update_count ?? 0;
    });
  }

  async transaction<R>(fn: (tx: Omit<MetadataDb, 'transaction'>) => Promise<R>): Promise<R> {
    const job = await openJob(
      this.cfg,
      this.cfg.metadata,
      metadataJdbcOptions(this.cfg, false),
      this.factory,
    );
    const tx: Omit<MetadataDb, 'transaction'> = {
      query: async <T>(sql: string, params: (string | number | null)[] = []) =>
        ((await job.execute<T>(sql, params.length ? { parameters: params } : undefined)).data ??
          []) as T[],
      update: async (sql, params = []) =>
        (await job.execute(sql, params.length ? { parameters: params } : undefined)).update_count ??
        0,
      ping: async () => undefined,
      close: async () => undefined,
    };
    try {
      const r = await fn(tx);
      if (job.endTransaction) await job.endTransaction('COMMIT');
      else await job.execute('COMMIT');
      return r;
    } catch (err) {
      try {
        if (job.endTransaction) await job.endTransaction('ROLLBACK');
        else await job.execute('ROLLBACK');
      } catch {
        /* job will be closed */
      }
      throw err instanceof AppError ? err : toDbError(err);
    } finally {
      await job.close().catch(() => undefined);
    }
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1 AS OK FROM SYSIBM.SYSDUMMY1');
  }

  async close(): Promise<void> {
    const jobs = this.idle.splice(0);
    this.open -= jobs.length;
    await Promise.all(jobs.map((j) => j.close().catch(() => undefined)));
  }
}
