import ExcelJS from 'exceljs';
import type { Cell, ResultColumn } from '../sql/results.js';

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
const FORMULA_TRIGGERS = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * Neutralise text that a spreadsheet could interpret as a formula / DDE payload
 * (OWASP CSV/formula-injection guidance). Cells are always written as plain
 * string values; ExcelJS only creates formulas from explicit { formula } objects,
 * which this module never produces.
 */
export function escapeFormula(text: string, mode: 'prefix' | 'none' = 'prefix'): string {
  if (mode === 'none') return text;
  return FORMULA_TRIGGERS.test(text) ? `'${text}` : text;
}

export function sanitizeSheetName(name: string, fallback = 'Results'): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, 31);
}

export function sanitizeFileName(name: string): string {
  const base = name
    .replace(/[^\w .-]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${base || 'query-results'}.xlsx`;
}

function parseDate(s: string, kind: 'date' | 'timestamp'): Date | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T-](\d{2})[:.](\d{2})[:.](\d{2})(?:\.(\d{1,12}))?)?$/.exec(
      s.trim(),
    );
  if (!m) return null;
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
  const d =
    kind === 'date'
      ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
      : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function numFmtFor(col: ResultColumn): string | undefined {
  switch (col.kind) {
    case 'decimal':
      return col.scale > 0 ? `#,##0.${'0'.repeat(Math.min(col.scale, 30))}` : '#,##0';
    case 'integer':
      return '0';
    case 'date':
      return 'yyyy-mm-dd';
    case 'timestamp':
      return 'yyyy-mm-dd hh:mm:ss.000';
    default:
      return undefined;
  }
}

/** Convert a normalised result cell into an ExcelJS value. Never returns a formula. */
export function toExcelValue(
  v: Cell,
  col: ResultColumn,
  mode: 'prefix' | 'none',
): ExcelJS.CellValue {
  if (v === null) return null;
  if (typeof v === 'object') return `[binary${v.size !== null ? `: ${v.size} bytes` : ''}]`;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  switch (col.kind) {
    case 'decimal':
    case 'integer': {
      // Excel holds 15 significant digits; keep larger values exact as text.
      const digits = v.replace(/[-+.]/g, '').replace(/^0+/, '').length;
      const n = Number(v);
      return digits <= 15 && Number.isFinite(n) ? n : v;
    }
    case 'float': {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case 'date':
    case 'timestamp':
      return parseDate(v, col.kind) ?? escapeFormula(v, mode);
    default:
      return escapeFormula(v, mode);
  }
}

export interface WorkbookMeta {
  title: string;
  description?: string | null;
  sql: string;
  executedAt: string;
  executedBy: string;
  dataSource: string;
  rowCount?: number;
  truncated?: boolean;
  maxRows: number;
  columnsOmitted?: number;
  /** Parameter label -> value used for this run. */
  parameters?: { label: string; value: string | number | null }[];
  trigger?: string;
}

/**
 * Streaming XLSX writer: rows are committed as they arrive so large exports do
 * not need the whole result set in memory.
 */
export class XlsxResultWriter {
  private wb: ExcelJS.stream.xlsx.WorkbookWriter;
  private sheet!: ExcelJS.Worksheet;
  private cols: ResultColumn[] = [];
  rowsWritten = 0;
  columnsOmitted = 0;

  constructor(
    filename: string,
    private readonly sheetName: string,
    private readonly mode: 'prefix' | 'none',
  ) {
    this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename,
      useStyles: true,
      useSharedStrings: false,
    });
    this.wb.creator = 'IBM i Query Reports';
    this.wb.created = new Date();
  }

  setColumns(cols: ResultColumn[]) {
    this.columnsOmitted = Math.max(0, cols.length - EXCEL_MAX_COLS);
    this.cols = cols.slice(0, EXCEL_MAX_COLS);
    this.sheet = this.wb.addWorksheet(sanitizeSheetName(this.sheetName), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    this.sheet.columns = this.cols.map((c) => ({
      header: escapeFormula(c.label, this.mode),
      key: c.key,
      width: Math.min(Math.max(c.label.length + 2, Math.min(c.precision || 10, 40), 10), 60),
      style: numFmtFor(c) ? { numFmt: numFmtFor(c) } : {},
    }));
    const header = this.sheet.getRow(1);
    header.font = { bold: true };
    header.commit();
  }

  addRows(rows: Cell[][]) {
    for (const r of rows) {
      if (this.rowsWritten >= EXCEL_MAX_ROWS - 1) return;
      this.sheet.addRow(this.cols.map((c, i) => toExcelValue(r[i], c, this.mode))).commit();
      this.rowsWritten++;
    }
  }

  async finish(meta: WorkbookMeta) {
    if (!this.sheet) this.setColumns([]);
    this.sheet.commit();
    const info = this.wb.addWorksheet('Report Info');
    info.columns = [
      { header: 'Property', key: 'k', width: 22 },
      { header: 'Value', key: 'v', width: 100 },
    ];
    info.getRow(1).font = { bold: true };
    const rows: [string, string | number][] = [
      ['Report', meta.title],
      ['Description', meta.description ?? ''],
      ['Data source', meta.dataSource],
      ['Executed at (UTC)', meta.executedAt],
      ['Executed by', meta.executedBy],
      ...(meta.trigger ? ([['Trigger', meta.trigger]] as [string, string][]) : []),
      ...(meta.parameters ?? []).map(
        (p) =>
          [`Parameter: ${p.label}`, p.value === null ? '(none)' : p.value] as [
            string,
            string | number,
          ],
      ),
      ['Rows exported', this.rowsWritten],
      ['Complete result', meta.truncated ? `No - limited to ${meta.maxRows} rows` : 'Yes'],
      ...(this.columnsOmitted
        ? ([['Columns omitted', `${this.columnsOmitted} (Excel column limit)`]] as [
            string,
            string,
          ][])
        : []),
      ['SQL', meta.sql],
    ];
    for (const [k, v] of rows)
      info.addRow({ k, v: typeof v === 'string' ? escapeFormula(v, this.mode) : v }).commit();
    info.commit();
    await this.wb.commit();
  }
}
