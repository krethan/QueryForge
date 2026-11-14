import type { Cell, ResultColumn } from '../api/types';
import { isBinary } from './format';

/**
 * Copying grid cells to the clipboard as tab-separated text (plus an HTML table) that pastes
 * cleanly into Excel. Values are converted the same way the server's XLSX export converts them
 * (server/src/export/xlsx.ts): NULL is an empty cell, exact numbers that a double cannot hold
 * stay text, dates and timestamps use ISO text, binary values become a placeholder and text that
 * a spreadsheet could read as a formula gets a leading apostrophe. Only rows already loaded in
 * the browser are copied; nothing is fetched from the server.
 */

/** At most this many cells (rows × columns, header included) per copy. */
export const COPY_MAX_CELLS = 100_000;
/** At most this many characters of tab-separated text per copy (about 5 MB). */
export const COPY_MAX_CHARS = 5_000_000;

const FORMULA_TRIGGERS = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

/** Same guard as the XLSX export's default `XLSX_FORMULA_ESCAPE=prefix`. */
export function escapeFormula(text: string): string {
  return FORMULA_TRIGGERS.test(text) ? `'${text}` : text;
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

/** True when Excel can hold the decimal exactly: ≤ 15 significant digits and a lossless round trip. */
export function fitsExcelNumber(text: string): boolean {
  const canon = canonicalDecimal(text);
  if (canon === null) return false;
  const digits = canon.replace(/[-.]/g, '').replace(/^0+/, '').length;
  if (digits > 15) return false;
  const n = Number(canon);
  return Number.isFinite(n) && canonicalDecimal(String(n)) === canon;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Db2 date/timestamp text as ISO text Excel recognises; null when it is not a valid date. */
export function isoDateText(s: string, kind: 'date' | 'timestamp'): string | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T-](\d{2})[:.](\d{2})[:.](\d{2})(?:\.(\d{1,12}))?)?$/.exec(
      s.trim(),
    );
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    se > 59
  )
    return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (kind === 'date') return date;
  // the XLSX export keeps milliseconds (yyyy-mm-dd hh:mm:ss.000); so does the copy
  const ms = (m[7] ?? '0').padEnd(3, '0').slice(0, 3);
  return `${date} ${pad(h)}:${pad(mi)}:${pad(se)}.${ms}`;
}

export interface CopyValue {
  text: string;
  /** Excel should keep the value as text (an exact number too wide for Excel, or a text column). */
  asText: boolean;
}

/** One cell as clipboard text, converted like the XLSX export converts it. */
export function copyValue(v: Cell, col: ResultColumn): CopyValue {
  if (v === null) return { text: '', asText: false };
  if (isBinary(v))
    return { text: `[binary${v.size !== null ? `: ${v.size} bytes` : ''}]`, asText: true };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', asText: false };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { text: String(v), asText: true };
    if ((col.kind === 'integer' || col.kind === 'decimal') && !fitsExcelNumber(String(v)))
      return { text: String(v), asText: true };
    return { text: String(v), asText: false };
  }
  switch (col.kind) {
    case 'decimal':
    case 'integer':
      if (fitsExcelNumber(v)) return { text: v.trim(), asText: false };
      return canonicalDecimal(v) !== null
        ? { text: v.trim(), asText: true }
        : { text: escapeFormula(v), asText: true };
    case 'float':
      return Number.isFinite(Number(v)) && v.trim() !== ''
        ? { text: v.trim(), asText: false }
        : { text: escapeFormula(v), asText: true };
    case 'date':
    case 'timestamp': {
      const iso = isoDateText(v, col.kind);
      return iso !== null ? { text: iso, asText: false } : { text: escapeFormula(v), asText: true };
    }
    default:
      return { text: escapeFormula(v), asText: true };
  }
}

/** Quote a field when it holds a tab, a line break or a double quote; quotes are doubled. */
export function tsvField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const html = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br style="mso-data-placement:same-cell">');

export type CopyBuild =
  | { ok: true; text: string; html: string; rows: number; columns: number; header: boolean }
  | { ok: false; reason: 'empty' | 'too-many-cells' | 'too-large'; cells: number };

/**
 * Build the clipboard payload for `rows` (already in display order) and the column indexes in
 * `cols`. Fails without building anything when the copy is over COPY_MAX_CELLS, and stops as soon
 * as the text passes COPY_MAX_CHARS.
 */
export function buildCopy(
  columns: ResultColumn[],
  rows: Cell[][],
  cols: number[],
  header: boolean,
): CopyBuild {
  const cells = (rows.length + (header ? 1 : 0)) * cols.length;
  if (rows.length === 0 || cols.length === 0) return { ok: false, reason: 'empty', cells: 0 };
  if (cells > COPY_MAX_CELLS) return { ok: false, reason: 'too-many-cells', cells };
  const lines: string[] = [];
  const htmlRows: string[] = [];
  let size = 0;
  const textStyle = ' style="mso-number-format:\'\\@\'"';
  if (header) {
    const labels = cols.map((c) => escapeFormula(columns[c].label));
    lines.push(labels.map(tsvField).join('\t'));
    htmlRows.push(`<tr>${labels.map((l) => `<th${textStyle}>${html(l)}</th>`).join('')}</tr>`);
    size += lines[0].length + 2;
  }
  for (const r of rows) {
    const vals = cols.map((c) => copyValue(r[c] ?? null, columns[c]));
    const line = vals.map((v) => tsvField(v.text)).join('\t');
    size += line.length + 2;
    if (size > COPY_MAX_CHARS) return { ok: false, reason: 'too-large', cells };
    lines.push(line);
    htmlRows.push(
      `<tr>${vals.map((v) => `<td${v.asText ? textStyle : ''}>${html(v.text)}</td>`).join('')}</tr>`,
    );
  }
  return {
    ok: true,
    text: lines.join('\r\n'),
    html: `<html><body><table>${htmlRows.join('')}</table></body></html>`,
    rows: rows.length,
    columns: cols.length,
    header,
  };
}

/**
 * Put text (and, where the browser allows it, the HTML table) on the clipboard. Tries the async
 * Clipboard API first, then the legacy copy command. Throws when the browser refuses.
 */
export async function writeClipboard(text: string, htmlText: string): Promise<void> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await clip.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([htmlText], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      /* fall through */
    }
  }
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  let done = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', htmlText);
    e.preventDefault();
    done = true;
  };
  document.addEventListener('copy', onCopy);
  try {
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!ok || !done) throw new Error('The browser did not allow access to the clipboard.');
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}
