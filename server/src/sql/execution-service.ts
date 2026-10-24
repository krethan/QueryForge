import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/config.js';
import type { AppUser } from '../auth/users.js';
import { HistoryRepository, type FinishInfo } from '../history/history.js';
import type { Report, ReportRepository } from '../reports/reports.js';
import { AppError, DbError, sanitizeErrorMessage } from '../util/errors.js';
import { XlsxResultWriter, sanitizeFileName } from '../export/xlsx.js';
import type { ExecutionOutcome, QueryExecutor } from './executor.js';

export interface RunResponse extends ExecutionOutcome {
  report?: Pick<Report, 'id' | 'name' | 'description' | 'category' | 'sql' | 'version'>;
  dataSource: string;
}

export interface ExportFile {
  path: string;
  filename: string;
  rowCount: number;
  truncated: boolean;
  cleanup: () => Promise<void>;
}

function failureInfo(err: unknown, elapsedMs: number): FinishInfo {
  const code = err instanceof AppError ? err.code : '';
  return {
    status: code === 'TIMEOUT' ? 'TIMED_OUT' : code === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
    elapsedMs,
    sqlState: err instanceof DbError ? (err.sqlState ?? null) : null,
    sqlCode: err instanceof DbError ? (err.sqlCode ?? null) : null,
    errorMessage: sanitizeErrorMessage(err),
  };
}

/**
 * Orchestrates execution: authorisation (via owner-scoped report lookup),
 * history tracking, the Mapepire executor and XLSX export. Saved reports are
 * always re-read from Db2 for i and re-executed; results are never cached.
 */
export class ExecutionService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly executor: QueryExecutor,
    private readonly reports: ReportRepository,
    private readonly history: HistoryRepository,
  ) {}

  private async tracked<T extends { rowCount: number; truncated: boolean }>(
    ctx: {
      id: string;
      userId: string;
      reportId?: string | null;
      kind: 'RUN' | 'EXPORT';
      sql: string;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    // validate before recording anything so rejected SQL never reaches the database
    this.executor.validate(ctx.sql);
    const t0 = Date.now();
    await this.history.start(ctx);
    try {
      const r = await fn();
      await this.history
        .finish(ctx, {
          status: 'SUCCEEDED',
          elapsedMs: Date.now() - t0,
          rowCount: r.rowCount,
          truncated: r.truncated,
        })
        .catch((e) => console.error('history.finish failed', sanitizeErrorMessage(e)));
      return r;
    } catch (err) {
      await this.history
        .finish(ctx, failureInfo(err, Date.now() - t0))
        .catch((e) => console.error('history.finish failed', sanitizeErrorMessage(e)));
      throw err;
    }
  }

  async runAdhoc(
    user: AppUser,
    sql: string,
    executionId: string = randomUUID(),
  ): Promise<RunResponse> {
    const out = await this.tracked({ id: executionId, userId: user.id, kind: 'RUN', sql }, () =>
      this.executor.run(sql, user.id, { executionId }),
    );
    return { ...out, dataSource: this.cfg.mapepire.displayName };
  }

  async runReport(
    user: AppUser,
    reportId: string,
    executionId: string = randomUUID(),
  ): Promise<RunResponse> {
    const report = await this.reports.get(user.id, reportId); // ownership check, fresh SQL from Db2 for i
    const out = await this.tracked(
      { id: executionId, userId: user.id, reportId, kind: 'RUN', sql: report.sql },
      () => this.executor.run(report.sql, user.id, { executionId }),
    );
    const { id, name, description, category, sql, version } = report;
    return {
      ...out,
      report: { id, name, description, category, sql, version },
      dataSource: this.cfg.mapepire.displayName,
    };
  }

  cancel(user: AppUser, executionId: string): boolean {
    return this.executor.cancel(executionId, user.id);
  }

  async exportXlsx(
    user: AppUser,
    src: { sql?: string; reportId?: string; name?: string },
  ): Promise<ExportFile> {
    let sql = src.sql ?? '';
    let report: Report | undefined;
    if (src.reportId) {
      report = await this.reports.get(user.id, src.reportId);
      sql = report.sql;
    }
    const title = report?.name ?? src.name?.trim() ?? 'Query results';
    const dir = await mkdtemp(join(tmpdir(), 'qf-export-'));
    const path = join(dir, 'export.xlsx');
    const cleanup = () => rm(dir, { recursive: true, force: true });
    const writer = new XlsxResultWriter(path, title, this.cfg.xlsxFormulaEscape);
    const id = randomUUID();
    try {
      const meta = await this.tracked(
        { id, userId: user.id, reportId: report?.id ?? null, kind: 'EXPORT', sql },
        () =>
          this.executor.stream(
            sql,
            user.id,
            this.cfg.limits.maxExportRows,
            {
              onColumns: (c) => writer.setColumns(c),
              onRows: (r) => writer.addRows(r),
            },
            id,
          ),
      );
      await writer.finish({
        title,
        description: report?.description,
        sql,
        executedAt: meta.completedAt,
        executedBy: user.username,
        dataSource: this.cfg.mapepire.displayName,
        rowCount: meta.rowCount,
        truncated: meta.truncated,
        maxRows: this.cfg.limits.maxExportRows,
      });
      return {
        path,
        filename: sanitizeFileName(title),
        rowCount: writer.rowsWritten,
        truncated: meta.truncated,
        cleanup,
      };
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
}
