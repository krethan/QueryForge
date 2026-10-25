import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import { openJob, reportingJdbcOptions, defaultJobFactory } from '../db/mapepire.js';
import type { JobFactory, QueryLike, QueryResult, SqlJobLike } from '../db/types.js';
import { AppError, toDbError } from '../util/errors.js';
import { Semaphore } from '../util/semaphore.js';
import { normalizeRow, toColumns, type Cell, type ResultColumn } from './results.js';
import { validateReportingSql } from './validator.js';
import { ResultCursorStore, type CursorCloseReason, type CursorEntry } from './cursors.js';
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

/** First page of an interactive run, plus a server-side cursor when more rows remain. */
export interface PagedOutcome extends ExecutionOutcome {
  /** More rows can be fetched with fetchPage(cursor.id). */
  hasMore: boolean;
  cursor?: { id: string; expiresAt: string; pageSize: number };
  /** Set when more rows exist but no cursor could be kept open (server cursor limit reached). */
  pagingUnavailable?: boolean;
}

export interface PageOutcome {
  cursorId: string;
  rows: Cell[][];
  /** Rows delivered so far through this cursor, including this page. */
  rowCount: number;
  hasMore: boolean;
  truncated: boolean;
  expiresAt?: string;
}

export interface PagedHooks {
  /** Called once when the cursor is finally closed, with the total rows delivered. */
  onClose?: (info: {
    rowCount: number;
    truncated: boolean;
    reason: CursorCloseReason;
  }) => void | Promise<void>;
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
  readonly cursors: ResultCursorStore;

  constructor(
    private readonly cfg: AppConfig,
    private readonly factory: JobFactory = defaultJobFactory,
  ) {
    this.gate = new Semaphore(cfg.limits.maxConcurrentExecutions);
    this.cursors = new ResultCursorStore({
      idleTtlMs: cfg.limits.cursorIdleTtlMs,
      maxLifetimeMs: cfg.limits.cursorMaxLifetimeMs,
      maxOpen: cfg.limits.maxOpenCursors,
      maxOpenPerUser: cfg.limits.maxOpenCursorsPerUser,
    });
    this.cursors.start();
  }

  /** Close every open cursor (shutdown). */
  async shutdown(): Promise<void> {
    await this.cursors.closeAll();
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
    /**
     * Interactive paging: read only the first `pageSize` rows and, when more remain,
     * hand the open job + query to `keep` instead of closing them. `keep` returns
     * false when it could not take ownership (the job is then closed here).
     */
    paging?: {
      pageSize: number;
      keep: (
        job: SqlJobLike,
        query: QueryLike,
        columns: ResultColumn[],
        rowCount: number,
      ) => Promise<boolean>;
    },
  ): Promise<Omit<ExecutionOutcome, 'columns' | 'rows'> & { hasMore?: boolean; kept?: boolean }> {
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
    let kept = false;
    let hasMore = false;
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
      const batch = paging ? paging.pageSize : this.cfg.limits.fetchBatchSize;
      const want = () => Math.max(1, Math.min(batch, maxRows + 1 - rowCount));
      let res: QueryResult<unknown> = await guarded(query.execute(want()));
      if (!res.success) throw res;
      const columns = toColumns(res.metadata?.columns);
      await handlers.onColumns(columns);
      if (paging) {
        dbMs += res.execution_time ?? 0;
        const data = (res.data ?? []).slice(0, maxRows).map((r) => normalizeRow(r, columns));
        rowCount = data.length;
        if (data.length) await handlers.onRows(data);
        const more = !res.is_done && !!res.has_results;
        if (more && rowCount < maxRows && !entry.cancelled && !timedOut) {
          kept = await paging.keep(job, query, columns, rowCount);
          hasMore = kept;
        }
        truncated = more && !kept;
        return {
          executionId,
          rowCount,
          truncated,
          maxRows,
          hasMore,
          kept,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          dbExecutionMs: dbMs || undefined,
        };
      }
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
      if (!kept) {
        if (query) await query.close().catch(() => undefined);
        if (job) await job.close().catch(() => undefined);
      }
      release();
    }
  }

  /**
   * Interactive run: first page now, the rest on demand through a short-lived
   * server-side cursor (see ResultCursorStore). Never reads past maxRows.
   */
  async openPaged(
    sql: string,
    ownerId: string,
    opts: {
      executionId?: string;
      parameters?: (string | number | null)[];
      pageSize?: number;
      maxRows?: number;
    } & PagedHooks = {},
  ): Promise<PagedOutcome> {
    const rows: Cell[][] = [];
    let columns: ResultColumn[] = [];
    const maxRows = opts.maxRows ?? this.cfg.limits.maxResultRows;
    const pageSize = Math.max(
      1,
      Math.min(opts.pageSize ?? this.cfg.limits.resultPageSize, maxRows),
    );
    const executionId = opts.executionId ?? randomUUID();
    let entry: CursorEntry | null = null;
    let wanted = false;
    const meta = await this.stream(
      sql,
      ownerId,
      maxRows,
      { onColumns: (c) => void (columns = c), onRows: (r) => void rows.push(...r) },
      executionId,
      opts.parameters,
      {
        pageSize,
        keep: async (job, query, cols, rowCount) => {
          wanted = true;
          entry = await this.cursors.add({
            ownerId,
            executionId,
            job,
            query,
            columns: cols,
            rowCount,
            maxRows,
            onClose: opts.onClose
              ? (e, reason) =>
                  opts.onClose!({
                    rowCount: e.rowCount,
                    truncated: reason !== 'COMPLETE',
                    reason,
                  })
              : undefined,
          });
          return entry !== null;
        },
      },
    );
    const kept = entry as CursorEntry | null;
    const { kept: _internal, ...rest } = meta;
    void _internal;
    return {
      ...rest,
      columns,
      rows,
      hasMore: !!kept,
      cursor: kept
        ? { id: kept.id, expiresAt: new Date(kept.expiresAt).toISOString(), pageSize }
        : undefined,
      pagingUnavailable: wanted && !kept ? true : undefined,
    };
  }

  /** Fetch the next page of a cursor owned by the user (Query.fetchMore). */
  async fetchPage(cursorId: string, ownerId: string, pageSize?: number): Promise<PageOutcome> {
    const e = this.cursors.checkout(cursorId, ownerId);
    const n = Math.max(
      1,
      Math.min(
        pageSize ?? this.cfg.limits.resultPageSize,
        this.cfg.limits.resultPageSize,
        e.maxRows - e.rowCount,
      ),
    );
    let release: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      release = await this.gate.acquire();
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () =>
            rej(new AppError(504, 'TIMEOUT', 'Fetching the next page exceeded the time limit.')),
          this.cfg.limits.queryTimeoutMs,
        );
      });
      const res = await Promise.race([e.query.fetchMore(n), timeout]);
      if (!res.success) throw res;
      const rows = (res.data ?? []).slice(0, n).map((r) => normalizeRow(r, e.columns));
      e.rowCount += rows.length;
      const done = !!res.is_done || !res.has_results || rows.length === 0;
      const limit = !done && e.rowCount >= e.maxRows;
      if (done || limit) {
        await this.cursors.close(e.id, done ? 'COMPLETE' : 'LIMIT');
        return { cursorId, rows, rowCount: e.rowCount, hasMore: false, truncated: limit };
      }
      this.cursors.checkin(e);
      return {
        cursorId,
        rows,
        rowCount: e.rowCount,
        hasMore: true,
        truncated: false,
        expiresAt: new Date(e.expiresAt).toISOString(),
      };
    } catch (err) {
      // a failed or timed-out fetch leaves the job in an unknown state: never reuse it
      await this.cursors.close(e.id, 'ERROR');
      if (err instanceof AppError) throw err;
      throw toDbError(err, 'SQL_ERROR');
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }

  closeCursor(cursorId: string, ownerId: string): Promise<boolean> {
    return this.cursors.closeOwned(cursorId, ownerId);
  }
}
