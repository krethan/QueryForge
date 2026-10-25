import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import { openJob, reportingJdbcOptions, defaultJobFactory } from '../db/mapepire.js';
import type { JobFactory, QueryLike, QueryResult, SqlJobLike } from '../db/types.js';
import { AppError, toDbError } from '../util/errors.js';
import { Semaphore } from '../util/semaphore.js';
import { normalizeRow, toColumns, type Cell, type ResultColumn } from './results.js';
import { validateReportingSql } from './validator.js';
import { PROTECTED_METADATA_OBJECTS } from '../db/schema.js';

export interface ExecutionOutcome {
  executionId: string;
  columns: ResultColumn[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  dbExecutionMs?: number;
}

export interface StreamHandlers {
  onColumns(cols: ResultColumn[]): void | Promise<void>;
  onRows(rows: Cell[][]): void | Promise<void>;
}

interface RunningEntry {
  ownerId: string;
  job?: SqlJobLike;
  cancelled: boolean;
  cancel: () => void;
}

/**
 * Executes validated reporting SQL through a dedicated, short-lived Mapepire job
 * connected as the read-only reporting identity. A job is held only for the
 * duration of one execution and is always closed afterwards; closing the job ends
 * the server-side database job, which is how timeouts and cancellations stop work.
 */
export class QueryExecutor {
  private readonly gate: Semaphore;
  private readonly running = new Map<string, RunningEntry>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly factory: JobFactory = defaultJobFactory,
  ) {
    this.gate = new Semaphore(cfg.limits.maxConcurrentExecutions);
  }

  validate(sql: string) {
    const v = validateReportingSql(sql, {
      maxLength: this.cfg.limits.maxQueryLength,
      protectedSchemas: this.cfg.protectedSchemas,
      protectedObjects: PROTECTED_METADATA_OBJECTS,
      // markers are only ever bound as values; resolveParameters() checks count/types first
      allowParameterMarkers: true,
    });
    if (!v.ok) throw new AppError(400, v.code, v.message, { position: v.position });
    return v.sql;
  }

  get activeExecutions(): number {
    return this.gate.inUse;
  }

  /** Cancel a running execution owned by the user. Returns false if unknown or not owned. */
  cancel(executionId: string, ownerId: string): boolean {
    const e = this.running.get(executionId);
    if (!e || e.ownerId !== ownerId) return false;
    e.cancel();
    return true;
  }

  async run(
    sql: string,
    ownerId: string,
    opts: { executionId?: string; maxRows?: number; parameters?: (string | number | null)[] } = {},
  ): Promise<ExecutionOutcome> {
    const rows: Cell[][] = [];
    let columns: ResultColumn[] = [];
    const meta = await this.stream(
      sql,
      ownerId,
      opts.maxRows ?? this.cfg.limits.maxResultRows,
      {
        onColumns: (c) => {
          columns = c;
        },
        onRows: (r) => {
          rows.push(...r);
        },
      },
      opts.executionId,
      opts.parameters,
    );
    return { ...meta, columns, rows };
  }

  /**
   * Stream rows in batches (Query.execute + Query.fetchMore). Fetches at most
   * maxRows + 1 rows so truncation is reported precisely without reading further.
   */
  async stream(
    rawSql: string,
    ownerId: string,
    maxRows: number,
    handlers: StreamHandlers,
    executionId: string = randomUUID(),
    parameters?: (string | number | null)[],
  ): Promise<Omit<ExecutionOutcome, 'columns' | 'rows'>> {
    const sql = this.validate(rawSql);
    const release = await this.gate.acquire();
    const started = Date.now();
    const deadline = started + this.cfg.limits.queryTimeoutMs;
    let job: SqlJobLike | undefined;
    let query: QueryLike | undefined;
    let timedOut = false;
    let rejectAbort: (e: Error) => void = () => undefined;
    const aborted = new Promise<never>((_, rej) => (rejectAbort = rej));
    aborted.catch(() => undefined);
    const entry: RunningEntry = {
      ownerId,
      cancelled: false,
      cancel: () => {
        entry.cancelled = true;
        rejectAbort(new AppError(499, 'CANCELLED', 'The query was cancelled.'));
        void entry.job?.close().catch(() => undefined);
      },
    };
    this.running.set(executionId, entry);
    const timer = setTimeout(() => {
      timedOut = true;
      rejectAbort(
        new AppError(
          504,
          'TIMEOUT',
          `The query exceeded the ${Math.round(this.cfg.limits.queryTimeoutMs / 1000)} s time limit and was stopped.`,
        ),
      );
      void entry.job?.close().catch(() => undefined);
    }, this.cfg.limits.queryTimeoutMs);

    const guarded = <T>(p: Promise<T>) => Promise.race([p, aborted]);
    let rowCount = 0;
    let truncated = false;
    let dbMs = 0;
    try {
      job = await guarded(
        openJob(this.cfg, this.cfg.reporting, reportingJdbcOptions(this.cfg), this.factory),
      );
      entry.job = job;
      if (entry.cancelled || timedOut) await job.close();
      // Values are bound to `?` markers via Mapepire's prepared execution
      // (QueryOptions.parameters -> "prepare_sql_execute"); they never become SQL text.
      query = job.query<unknown>(
        sql,
        parameters?.length ? { isTerseResults: true, parameters } : { isTerseResults: true },
      );
      const batch = this.cfg.limits.fetchBatchSize;
      const want = () => Math.max(1, Math.min(batch, maxRows + 1 - rowCount));
      let res: QueryResult<unknown> = await guarded(query.execute(want()));
      if (!res.success) throw res;
      const columns = toColumns(res.metadata?.columns);
      await handlers.onColumns(columns);
      for (;;) {
        dbMs += res.execution_time ?? 0;
        let data = (res.data ?? []).map((r) => normalizeRow(r, columns));
        if (rowCount + data.length > maxRows) {
          data = data.slice(0, maxRows - rowCount);
          truncated = true;
        }
        rowCount += data.length;
        if (data.length) await handlers.onRows(data);
        if (truncated || res.is_done || !res.has_results) break;
        if (Date.now() > deadline)
          throw new AppError(504, 'TIMEOUT', 'Query time limit reached while fetching rows.');
        res = await guarded(query.fetchMore(want()));
        if (!res.success) throw res;
      }
      return {
        executionId,
        rowCount,
        truncated,
        maxRows,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        dbExecutionMs: dbMs || undefined,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (timedOut)
        throw new AppError(504, 'TIMEOUT', 'The query exceeded the time limit and was stopped.');
      if (entry.cancelled) throw new AppError(499, 'CANCELLED', 'The query was cancelled.');
      throw toDbError(err, 'SQL_ERROR');
    } finally {
      clearTimeout(timer);
      this.running.delete(executionId);
      if (query) await query.close().catch(() => undefined);
      if (job) await job.close().catch(() => undefined);
      release();
    }
  }
}
