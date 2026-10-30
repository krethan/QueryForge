import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/config.js';
import type { AppUser } from '../auth/users.js';
import { HistoryRepository, type ExecContext, type FinishInfo } from '../history/history.js';
import type { Report } from '../reports/reports.js';
import {
  resolveParameters,
  type ParameterDef,
  type RawValues,
  type ResolvedParameters,
} from '../reports/parameters.js';
import type { AccessService } from '../sharing/access.js';
import { AppError, DbError, sanitizeErrorMessage } from '../util/errors.js';
import {
  CHART_EMBED_MAX_ROWS,
  XlsxResultWriter,
  addChartSheet,
  sanitizeFileName,
} from '../export/xlsx.js';
import {
  MAX_CHART_ROWS,
  prepareChart,
  type ChartCell,
  type ChartDef,
} from '../charts/chart-def.js';
import { renderChartPng } from '../charts/render.js';
import type { ResultColumn, Cell } from './results.js';
import type { PagedOutcome, PageOutcome, QueryExecutor } from './executor.js';

export interface RunResponse extends PagedOutcome {
  report?: Pick<
    Report,
    'id' | 'name' | 'description' | 'category' | 'sql' | 'version' | 'parameters'
  >;
  parameters?: Record<string, string | number | null>;
  dataSource: string;
}

export interface ExportFile {
  path: string;
  filename: string;
  rowCount: number;
  truncated: boolean;
  cleanup: () => Promise<void>;
  /** Rendered chart (when the report or request has chart settings that fit the result). */
  chart?: { png: Buffer; title: string } | null;
  /** Why a configured chart was not included. */
  chartNote?: string;
}

export interface AdhocParameters {
  definitions?: ParameterDef[];
  values?: RawValues;
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

const labelled = (defs: ParameterDef[], used: ResolvedParameters['used']) =>
  defs.map((d) => ({ label: d.label, value: used[d.name] ?? null }));

/**
 * Orchestrates execution: authorisation (AccessService: owner or share), server-side
 * parameter validation, history tracking, the Mapepire executor and XLSX export.
 * Saved reports are always re-read from Db2 for i and re-executed; results are never cached.
 */
export class ExecutionService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly executor: QueryExecutor,
    private readonly access: AccessService,
    private readonly history: HistoryRepository,
  ) {}

  private async tracked<T extends { rowCount: number; truncated: boolean }>(
    ctx: ExecContext,
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
    params: AdhocParameters = {},
  ): Promise<RunResponse> {
    this.executor.validate(sql);
    const p = resolveParameters(sql, params.definitions ?? [], params.values ?? {});
    const out = await this.paged(
      { id: executionId, userId: user.id, kind: 'RUN', sql, parameters: p.used },
      p.bound,
    );
    return { ...out, parameters: p.used, dataSource: this.cfg.mapepire.displayName };
  }

  async runReport(
    user: AppUser,
    reportId: string,
    executionId: string = randomUUID(),
    values: RawValues = {},
  ): Promise<RunResponse> {
    const { report } = await this.access.require(user, reportId, 'VIEW'); // fresh SQL from Db2 for i
    this.executor.validate(report.sql);
    const p = resolveParameters(report.sql, report.parameters, values);
    const out = await this.paged(
      {
        id: executionId,
        userId: user.id,
        reportId,
        reportOwnerId: report.ownerId,
        kind: 'RUN',
        sql: report.sql,
        parameters: p.used,
      },
      p.bound,
    );
    const { id, name, description, category, sql, version, parameters } = report;
    return {
      ...out,
      report: { id, name, description, category, sql, version, parameters },
      parameters: p.used,
      dataSource: this.cfg.mapepire.displayName,
    };
  }

  /**
   * Interactive run through a paging cursor. History is finished after the first
   * page and updated again with the final row count when the cursor closes.
   */
  private paged(ctx: ExecContext, bound: (string | number | null)[]): Promise<PagedOutcome> {
    const t0 = Date.now();
    return this.tracked(ctx, () =>
      this.executor.openPaged(ctx.sql, ctx.userId, {
        executionId: ctx.id,
        parameters: bound,
        onClose: (info) =>
          this.history
            .finish(ctx, {
              status: 'SUCCEEDED',
              elapsedMs: Date.now() - t0,
              rowCount: info.rowCount,
              truncated: info.truncated,
            })
            .catch((e) => console.error('history.finish failed', sanitizeErrorMessage(e))),
      }),
    );
  }

  fetchPage(user: AppUser, cursorId: string): Promise<PageOutcome> {
    return this.executor.fetchPage(cursorId, user.id);
  }

  closeCursor(user: AppUser, cursorId: string): Promise<boolean> {
    return this.executor.closeCursor(cursorId, user.id);
  }

  cancel(user: AppUser, executionId: string): boolean {
    return this.executor.cancel(executionId, user.id);
  }

  async exportXlsx(
    user: AppUser,
    src: {
      sql?: string;
      reportId?: string;
      name?: string;
      values?: RawValues;
      definitions?: ParameterDef[];
      /** Chart settings for this export; defaults to the saved report's. null = no chart. */
      chart?: ChartDef | null;
    },
    opts: { scheduleId?: string } = {},
  ): Promise<ExportFile> {
    let sql = src.sql ?? '';
    let defs = src.definitions ?? [];
    let report: Report | undefined;
    if (src.reportId) {
      report = (await this.access.require(user, src.reportId, 'VIEW')).report;
      sql = report.sql;
      defs = report.parameters;
    }
    this.executor.validate(sql);
    const p = resolveParameters(sql, defs, src.values ?? {});
    const title = report?.name ?? src.name?.trim() ?? 'Query results';
    const dir = await mkdtemp(join(tmpdir(), 'qf-export-'));
    const path = join(dir, 'export.xlsx');
    const cleanup = () => rm(dir, { recursive: true, force: true });
    const writer = new XlsxResultWriter(path, title, this.cfg.xlsxFormulaEscape);
    const id = randomUUID();
    const chartDef = src.chart !== undefined ? src.chart : (report?.chartDef ?? null);
    let cols: ResultColumn[] = [];
    const chartRows: Cell[][] = [];
    try {
      const meta = await this.tracked(
        {
          id,
          userId: user.id,
          reportId: report?.id ?? null,
          reportOwnerId: report?.ownerId ?? null,
          kind: opts.scheduleId ? 'SCHEDULE' : 'EXPORT',
          sql,
          parameters: p.used,
          scheduleId: opts.scheduleId ?? null,
        },
        () =>
          this.executor.stream(
            sql,
            user.id,
            this.cfg.limits.maxExportRows,
            {
              onColumns: (c) => {
                cols = c;
                writer.setColumns(c);
              },
              onRows: (r) => {
                if (chartDef)
                  for (const row of r) if (chartRows.length < MAX_CHART_ROWS) chartRows.push(row);
                writer.addRows(r);
              },
            },
            id,
            p.bound,
          ),
      );
      let chart: ExportFile['chart'] = null;
      let chartNote: string | undefined;
      let chartNotes: string[] = [];
      if (chartDef) {
        const prepared = prepareChart(chartDef, cols, chartRows as ChartCell[][]);
        if (!prepared.ok) chartNote = prepared.message;
        else if (writer.rowsWritten > CHART_EMBED_MAX_ROWS)
          chartNote = `Chart not embedded: exports over ${CHART_EMBED_MAX_ROWS.toLocaleString('en-US')} rows skip the Chart sheet.`;
        else {
          try {
            chart = { png: await renderChartPng(prepared, chartDef.title || title), title };
          } catch (e) {
            chartNote = `Chart could not be rendered: ${sanitizeErrorMessage(e)}`;
          }
          if (chart) {
            const notes = [
              `Plots ${Math.min(writer.rowsWritten, MAX_CHART_ROWS).toLocaleString('en-US')} of ${writer.rowsWritten.toLocaleString('en-US')} exported row(s)${meta.truncated ? ' (export was limited)' : ''}.`,
            ];
            if (prepared.categoriesDropped)
              notes.push(
                `Top ${chartDef.topN} categories shown; ${prepared.categoriesDropped} more omitted.`,
              );
            if (prepared.precisionLoss)
              notes.push(
                'Some exact decimal values were rounded to plot them; the Results sheet keeps exact values.',
              );
            notes.push('Picture of the chart (Excel charts cannot be generated by the exporter).');
            chartNotes = notes;
          }
        }
      }
      await writer.finish({
        chart: chartDef ? (chart ? 'See the Chart sheet.' : chartNote) : undefined,
        title,
        description: report?.description,
        sql,
        executedAt: meta.completedAt,
        executedBy: user.username,
        dataSource: this.cfg.mapepire.displayName,
        rowCount: meta.rowCount,
        truncated: meta.truncated,
        maxRows: this.cfg.limits.maxExportRows,
        parameters: labelled(defs, p.used),
        trigger: opts.scheduleId ? `Scheduled run (schedule ${opts.scheduleId})` : undefined,
      });
      if (chart)
        await addChartSheet(
          path,
          chart.png,
          { title: chartDef?.title || title, notes: chartNotes },
          this.cfg.xlsxFormulaEscape,
        );
      return {
        path,
        filename: sanitizeFileName(title),
        rowCount: writer.rowsWritten,
        truncated: meta.truncated,
        cleanup,
        chart,
        ...(chartNote ? { chartNote } : {}),
      };
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
}
