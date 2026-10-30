import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  XlsxResultWriter,
  escapeFormula,
  sanitizeFileName,
  sanitizeSheetName,
} from '../src/export/xlsx.js';
import { toColumns } from '../src/sql/results.js';
import { col } from './helpers/fake-mapepire.js';
import type { ColumnMetaData } from '@ibm/mapepire-js';

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe('formula injection protection', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tX', '\rX', '=HYPERLINK("http://evil")'])(
    'escapes %j',
    (v) => expect(escapeFormula(v)).toBe(`'${v}`),
  );
  it('leaves ordinary text alone and honours mode none', () => {
    expect(escapeFormula('hello')).toBe('hello');
    expect(escapeFormula('=x', 'none')).toBe('=x');
  });
  it('sanitizes sheet and file names', () => {
    expect(sanitizeSheetName('a/b*c?[d]:e\\f'.repeat(4)).length).toBeLessThanOrEqual(31);
    expect(sanitizeSheetName('a/b')).not.toMatch(/[\\/*?:[\]]/);
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
  });
});

describe('XLSX workbook generation', () => {
  it('writes headers, typed values, NULLs and a Report Info sheet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qf-xlsx-'));
    dirs.push(dir);
    const file = join(dir, 'out.xlsx');
    const cols = toColumns([
      col('ID', 'INTEGER'),
      col('AMOUNT', 'DECIMAL', 11, 2),
      col('NOTE', 'VARCHAR', 50),
      col('DAY', 'DATE'),
    ] as ColumnMetaData[]);
    const w = new XlsxResultWriter(file, 'Sales Report', 'prefix');
    w.setColumns(cols);
    w.addRows([
      [1, '1234.50', '=cmd|calc', '2026-10-23'],
      [2, null, '', null],
    ]);
    await w.finish({
      title: 'Sales',
      dataSource: 'PROD400',
      executedAt: '2026-10-23T10:00:00Z',
      executedBy: 'alice',
      sql: '=SELECT',
      truncated: false,
      maxRows: 10,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const s = wb.getWorksheet('Sales Report')!;
    expect(s.getRow(1).values).toEqual([undefined, 'ID', 'AMOUNT', 'NOTE', 'DAY']);
    expect(s.getCell('A2').value).toBe(1);
    expect(s.getCell('B2').value).toBe(1234.5);
    expect(s.getCell('C2').value).toBe("'=cmd|calc");
    expect(s.getCell('C2').formula).toBeUndefined();
    expect(s.getCell('D2').value).toBeInstanceOf(Date);
    expect(s.getCell('B3').value).toBeNull();
    const info = wb.getWorksheet('Report Info')!;
    const vals = info.getColumn(2).values.slice(2);
    expect(vals).toContain('PROD400');
    expect(vals).toContain("'=SELECT");
  });

  it('stamps the product name and the report title into the workbook metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qf-xlsx-'));
    dirs.push(dir);
    const file = join(dir, 'meta.xlsx');
    const w = new XlsxResultWriter(file, 'Sales Report', 'prefix');
    w.setColumns(toColumns([col('ID', 'INTEGER')] as ColumnMetaData[]));
    w.addRows([[1]]);
    await w.finish({
      title: 'Open Orders',
      dataSource: 'PROD400',
      executedAt: '2026-10-23T10:00:00Z',
      executedBy: 'alice',
      sql: 'SELECT ID FROM ORDERS',
      truncated: false,
      maxRows: 10,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.creator).toBe('Uncle Bob');
    expect(wb.lastModifiedBy).toBe('Uncle Bob');
    expect(wb.title).toBe('Open Orders');
    expect(wb.subject).toBe('SQL reporting for IBM i');
  });
});
