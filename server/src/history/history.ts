import { createHash } from 'node:crypto';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import { dbTimestampToIso } from '../util/time.js';

export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

export interface ExecutionRecord {
  id: string;
  reportId: string | null;
  kind: 'RUN' | 'EXPORT';
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  rowCount: number | null;
  truncated: boolean;
  sqlState: string | null;
  errorMessage: string | null;
}

export interface FinishInfo {
  status: Exclude<RunStatus, 'RUNNING'>;
  elapsedMs: number;
  rowCount?: number | null;
  truncated?: boolean;
  sqlState?: string | null;
  sqlCode?: number | null;
  errorMessage?: string | null;
}

/**
 * Execution history. Start/finish writes are parameterised; finishing an execution
 * updates the history row and the report's LAST_* status columns in one transaction
 * and never touches the report definition columns.
 */
export class HistoryRepository {
  private readonly table: string;
  private readonly reports: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.executions);
    this.reports = q(schema, T.reports);
  }

  async start(e: {
    id: string;
    userId: string;
    reportId?: string | null;
    kind: 'RUN' | 'EXPORT';
    sql: string;
  }) {
    const hash = createHash('sha256').update(e.sql).digest('hex');
    await this.db.transaction(async (tx) => {
      await tx.update(
        `INSERT INTO ${this.table} (EXECUTION_ID, REPORT_ID, USER_ID, KIND, STATUS, STARTED_AT, TRUNCATED, SQL_SHA256)
         VALUES (?, ?, ?, ?, 'RUNNING', ${NOW_UTC}, 0, ?)`,
        [e.id, e.reportId ?? null, e.userId, e.kind, hash],
      );
      if (e.reportId && e.kind === 'RUN') {
        await tx.update(
          `UPDATE ${this.reports} SET LAST_STATUS = 'RUNNING' WHERE REPORT_ID = ? AND OWNER_ID = ?`,
          [e.reportId, e.userId],
        );
      }
    });
  }

  async finish(
    e: { id: string; userId: string; reportId?: string | null; kind: 'RUN' | 'EXPORT' },
    f: FinishInfo,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.update(
        `UPDATE ${this.table}
            SET STATUS = ?, COMPLETED_AT = ${NOW_UTC}, ELAPSED_MS = ?, ROW_COUNT = ?, TRUNCATED = ?,
                SQL_STATE = ?, SQL_CODE = ?, ERROR_MESSAGE = ?
          WHERE EXECUTION_ID = ? AND USER_ID = ?`,
        [
          f.status,
          Math.round(f.elapsedMs),
          f.rowCount ?? null,
          f.truncated ? 1 : 0,
          f.sqlState ?? null,
          f.sqlCode ?? null,
          f.errorMessage ? f.errorMessage.slice(0, 1000) : null,
          e.id,
          e.userId,
        ],
      );
      if (e.reportId && e.kind === 'RUN') {
        await tx.update(
          `UPDATE ${this.reports}
              SET LAST_EXECUTED_AT = ${NOW_UTC}, LAST_STATUS = ?, LAST_ROW_COUNT = ?, LAST_DURATION_MS = ?
            WHERE REPORT_ID = ? AND OWNER_ID = ?`,
          [f.status, f.rowCount ?? null, Math.round(f.elapsedMs), e.reportId, e.userId],
        );
      }
    });
  }

  async list(
    userId: string,
    opts: { reportId?: string; limit?: number } = {},
  ): Promise<ExecutionRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: (string | number)[] = [userId];
    let where = 'USER_ID = ?';
    if (opts.reportId) {
      where += ' AND REPORT_ID = ?';
      params.push(opts.reportId);
    }
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT EXECUTION_ID, REPORT_ID, KIND, STATUS, STARTED_AT, COMPLETED_AT, ELAPSED_MS, ROW_COUNT, TRUNCATED, SQL_STATE, ERROR_MESSAGE
         FROM ${this.table} WHERE ${where} ORDER BY STARTED_AT DESC FETCH FIRST ${limit} ROWS ONLY`,
      params,
    );
    return rows.map((r) => ({
      id: String(r.EXECUTION_ID),
      reportId: (r.REPORT_ID as string) ?? null,
      kind: r.KIND as 'RUN' | 'EXPORT',
      status: r.STATUS as RunStatus,
      startedAt: dbTimestampToIso(r.STARTED_AT),
      completedAt: dbTimestampToIso(r.COMPLETED_AT),
      elapsedMs: r.ELAPSED_MS == null ? null : Number(r.ELAPSED_MS),
      rowCount: r.ROW_COUNT == null ? null : Number(r.ROW_COUNT),
      truncated: Number(r.TRUNCATED) === 1,
      sqlState: (r.SQL_STATE as string)?.trim() || null,
      errorMessage: (r.ERROR_MESSAGE as string) ?? null,
    }));
  }
}
