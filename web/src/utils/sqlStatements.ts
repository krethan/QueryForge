import type { ParameterDef } from '../api/types';

/** A half-open character range `[from, to)` in the editor text. */
export interface TextRange {
  from: number;
  to: number;
}

interface Scan {
  /** Trimmed statement ranges (terminating `;` excluded); comment-only pieces are dropped. */
  statements: TextRange[];
  /** Offsets of `?` parameter markers outside strings, delimited identifiers and comments. */
  markers: number[];
}

/**
 * Splits editor text on top-level semicolons. Semicolons and `?` inside 'string literals'
 * ('' escapes), "delimited identifiers" ("" escapes), -- line comments and block comments
 * are ignored, mirroring the server lexer. Unterminated literals or comments run to the
 * end of the text (the server reports the syntax error when the statement is run).
 */
export function scanSql(sql: string): Scan {
  const statements: TextRange[] = [];
  const markers: number[] = [];
  // first and last offset of real (non-comment, non-space) text in the current piece
  let first = -1;
  let last = -1;
  const close = () => {
    if (first >= 0) statements.push({ from: first, to: last + 1 });
    first = -1;
    last = -1;
  };
  const n = sql.length;
  for (let i = 0; i < n; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === ';') {
      close();
      continue;
    }
    if (first < 0) first = i;
    if (c === "'" || c === '"') {
      i++;
      while (i < n && !(sql[i] === c && sql[i + 1] !== c)) i += sql[i] === c ? 2 : 1;
      last = Math.min(i, n - 1);
      continue;
    }
    if (c === '?') markers.push(i);
    last = i;
  }
  close();
  return { statements, markers };
}

/** 1-based line number of a character offset. */
export function lineAt(sql: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) if (sql[i] === '\n') line++;
  return line;
}

export interface RunTarget {
  kind: 'selection' | 'statement';
  /** The exact text sent to the server. */
  text: string;
  range: TextRange;
  firstLine: number;
  lastLine: number;
  /** The parameter definitions for the markers inside this part, in order. */
  parameters: ParameterDef[];
  /** Set when the part cannot be run as-is (shown instead of calling the server). */
  error?: string;
}

/**
 * The statement under the cursor when the text holds several statements. A cursor between
 * statements (after a `;`, on a blank line) belongs to the statement before it, like IBM i
 * Access Client Solutions "Run Selected"; a cursor before the first one picks the first.
 */
export function statementAt(statements: TextRange[], pos: number): TextRange | undefined {
  let pick: TextRange | undefined = statements[0];
  for (const s of statements) {
    if (s.from <= pos) pick = s;
    else break;
  }
  return pick;
}

/**
 * Works out what Run should execute for the given editor selection:
 * - a non-blank selection runs just the selected text;
 * - with no selection, text holding more than one statement runs the statement at the cursor;
 * - otherwise `null`: Run executes the whole editor (or the saved report) as before.
 *
 * Parameter definitions are positional (one per `?`, in order, across the whole text), so the
 * part gets the definitions for the markers that fall inside it.
 */
export function resolveRunTarget(
  sql: string,
  selection: TextRange,
  defs: ParameterDef[],
): RunTarget | null {
  const { statements, markers } = scanSql(sql);
  const from = Math.max(0, Math.min(selection.from, selection.to, sql.length));
  const to = Math.min(sql.length, Math.max(selection.from, selection.to));
  let kind: RunTarget['kind'];
  let range: TextRange;
  const selected = sql.slice(from, to);
  if (to > from && selected.trim()) {
    kind = 'selection';
    const lead = selected.length - selected.trimStart().length;
    const trail = selected.length - selected.trimEnd().length;
    range = { from: from + lead, to: to - trail };
  } else {
    if (statements.length <= 1) return null;
    kind = 'statement';
    range = statementAt(statements, selection.to)!;
  }
  const text = sql.slice(range.from, range.to);
  const before = markers.filter((m) => m < range.from).length;
  const inside = markers.filter((m) => m >= range.from && m < range.to).length;
  const target: RunTarget = {
    kind,
    text,
    range,
    firstLine: lineAt(sql, range.from),
    lastLine: lineAt(sql, range.to - 1),
    parameters: [],
  };
  if (inside > 0) {
    if (defs.length !== markers.length)
      target.error = `The SQL has ${markers.length} parameter marker(s) (?) but ${defs.length} parameter(s) are defined. Define one parameter per marker, in order, before running part of the SQL.`;
    else target.parameters = defs.slice(before, before + inside);
  }
  return target;
}

/** "line 4" or "lines 4–7". */
export function describeLines(t: Pick<RunTarget, 'firstLine' | 'lastLine'>): string {
  return t.firstLine === t.lastLine ? `line ${t.firstLine}` : `lines ${t.firstLine}–${t.lastLine}`;
}
