import { describe, expect, it } from 'vitest';
import { kindOf, normalizeRow, toColumns } from '../src/sql/results.js';
import { col } from './helpers/fake-mapepire.js';
import type { ColumnMetaData } from '@ibm/mapepire-js';

describe('result metadata and values', () => {
  const cols = toColumns([
    col('ID', 'INTEGER'),
    col('AMOUNT', 'DECIMAL', 15, 2),
    col('NAME', 'VARCHAR', 50),
    col('CREATED', 'TIMESTAMP', 26),
    col('D', 'DATE'),
    col('B', 'VARBINARY', 16),
  ] as ColumnMetaData[]);

  it('maps Db2 types to column kinds and keeps precision/scale', () => {
    expect(cols.map((c) => c.kind)).toEqual([
      'integer',
      'decimal',
      'text',
      'timestamp',
      'date',
      'binary',
    ]);
    expect(cols[1]).toMatchObject({ name: 'AMOUNT', precision: 15, scale: 2 });
    expect(kindOf('NUMERIC')).toBe('decimal');
    expect(kindOf('CHAR')).toBe('text');
  });

  it('assigns unique keys even for duplicate column names', () => {
    const dup = toColumns([col('A', 'INTEGER'), col('A', 'INTEGER')] as ColumnMetaData[]);
    expect(new Set(dup.map((c) => c.key)).size).toBe(2);
  });

  it('distinguishes NULL from empty strings and keeps decimals exact', () => {
    const row = normalizeRow(
      [null, '12345678901234.56', '', '2026-10-23 10:00:00', null, 'AQID'],
      cols,
    );
    expect(row[0]).toBeNull();
    expect(row[1]).toBe('12345678901234.56');
    expect(row[2]).toBe('');
    expect(row[5]).toMatchObject({ $binary: true });
  });

  it('accepts object rows as well as terse arrays', () => {
    const row = normalizeRow(
      { ID: 7, AMOUNT: 1.5, NAME: 'x', CREATED: null, D: null, B: null },
      cols,
    );
    expect(row.slice(0, 3)).toEqual([7, '1.50', 'x']);
  });
});
