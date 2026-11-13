import type { Response } from 'express';
import { sanitizeErrorMessage } from '../util/errors.js';
import { escapeFormula } from './xlsx.js';

/**
 * CSV writing for audit exports (RFC 4180, UTF-8).
 *
 * Every cell is quoted, embedded quotes are doubled, and line breaks stay inside the quotes.
 * Text a spreadsheet could run as a formula or DDE payload (starting with = + - @, a tab or a
 * carriage return, or their full-width forms) gets a leading apostrophe first, the same guard
 * as the XLSX export (OWASP CSV injection guidance). Lone UTF-16 surrogates are replaced so the
 * output is always valid UTF-8.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = String(value).replace(LONE_SURROGATE, '\uFFFD');
  return `"${escapeFormula(text).replaceAll('"', '""')}"`;
}

export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** Byte-order mark so Excel opens the file as UTF-8. */
export const CSV_BOM = '\uFEFF';

/** `name.csv`, keeping only characters that are safe in a plain Content-Disposition filename. */
export function csvFileName(name: string, fallback: string): string {
  const base = name
    .replace(/[^\w .-]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${base || fallback}.csv`;
}

/** Content-Disposition with an ASCII filename and the full UTF-8 name (RFC 6266 / 5987). */
export function attachmentHeader(asciiName: string, utf8Name: string): string {
  const star = encodeURIComponent(utf8Name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName.replaceAll('"', '_')}"; filename*=UTF-8''${star}`;
}

/**
 * Stream a CSV response from batches of rows. The first batch is read before any header is
 * sent, so a failure there still becomes a normal JSON error. A later failure can only end the
 * response early: the connection is destroyed rather than ending cleanly, so the client sees an
 * incomplete download instead of a file that looks whole. Honors back-pressure and stops reading
 * when the client goes away. Returns the number of data rows written.
 */
export async function streamCsv<T>(
  res: Response,
  opts: { filename: string; utf8Filename?: string; header: readonly string[] },
  batches: AsyncIterable<T[]>,
  toCells: (row: T) => readonly unknown[],
): Promise<number> {
  const it = batches[Symbol.asyncIterator]();
  let next = await it.next();
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    attachmentHeader(opts.filename, opts.utf8Filename ?? opts.filename),
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  let rows = 0;
  const write = async (chunk: string) => {
    if (!res.write(chunk, 'utf8'))
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
  };
  try {
    await write(CSV_BOM + csvLine(opts.header));
    while (!next.done) {
      if (res.destroyed) break;
      if (next.value.length) {
        await write(next.value.map((row) => csvLine(toCells(row))).join(''));
        rows += next.value.length;
      }
      next = await it.next();
    }
    if (res.destroyed) await it.return?.(undefined);
    else res.end();
  } catch (e) {
    console.error('CSV export stopped early:', sanitizeErrorMessage(e));
    await it.return?.(undefined).catch(() => undefined);
    res.destroy();
  }
  return rows;
}
