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
  /**
   * True when exact values cannot be guaranteed for this column: BIGINT or a
   * DECIMAL/NUMERIC/DECFLOAT wider than 15 digits on a Node.js runtime whose
   * JSON.parse lacks source-text access (see JSON_SOURCE_TEXT_SUPPORTED).
   */
  precisionAtRisk?: boolean;
}

/**
 * @ibm/mapepire-js 1.0.2 parses every server message with
 * `JSON.parse(text, (k, v, ctx) => ctx && typeof v === 'number' && String(v) !== ctx.source ? ctx.source : v)`.
 * On runtimes that pass the reviver a source-text context (V8 JSON.parse source
 * text access: Node.js 22+), any JSON number that would not round-trip through a
 * double (e.g. 12345678901234567890 or 1.50) is delivered as its exact source
 * string, so no SQL CAST is needed. On older runtimes the context is absent and
 * wide numbers are rounded before Uncle Bob ever sees them.
 */
export const JSON_SOURCE_TEXT_SUPPORTED: boolean = (() => {
  let ok = false;
  JSON.parse('1', (_k, v, ...rest: unknown[]) => {
    const ctx = rest[0] as { source?: unknown } | undefined;
    ok = typeof ctx?.source === 'string';
    return v;
  });
  return ok;
})();

const isWideExact = (c: { type: string; kind: ColumnKind; precision: number }) =>
  c.type.toUpperCase() === 'BIGINT' ||
  (c.kind === 'decimal' && (c.precision > 15 || c.precision === 0));

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

export function toColumns(
  meta: ColumnMetaData[] | undefined,
  sourceTextSupported: boolean = JSON_SOURCE_TEXT_SUPPORTED,
): ResultColumn[] {
  return (meta ?? []).map((c, i) =>
    withRisk(sourceTextSupported, {
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
    }),
  );
}

function withRisk(supported: boolean, c: ResultColumn): ResultColumn {
  return !supported && isWideExact(c) ? { ...c, precisionAtRisk: true } : c;
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
    // DECIMAL / NUMERIC / DECFLOAT are always exact strings in the API. A string
    // here is the untouched JSON source text from mapepire-js (see above).
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return String(v);
      // A number reaching us round-trips (String(v) === source) when source text
      // access is available; padding to the declared scale is exact for <= 15 digits.
      return col.scale > 0 && col.precision <= 15 ? v.toFixed(col.scale) : String(v);
    }
    return String(v);
  }
  if (col.kind === 'integer' && col.type.toUpperCase() === 'BIGINT') {
    // BIGINT is always a string in the API so clients never parse it into a double.
    return typeof v === 'number' || typeof v === 'string' ? String(v).trim() : JSON.stringify(v);
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
