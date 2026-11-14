import { db2i, formatDialect } from 'sql-formatter';

/**
 * Db2 for i friendly SQL formatting.
 *
 * `sql-formatter` (db2i dialect) only decides where line breaks and indentation go: the result
 * is rebuilt from the ORIGINAL token texts, so 'strings', "delimited identifiers", comments,
 * keyword case and the order of `?` markers can never change; only the whitespace between
 * tokens does. Pairs the formatter must not split are kept together (`LIB/FILE` system naming,
 * `LIB.FILE`, `X'0A'`-style literals, `:host` variables). Anything unexpected (a parse error,
 * a token the formatter changed, dropped or added) gives `ok: false` and the caller leaves the
 * text alone.
 */

export type SqlTokenKind =
  'word' | 'number' | 'string' | 'quoted' | 'line-comment' | 'block-comment' | 'marker' | 'op';

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
  from: number;
  to: number;
}

export interface LexResult {
  tokens: SqlToken[];
  /** Set when a string, delimited identifier or block comment runs off the end of the text. */
  unterminated?: 'string' | 'quoted' | 'block-comment';
}

const TWO_CHAR_OPS = new Set([
  '<>',
  '<=',
  '>=',
  '!=',
  '¬=',
  '^=',
  '¬<',
  '¬>',
  '!<',
  '!>',
  '||',
  '!!',
  '=>',
  '->',
  '::',
  '**',
]);
const WORD_START = /[A-Za-z_#@$\u00C0-\uFFFF]/;
const WORD_CHAR = /[A-Za-z0-9_#@$\u00C0-\uFFFF]/;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Splits SQL into tokens, skipping whitespace. 'Strings' ('' escapes), "delimited identifiers"
 * ("" escapes), -- line comments and block comments are single tokens, as in the server lexer.
 */
export function lexSql(sql: string): LexResult {
  const tokens: SqlToken[] = [];
  let unterminated: LexResult['unterminated'];
  const n = sql.length;
  let i = 0;
  const push = (kind: SqlTokenKind, to: number) => {
    tokens.push({ kind, text: sql.slice(i, to), from: i, to });
    i = to;
  };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++;
      push('line-comment', j);
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) unterminated ??= 'block-comment';
      push('block-comment', end < 0 ? n : end + 2);
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) {
          unterminated ??= c === "'" ? 'string' : 'quoted';
          break;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else {
            j++;
            break;
          }
        } else j++;
      }
      push(c === "'" ? 'string' : 'quoted', Math.min(j, n));
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      push('number', i + NUMBER.exec(sql.slice(i))![0].length);
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      push('word', j);
    } else if (c === '?') {
      push('marker', i + 1);
    } else if (TWO_CHAR_OPS.has(sql.slice(i, i + 2))) {
      push('op', i + 2);
    } else {
      push('op', i + 1);
    }
  }
  return { tokens, unterminated };
}

const isName = (t: SqlToken | undefined) => t?.kind === 'word' || t?.kind === 'quoted';

/** `LIB/FILE` system naming: a `/` written with a name directly on both sides, no spaces. */
function isSystemSlash(toks: SqlToken[], i: number): boolean {
  const [a, t, b] = [toks[i - 1], toks[i], toks[i + 1]];
  return t?.text === '/' && isName(a) && isName(b) && a.to === t.from && t.to === b.from;
}

/**
 * True when tokens `i - 1` and `i`, written with nothing between them in the original, must
 * stay together: a space there would change the meaning or break Db2 for i syntax.
 */
function mustStayGlued(toks: SqlToken[], i: number): boolean {
  const a = toks[i - 1];
  const b = toks[i];
  if (a.to !== b.from) return false;
  if (a.text === '.' || b.text === '.') return true; // LIB.FILE, T1.COL, T1.*, "S"."T"
  if ((a.kind === 'word' || a.kind === 'number') && (b.kind === 'string' || b.kind === 'quoted'))
    return true; // X'0A', G'…', UX'…', N'…'
  if (a.text === ':' && isName(b)) return true; // :HOSTVAR
  return isSystemSlash(toks, i) || isSystemSlash(toks, i - 1); // LIB/FILE
}

export type FormatResult =
  { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

export interface FormatOptions {
  /** Added after every line break the formatter introduces (for a selection that starts indented). */
  indent?: string;
}

const same = (a: SqlToken[], b: SqlToken[]) =>
  a.length === b.length && a.every((t, i) => t.kind === b[i].kind && t.text === b[i].text);

/** Formats `sql` (one or more statements), changing only the whitespace between tokens. */
export function formatSql(sql: string, opts: FormatOptions = {}): FormatResult {
  const src = lexSql(sql);
  if (src.tokens.length === 0) return { ok: false, reason: 'There is no SQL to format.' };
  if (src.unterminated) {
    const what =
      src.unterminated === 'string'
        ? 'a string'
        : src.unterminated === 'quoted'
          ? 'a "delimited identifier"'
          : 'a comment';
    return { ok: false, reason: `The SQL has ${what} that is never closed.` };
  }
  let formatted: string;
  try {
    formatted = formatDialect(sql, {
      dialect: db2i,
      keywordCase: 'preserve',
      identifierCase: 'preserve',
      dataTypeCase: 'preserve',
      functionCase: 'preserve',
      tabWidth: 2,
      paramTypes: { positional: true },
      linesBetweenQueries: 1,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    const where = /line (\d+) column (\d+)/i.exec(msg);
    return {
      ok: false,
      reason: where
        ? `The formatter could not read the SQL near line ${where[1]}, column ${where[2]}.`
        : 'The formatter could not read this SQL.',
    };
  }
  const out = lexSql(formatted).tokens;
  const comment = (k: SqlTokenKind) => k === 'line-comment' || k === 'block-comment';
  const matches =
    out.length === src.tokens.length &&
    out.every((t, i) => {
      const s = src.tokens[i];
      return t.kind === s.kind && (comment(t.kind) || t.text === s.text);
    });
  if (!matches) return { ok: false, reason: 'The formatter would have changed more than spacing.' };

  const toks = src.tokens;
  let text = '';
  for (let i = 0; i < toks.length; i++) {
    if (i > 0) {
      const prev = toks[i - 1];
      let gap = formatted.slice(out[i - 1].to, out[i].from);
      if (mustStayGlued(toks, i)) gap = '';
      if (prev.kind === 'line-comment' && !gap.includes('\n')) gap = '\n';
      gap = gap.replace(/[ \t]+\n/g, '\n');
      if (opts.indent) gap = gap.replace(/\n/g, `\n${opts.indent}`);
      text += gap;
    }
    text += toks[i].text; // the original text, so comments are byte-for-byte unchanged
  }
  if (!same(lexSql(text).tokens, toks))
    return { ok: false, reason: 'The formatter would have changed more than spacing.' };
  return { ok: true, text, changed: text !== sql };
}

export interface FormatEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Formats the selected part of `doc` (or the whole text when the selection is empty or blank).
 * Leading and trailing whitespace of the part is left where it is; a selection that starts on an
 * indented line keeps that indentation on its new lines.
 */
export function formatRange(
  doc: string,
  sel: { from: number; to: number },
): ({ ok: true; changed: boolean; edit: FormatEdit } | { ok: false; reason: string }) & {
  scope: 'selection' | 'all';
} {
  let from = Math.max(0, Math.min(sel.from, sel.to));
  let to = Math.min(doc.length, Math.max(sel.from, sel.to));
  let scope: 'selection' | 'all' = 'selection';
  if (to <= from || !doc.slice(from, to).trim()) {
    from = 0;
    to = doc.length;
    scope = 'all';
  }
  const part = doc.slice(from, to);
  from += part.length - part.trimStart().length;
  to -= part.length - part.trimEnd().length;
  const lineStart = doc.lastIndexOf('\n', from - 1) + 1;
  const indent = scope === 'selection' ? /^[ \t]*/.exec(doc.slice(lineStart, from))![0] : '';
  const r = formatSql(doc.slice(from, to), { indent });
  if (!r.ok) return { ...r, scope };
  return { ok: true, changed: r.changed, edit: { from, to, insert: r.text }, scope };
}
