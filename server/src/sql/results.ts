import type { ColumnMetaData } from '../db/types.js';

export type ColumnKind =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'text'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'binary'
  | 'lob'
  | 'boolean'
  | 'xml'
  | 'other';

export interface ResultColumn {
  /** Positional key, unique even if two columns share a label. */
  key: string;
  name: string;
  label: string;
  type: string;
  kind: ColumnKind;
  precision: number;
  scale: number;
  nullable: boolean;
  table?: string;
}

export type BinaryCell = { $binary: true; size: number | null };
export type Cell = string | number | boolean | null | BinaryCell;

export function kindOf(type: string): ColumnKind {
  const t = type.toUpperCase();
  if (['SMALLINT', 'INTEGER', 'INT', 'BIGINT'].includes(t)) return 'integer';
  if (['DECIMAL', 'NUMERIC', 'DECFLOAT'].includes(t)) return 'decimal';
  if (['REAL', 'DOUBLE', 'FLOAT'].includes(t)) return 'float';
  if (t === 'DATE') return 'date';
  if (t === 'TIME') return 'time';
  if (t.startsWith('TIMESTAMP')) return 'timestamp';
  if (t === 'BOOLEAN') return 'boolean';
  if (
    [
      'BLOB',
      'BINARY',
      'VARBINARY',
      'CHAR () FOR BIT DATA',
      'VARCHAR () FOR BIT DATA',
      'ROWID',
    ].includes(t) ||
    t.includes('FOR BIT DATA')
  )
    return 'binary';
  if (['CLOB', 'DBCLOB', 'NCLOB'].includes(t)) return 'lob';
  if (t === 'XML') return 'xml';
  if (/CHAR|GRAPHIC|DATALINK|VARCHAR/.test(t)) return 'text';
  return 'other';
}

export function toColumns(meta: ColumnMetaData[] | undefined): ResultColumn[] {
  return (meta ?? []).map((c, i) => ({
    key: `c${i}`,
    name: c.name,
    label: c.label || c.name,
    type: c.type,
    kind: kindOf(c.type),
    precision: c.precision,
    scale: c.scale,
    // JDBC: 0 = columnNoNulls, 1 = columnNullable, 2 = unknown
    nullable: c.nullable !== 0,
    table: c.table || undefined,
  }));
}

function isBlobRef(v: unknown): v is { blob_url: string; size: number } {
  return typeof v === 'object' && v !== null && 'blob_url' in v;
}

/** Normalise one value from a Mapepire result row without changing its meaning. */
export function normalizeCell(v: unknown, col: ResultColumn): Cell {
  if (v === null || v === undefined) return null;
  if (isBlobRef(v)) return { $binary: true, size: typeof v.size === 'number' ? v.size : null };
  if (col.kind === 'binary') {
    // single-mode transports return Base64; daemon may return hex strings
    return { $binary: true, size: typeof v === 'string' ? v.length : null };
  }
  if (col.kind === 'decimal') {
    // Keep DECIMAL/NUMERIC as exact strings. Values arrive as JSON numbers from
    // Mapepire; for precision <= 15 they are exact, so render with the declared scale.
    if (typeof v === 'number')
      return col.scale > 0 && col.precision <= 15 ? v.toFixed(col.scale) : String(v);
    return String(v);
  }
  if (col.kind === 'integer' && typeof v === 'number' && !Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/** Map a Mapepire row (array when terse, object otherwise) onto ordered cells. */
export function normalizeRow(row: unknown, cols: ResultColumn[]): Cell[] {
  if (Array.isArray(row)) return cols.map((c, i) => normalizeCell(row[i], c));
  const obj = (row ?? {}) as Record<string, unknown>;
  return cols.map((c) => normalizeCell(obj[c.name] ?? obj[c.label], c));
}
