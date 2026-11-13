import type { MetadataDb } from '../db/types.js';
import { T, q, toDbTimestamp } from '../db/schema.js';
import { systemClock, type Clock } from '../sharing/expiry.js';
import { sanitizeErrorMessage } from '../util/errors.js';

/**
 * History retention: deletes old rows from the metadata history tables so they stop growing for
 * ever. No migration is needed: it only issues DELETEs on existing tables.
 *
 * What it may touch, and nothing else (RETENTION_TABLES below is the whole list):
 *   QF_SCHEDULE_DELIVERIES  delivery attempts (010) by STARTED_AT
 *   QF_SHARE_REMINDERS      expiry reminders sent (015) by the share end date (EXPIRES_AT)
 *   QF_EXECUTIONS           report runs and exports (001) by STARTED_AT, never a RUNNING row
 *   QF_SHARE_AUDIT, QF_FOLDER_SHARE_AUDIT, QF_FOLDER_DELETIONS  compliance records, only when
 *                           QF_RETAIN_AUDIT_DAYS is set (default 0: kept for ever)
 * Reports, shares, schedules, folders, users and QF_SCHEMA_VERSION are never deleted from.
 *
 * Reminder rows are the "already reminded" claim for (share, end date): the scheduler only looks
 * at shares whose EXPIRES_AT is still in the future (ShareNotifier.pendingReminders), so a row
 * whose EXPIRES_AT is in the past can never be needed again. Retention only deletes reminder rows
 * whose EXPIRES_AT is at least QF_RETAIN_REMINDER_DAYS (7 or more) in the past, so removing one
 * can never let a reminder for a still-future end date be sent twice.
 *
 * Deletes go in bounded batches: one statement removes at most `batchSize` rows, chosen by a
 * FETCH FIRST subselect on the primary key, so no statement holds locks on a large part of a
 * table. Each statement commits on its own (the metadata connection autocommits). Running it on
 * two instances at once is harmless: both delete the same old rows and the second finds none.
 */

export type RetentionKey =
  'deliveries' | 'reminders' | 'executions' | 'shareAudit' | 'folderShareAudit' | 'folderDeletions';

/** Retention periods in days; 0 keeps rows for ever. */
export interface RetentionConfig {
  deliveryDays: number;
  reminderDays: number;
  executionDays: number;
  auditDays: number;
  /** Rows per DELETE statement. */
  batchSize: number;
  /** DELETE statements per table per run; whatever is left goes on the next run. */
  maxBatches: number;
}

interface TableSpec {
  key: RetentionKey;
  table: string;
  label: string;
  idColumn: string;
  timeColumn: string;
  /** Extra condition (constant SQL, no user input). */
  extra?: string;
  days: (c: RetentionConfig) => number;
  group: 'history' | 'audit';
}

export const RETENTION_TABLES: readonly TableSpec[] = [
  {
    key: 'deliveries',
    table: T.scheduleDeliveries,
    label: 'Scheduled delivery history',
    idColumn: 'DELIVERY_ID',
    timeColumn: 'STARTED_AT',
    days: (c) => c.deliveryDays,
    group: 'history',
  },
  {
    key: 'reminders',
    table: T.shareReminders,
    label: 'Share expiry reminders sent (by share end date)',
    idColumn: 'REMINDER_ID',
    timeColumn: 'EXPIRES_AT',
    days: (c) => c.reminderDays,
    group: 'history',
  },
  {
    key: 'executions',
    table: T.executions,
    label: 'Report run history',
    idColumn: 'EXECUTION_ID',
    timeColumn: 'STARTED_AT',
    extra: "STATUS <> 'RUNNING'",
    days: (c) => c.executionDays,
    group: 'history',
  },
  {
    key: 'shareAudit',
    table: T.shareAudit,
    label: 'Report sharing audit',
    idColumn: 'AUDIT_ID',
    timeColumn: 'OCCURRED_AT',
    days: (c) => c.auditDays,
    group: 'audit',
  },
  {
    key: 'folderShareAudit',
    table: T.folderShareAudit,
    label: 'Folder sharing audit',
    idColumn: 'AUDIT_ID',
    timeColumn: 'OCCURRED_AT',
    days: (c) => c.auditDays,
    group: 'audit',
  },
  {
    key: 'folderDeletions',
    table: T.folderDeletions,
    label: 'Folder deletion records',
    idColumn: 'DELETION_ID',
    timeColumn: 'DELETED_AT',
    days: (c) => c.auditDays,
    group: 'audit',
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Automatic runs happen at most this often per instance. */
export const RETENTION_INTERVAL_MS = DAY_MS;
/** Reminder rows are never deleted unless their share end date is at least this far past. */
export const MIN_REMINDER_AGE_MS = DAY_MS;

export interface RetentionSetting {
  key: RetentionKey;
  table: string;
  label: string;
  group: 'history' | 'audit';
  /** 0 = kept for ever. */
  days: number;
}

export interface RetentionTableResult {
  key: RetentionKey;
  table: string;
  days: number;
  /** Rows older than this (UTC, ISO-8601) were deleted; null when kept for ever. */
  cutoff: string | null;
  deleted: number;
  batches: number;
  /** False when the batch limit was reached and older rows are left for the next run. */
  complete: boolean;
  error: string | null;
}

export interface RetentionRun {
  trigger: 'SCHEDULE' | 'MANUAL';
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string;
  deleted: number;
  tables: RetentionTableResult[];
}

export class RetentionRunningError extends Error {
  constructor() {
    super('A retention run is already in progress.');
  }
}

export class RetentionService {
  private running: Promise<RetentionRun> | null = null;
  private last: RetentionRun | null = null;
  /** When the last run started (ms); drives the once-a-day automatic run. */
  private lastStartedMs: number | null = null;

  constructor(
    private readonly db: MetadataDb,
    private readonly schema: string,
    private readonly cfg: RetentionConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  settings(): RetentionSetting[] {
    return RETENTION_TABLES.map((t) => ({
      key: t.key,
      table: t.table,
      label: t.label,
      group: t.group,
      days: t.days(this.cfg),
    }));
  }

  get batchSize() {
    return this.cfg.batchSize;
  }
  get maxBatches() {
    return this.cfg.maxBatches;
  }
  get lastRun(): RetentionRun | null {
    return this.last;
  }
  get isRunning(): boolean {
    return this.running !== null;
  }
  /** Earliest time the next automatic run may start (ISO), or null before the first run. */
  get nextAutomaticAfter(): string | null {
    return this.lastStartedMs === null
      ? null
      : new Date(this.lastStartedMs + RETENTION_INTERVAL_MS).toISOString();
  }

  /** Nothing to prune at all (every period is 0). */
  get keepsEverything(): boolean {
    return RETENTION_TABLES.every((t) => t.days(this.cfg) <= 0);
  }

  /**
   * The scheduler leader calls this on every poll; it runs at most once per
   * RETENTION_INTERVAL_MS per instance (in memory, so a restart runs it again, which is
   * harmless). Never throws. Returns the run, or null when not due / already running.
   */
  async runIfDue(now: Date = this.clock()): Promise<RetentionRun | null> {
    if (this.running || this.keepsEverything) return null;
    if (this.lastStartedMs !== null && now.getTime() - this.lastStartedMs < RETENTION_INTERVAL_MS)
      return null;
    try {
      return await this.run({ trigger: 'SCHEDULE', now });
    } catch (e) {
      if (e instanceof RetentionRunningError) return null;
      console.error('history retention failed:', sanitizeErrorMessage(e));
      return null;
    }
  }

  /** Run now. Throws RetentionRunningError when a run is already in progress. */
  run(
    opts: { trigger?: 'SCHEDULE' | 'MANUAL'; requestedBy?: string | null; now?: Date } = {},
  ): Promise<RetentionRun> {
    if (this.running) return Promise.reject(new RetentionRunningError());
    const now = opts.now ?? this.clock();
    this.lastStartedMs = now.getTime();
    const p = this.doRun(now, opts.trigger ?? 'MANUAL', opts.requestedBy ?? null).finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  /** Resolves when no run is in progress (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  /** The cutoff for one table at `now`, or null when that table is kept for ever. */
  cutoffFor(key: RetentionKey, now: Date): Date | null {
    const spec = RETENTION_TABLES.find((t) => t.key === key);
    const days = spec ? spec.days(this.cfg) : 0;
    if (!spec || !(days > 0)) return null;
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    // Defence in depth for reminder idempotency (see the header): never a cutoff in the future
    // or the last day, whatever the configuration says.
    if (key === 'reminders' && cutoff.getTime() > now.getTime() - MIN_REMINDER_AGE_MS) return null;
    return cutoff;
  }

  /** The batched DELETE for one table. Exposed for tests and the verification kit. */
  deleteSql(spec: TableSpec): string {
    const t = q(this.schema, spec.table);
    const where = `${spec.timeColumn} < CAST(? AS TIMESTAMP)${spec.extra ? ` AND ${spec.extra}` : ''}`;
    return `DELETE FROM ${t} WHERE ${spec.idColumn} IN (SELECT ${spec.idColumn} FROM ${t} WHERE ${where} FETCH FIRST ${this.cfg.batchSize} ROWS ONLY)`;
  }

  /** How many rows a run at `now` would delete, per table (read-only; verification kit). */
  async countEligible(now: Date = this.clock()): Promise<Partial<Record<RetentionKey, number>>> {
    const out: Partial<Record<RetentionKey, number>> = {};
    for (const spec of RETENTION_TABLES) {
      const cutoff = this.cutoffFor(spec.key, now);
      if (!cutoff) continue;
      const rows = await this.db.query<{ N: number }>(
        `SELECT COUNT(*) AS N FROM ${q(this.schema, spec.table)} WHERE ${spec.timeColumn} < CAST(? AS TIMESTAMP)${spec.extra ? ` AND ${spec.extra}` : ''}`,
        [toDbTimestamp(cutoff)],
      );
      out[spec.key] = Number(rows[0]?.N ?? 0);
    }
    return out;
  }

  private async doRun(
    now: Date,
    trigger: 'SCHEDULE' | 'MANUAL',
    requestedBy: string | null,
  ): Promise<RetentionRun> {
    const startedAt = new Date().toISOString();
    const tables: RetentionTableResult[] = [];
    for (const spec of RETENTION_TABLES) {
      const days = spec.days(this.cfg);
      const cutoff = this.cutoffFor(spec.key, now);
      const r: RetentionTableResult = {
        key: spec.key,
        table: spec.table,
        days,
        cutoff: cutoff ? cutoff.toISOString() : null,
        deleted: 0,
        batches: 0,
        complete: true,
        error: null,
      };
      tables.push(r);
      if (!cutoff) continue;
      const sql = this.deleteSql(spec);
      const param = toDbTimestamp(cutoff);
      try {
        for (;;) {
          if (r.batches >= this.cfg.maxBatches) {
            r.complete = false;
            break;
          }
          const n = Math.max(0, Number(await this.db.update(sql, [param])) || 0);
          r.batches++;
          r.deleted += n;
          if (n < this.cfg.batchSize) break;
        }
      } catch (e) {
        r.error = sanitizeErrorMessage(e);
        r.complete = false;
        console.error(`history retention: ${spec.table}: ${r.error}`);
      }
    }
    const run: RetentionRun = {
      trigger,
      requestedBy,
      startedAt,
      finishedAt: new Date().toISOString(),
      deleted: tables.reduce((s, t) => s + t.deleted, 0),
      tables,
    };
    this.last = run;
    const counts = tables
      .filter((t) => t.cutoff)
      .map((t) => `${t.table} ${t.deleted}${t.complete ? '' : '+'}${t.error ? ' (error)' : ''}`)
      .join(', ');
    console.log(
      `history retention (${trigger.toLowerCase()}${requestedBy ? ` by ${requestedBy}` : ''}): deleted ${run.deleted} row(s)${counts ? `: ${counts}` : ''}`,
    );
    return run;
  }
}
