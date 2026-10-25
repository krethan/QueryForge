import type { Cell, ResultColumn } from '../api/types';

export const NUMERIC_KINDS = new Set(['integer', 'decimal', 'float']);

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function isBinary(v: Cell): v is { $binary: true; size: number | null } {
  return typeof v === 'object' && v !== null && '$binary' in v;
}

/** Text shown in the grid; NULL is rendered separately so it never looks like an empty string. */
export function cellText(v: Cell, col: ResultColumn): string {
  if (v === null) return '';
  if (isBinary(v)) return `<binary${v.size != null ? ` ${v.size} bytes` : ''}>`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && col.kind === 'float') return String(v);
  return String(v);
}

const DECIMAL_RE = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/;

/**
 * Exact comparison of two plain decimal strings (no exponent) without going
 * through IEEE doubles, so DECIMAL(31,2) / BIGINT values beyond 2^53 sort
 * correctly. Returns null when either value is not a plain decimal.
 */
export function compareDecimalStrings(a: string, b: string): number | null {
  const ma = DECIMAL_RE.exec(a);
  const mb = DECIMAL_RE.exec(b);
  if (!ma || !mb || !(ma[2] || ma[3]) || !(mb[2] || mb[3])) return null;
  const norm = (m: RegExpExecArray) => {
    const int = (m[2] ?? '').replace(/^0+/, '');
    const frac = (m[3] ?? '').replace(/0+$/, '');
    const zero = !int && !frac;
    return { neg: m[1] === '-' && !zero, int, frac };
  };
  const x = norm(ma);
  const y = norm(mb);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  let c =
    x.int.length !== y.int.length
      ? x.int.length - y.int.length
      : x.int < y.int
        ? -1
        : x.int > y.int
          ? 1
          : 0;
  if (c === 0) {
    const len = Math.max(x.frac.length, y.frac.length);
    const fa = x.frac.padEnd(len, '0');
    const fb = y.frac.padEnd(len, '0');
    c = fa < fb ? -1 : fa > fb ? 1 : 0;
  }
  return c === 0 ? 0 : x.neg ? -Math.sign(c) : Math.sign(c);
}

/** Sort comparator: NULLs last, numeric columns compared numerically (decimals are strings). */
export function compareCells(a: Cell, b: Cell, col: ResultColumn): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (NUMERIC_KINDS.has(col.kind)) {
    if (col.kind !== 'float' && (typeof a === 'string' || typeof b === 'string')) {
      const exact = compareDecimalStrings(String(a), String(b));
      if (exact !== null) return exact;
    }
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  }
  return String(isBinary(a) ? '' : a).localeCompare(String(isBinary(b) ? '' : b), undefined, {
    numeric: true,
  });
}

export const statusLabel: Record<string, string> = {
  NEVER: 'Never run',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  TIMED_OUT: 'Timed out',
  CANCELLED: 'Cancelled',
};

export const statusTagType = (s: string) =>
  (
    ({
      SUCCEEDED: 'green',
      FAILED: 'red',
      TIMED_OUT: 'magenta',
      CANCELLED: 'warm-gray',
      RUNNING: 'blue',
    }) as Record<string, string>
  )[s] ?? 'gray';

export const newExecutionId = () => crypto.randomUUID();
