import ExcelJS from 'exceljs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parsePresentation, presentationJson } from '../src/reports/drill.js';
import {
  compareValues,
  formattingSchema,
  matchFormatting,
  matchPivotFormatting,
  matches,
} from '../src/reports/formatting.js';
import { pivotRows } from '../src/reports/pivot.js';
import { XlsxResultWriter } from '../src/export/xlsx.js';
const cs = (name: string, type: string): ResultColumn => ({
  name,
  type,
  precision: 10,
  scale: 0,
  nullable: true,
  label: name,
  key: name,
  kind: type === 'DECIMAL' ? 'decimal' : 'text',
});
import type { Cell, ResultColumn } from '../src/sql/results.js';

const columns: ResultColumn[] = [cs('REGION', 'VARCHAR'), cs('REVENUE', 'DECIMAL')];
const rules = {
  version: 1 as const,
  rules: [
    {
      column: 'REVENUE',
      op: '>' as const,
      value: '100',
      color: 'green' as const,
      scope: 'cell' as const,
    },
    {
      column: 'REGION',
      op: 'contains' as const,
      value: 'west',
      color: 'yellow' as const,
      scope: 'row' as const,
    },
  ],
};
describe('conditional formatting', () => {
  it('supports all comparison types, null/is null and first-match precedence', () => {
    expect(rules.rules.map((r) => r.column)).toEqual(['REVENUE', 'REGION']);
    const styles = matchFormatting(rules, columns, [
      ['West', '100'],
      ['East', '12345678901234567890.20'],
      [null, null],
    ]);
    expect(styles[0].every((s) => s?.color === 'yellow')).toBe(true);
    expect(styles[1][1]).toEqual({ color: 'green', scope: 'cell' });
    expect(styles[2][1]).toBeNull();
    expect(matches({ ...rules.rules[0], column: 'REGION', op: 'is null' }, null)).toBe(true);
    expect(matches({ ...rules.rules[0], op: 'between', value: 10, value2: 20 }, 15)).toBe(true);
    expect(matches({ ...rules.rules[0], op: '<>', value: 'numeric text' }, 'numeric text')).toBe(
      false,
    );
    expect(matches({ ...rules.rules[0], op: '>=', value: '100' }, '100.0')).toBe(true);
    expect(matches({ ...rules.rules[0], op: '<=', value: '100' }, '99.9999999999999999')).toBe(
      true,
    );
    expect(formattingSchema.parse(rules)).toEqual(rules);
    expect(
      formattingSchema.safeParse({ version: 1, rules: [{ ...rules.rules[0], color: 'arbitrary' }] })
        .success,
    ).toBe(false);
    expect(
      formattingSchema.safeParse({
        version: 1,
        rules: [{ ...rules.rules[0], value: 'DROP TABLE X' }],
      }).success,
    ).toBe(true);
  });
  it('compares precise decimals and negatives without double conversion', () => {
    expect(compareValues('9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareValues('-12345678901234567890.2', '-12345678901234567890.1')).toBe(-1);
    expect(compareValues('1.0000', '1')).toBe(0);
    expect(compareValues('2026-11-01', '2026-10-01')).toBe(1);
  });
  it('formats calculated, grouped and pivot results plus their totals', () => {
    const normal = matchFormatting(rules, columns, [['East', '150']]);
    expect(normal[0][1]).toMatchObject({ color: 'green' });
    const p = pivotRows(
      [cs('REGION', 'VARCHAR'), cs('QUARTER', 'CHAR'), cs('PIVOT_VALUE', 'DECIMAL')],
      [
        ['West', 'A', '150'],
        ['West', 'B', '50'],
        ['East', 'A', '200'],
      ],
      1,
      'SUM',
      'Total revenue',
    );
    const styles = matchPivotFormatting(
      { version: 1, rules: [{ ...rules.rules[0], column: 'PIVOT_VALUE' }] },
      p,
    );
    expect(styles[0][1]).toMatchObject({ color: 'green' });
    expect(styles[0][2]).toBeNull();
    expect(styles[2][1]).toMatchObject({ color: 'green' });
    const rowStyles = matchPivotFormatting({ version: 1, rules: [rules.rules[1]] }, p);
    expect(rowStyles[0].every((r) => r?.color === 'yellow')).toBe(true);
  });
  it('writes static Excel fills and fonts only (no formulas or CF rules)', async () => {
    const file = join(tmpdir(), `format-${randomUUID()}.xlsx`);
    const w = new XlsxResultWriter(file, 'Report', 'prefix');
    w.setColumns([cs('REGION', 'VARCHAR'), cs('REVENUE', 'DECIMAL')], rules);
    const rows: Cell[][] = [
      ['West', '75'],
      ['East', '101'],
      ['=1+1', '100'],
    ];
    w.addRows(rows);
    await w.finish({
      title: 'Formatting',
      sql: 'SELECT ?, ? VALUES (?, ?)',
      executedAt: new Date().toISOString(),
      executedBy: 'test',
      dataSource: 'fake',
      maxRows: 3,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const s = wb.getWorksheet('Report')!;
    expect((s.getCell('B3').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('ffdefbe6');
    expect((s.getCell('A2').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('fffcf4d6');
    expect(s.getCell('A4').value).toBe("'=1+1");
    expect((s.getCell('B3').value as { formula?: string })?.formula).toBeUndefined();
    expect((s as unknown as { _cfRules?: unknown })._cfRules).toBeUndefined();
  });
  it('uses the correct source row for pivot exports and streaming batches', async () => {
    const file = join(tmpdir(), `batch-format-${randomUUID()}.xlsx`);
    const w = new XlsxResultWriter(file, 'PivotExport', 'prefix');
    const streamingRules = {
      version: 1 as const,
      rules: [{ ...rules.rules[0] }],
    };
    const rows = [
      ['West', '50'],
      ['East', '200'],
    ];
    w.setColumns([cs('REGION', 'VARCHAR'), cs('REVENUE', 'DECIMAL')], streamingRules, rows);
    expect(
      matchFormatting(
        streamingRules,
        [cs('REGION', 'VARCHAR'), cs('REVENUE', 'DECIMAL')],
        rows,
      )[1][1],
    ).toMatchObject({ color: 'green' });
    w.addRows([rows[0]]);
    w.addRows([rows[1]]);
    await w.finish({
      title: 'PivotExport',
      sql: 'SELECT ?',
      executedAt: new Date().toISOString(),
      executedBy: 'test',
      dataSource: 'fake',
      maxRows: 2,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sheet = wb.getWorksheet('PivotExport')!;
    expect((sheet.getCell('B2').fill as ExcelJS.FillPattern).fgColor?.argb).toBeUndefined();
    expect((sheet.getCell('B3').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('ffdefbe6');
  });
  it('preserves older chart/drill JSON and exports formatting in the same storage envelope', () => {
    expect(
      parsePresentation('{"version":1,"view":"both","categoryColumn":"A"}').formatting,
    ).toBeNull();
    const saved = presentationJson(null, null, rules);
    expect(parsePresentation(saved).formatting).toEqual(rules);
    const both = {
      chart: { version: 1 as const, type: 'bar' as const, view: 'both' as const, x: 'A', y: ['B'] },
      drill: { version: 1 as const, targetReportId: 'target', mapping: [] },
      formatting: rules,
    };
    expect(JSON.stringify({ version: 2, ...both })).toEqual(
      presentationJson(both.chart, both.drill, rules),
    );
  });
});
