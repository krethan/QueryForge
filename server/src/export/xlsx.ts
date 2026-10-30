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

/** Canonical form of a plain decimal string ("+001.500" -> "1.5"), or null if it is not one. */
export function canonicalDecimal(text: string): string | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (!m[2] && !m[3])) return null;
  const int = m[2].replace(/^0+(?=\d)/, '') || '0';
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : int;
  return body === '0' ? '0' : `${m[1] === '-' ? '-' : ''}${body}`;
}

/**
 * An exact numeric string may become an Excel number only when a double holds it
 * exactly enough to round-trip: at most 15 significant digits (DBL_DIG) and
 * String(Number(v)) reproduces the same decimal value.
 */
export function safeExcelNumber(text: string): number | null {
  const canon = canonicalDecimal(text);
  if (canon === null) return null;
  const digits = canon.replace(/[-.]/g, '').replace(/^0+/, '').length;
  if (digits > 15) return null;
  const n = Number(canon);
  if (!Number.isFinite(n)) return null;
  return canonicalDecimal(String(n)) === canon ? n : null;
}

export const TEXT_NUMBER_NOTE =
  'Exact value kept as text: it has more significant digits than an Excel number (15) can hold.';

/** Convert a normalised result cell into an ExcelJS value. Never returns a formula. */
export function toExcelValue(
  v: Cell,
  col: ResultColumn,
  mode: 'prefix' | 'none',
): ExcelJS.CellValue {
  return toExcel(v, col, mode).value;
}

/** Like toExcelValue, also reporting whether an exact numeric value had to be written as text. */
export function toExcel(
  v: Cell,
  col: ResultColumn,
  mode: 'prefix' | 'none',
): { value: ExcelJS.CellValue; numericAsText: boolean } {
  const plain = (value: ExcelJS.CellValue) => ({ value, numericAsText: false });
  if (v === null) return plain(null);
  if (typeof v === 'object') return plain(`[binary${v.size !== null ? `: ${v.size} bytes` : ''}]`);
  if (typeof v === 'boolean') return plain(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return plain(String(v));
    if ((col.kind === 'integer' || col.kind === 'decimal') && safeExcelNumber(String(v)) === null)
      return { value: String(v), numericAsText: true };
    return plain(v);
  }
  switch (col.kind) {
    case 'decimal':
    case 'integer': {
      const n = safeExcelNumber(v);
      if (n !== null) return plain(n);
      // not representable (or not a plain decimal, e.g. DECFLOAT 'Infinity'): exact text
      return { value: escapeFormula(v, mode), numericAsText: canonicalDecimal(v) !== null };
    }
    case 'float': {
      const n = Number(v);
      return plain(Number.isFinite(n) ? n : v);
    }
    case 'date':
    case 'timestamp':
      return plain(parseDate(v, col.kind) ?? escapeFormula(v, mode));
    default:
      return plain(escapeFormula(v, mode));
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
  /** Chart status line for the Report Info sheet (when the report has chart settings). */
  chart?: string;
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
  /** Exact numeric cells written as text because Excel could not hold them. */
  numericAsText = 0;
  private textColumns = new Set<number>();
  /** Per-cell notes are capped so huge exports stay small; the header note always explains. */
  static readonly MAX_CELL_NOTES = 500;

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
    this.wb.creator = 'Uncle Bob';
    this.wb.lastModifiedBy = 'Uncle Bob';
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
    this.cols.forEach((c, i) => {
      const wide =
        c.type.toUpperCase() === 'BIGINT' ||
        (c.kind === 'decimal' && (c.precision > 15 || !c.precision));
      if (wide)
        header.getCell(i + 1).note =
          'Values with more than 15 significant digits are written as exact text (marked with a note); the rest are numbers.';
    });
    header.commit();
  }

  addRows(rows: Cell[][]) {
    for (const r of rows) {
      if (this.rowsWritten >= EXCEL_MAX_ROWS - 1) return;
      const cells = this.cols.map((c, i) => toExcel(r[i], c, this.mode));
      const row = this.sheet.addRow(cells.map((x) => x.value));
      cells.forEach((x, i) => {
        if (!x.numericAsText) return;
        this.numericAsText++;
        this.textColumns.add(i);
        if (this.numericAsText <= XlsxResultWriter.MAX_CELL_NOTES)
          row.getCell(i + 1).note = TEXT_NUMBER_NOTE;
      });
      row.commit();
      this.rowsWritten++;
    }
  }

  async finish(meta: WorkbookMeta) {
    if (!this.sheet) this.setColumns([]);
    this.wb.title = meta.title;
    this.wb.subject = 'SQL reporting for IBM i';
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
      ...(this.numericAsText
        ? ([
            [
              'Numbers kept as text',
              `${this.numericAsText} value(s) in ${[...this.textColumns].map((i) => this.cols[i].label).join(', ')} exceed Excel's 15-digit precision and were written as exact text.`,
            ],
          ] as [string, string][])
        : []),
      ['Complete result', meta.truncated ? `No - limited to ${meta.maxRows} rows` : 'Yes'],
      ...(this.columnsOmitted
        ? ([['Columns omitted', `${this.columnsOmitted} (Excel column limit)`]] as [
            string,
            string,
          ][])
        : []),
      ...(meta.chart ? ([['Chart', meta.chart]] as [string, string][]) : []),
      ['SQL', meta.sql],
    ];
    for (const [k, v] of rows)
      info.addRow({ k, v: typeof v === 'string' ? escapeFormula(v, this.mode) : v }).commit();
    info.commit();
    await this.wb.commit();
  }
}

/**
 * Exports larger than this are not re-opened to embed a chart: the streaming writer cannot
 * place images, so adding the Chart sheet means loading the finished workbook in memory.
 */
export const CHART_EMBED_MAX_ROWS = 50_000;

/**
 * Add a "Chart" sheet holding a rendered PNG to a finished workbook. exceljs cannot create
 * native Excel charts, so the chart is a picture of the plotted (loaded) rows.
 */
export async function addChartSheet(
  path: string,
  png: Buffer,
  info: { title: string; notes: string[] },
  mode: 'prefix' | 'none',
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheet = wb.addWorksheet('Chart');
  sheet.getColumn(1).width = 120;
  const head = sheet.getCell('A1');
  head.value = escapeFormula(info.title, mode);
  head.font = { bold: true, size: 14 };
  info.notes.forEach((n, i) => {
    sheet.getCell(`A${i + 2}`).value = escapeFormula(n, mode);
  });
  const imageId = wb.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: 'png' });
  sheet.addImage(imageId, {
    tl: { col: 0, row: info.notes.length + 2 },
    ext: { width: 960, height: 540 },
    editAs: 'absolute',
  });
  await wb.xlsx.writeFile(path);
}
