/**
 * Small Db2 for i SQL lexer used for statement validation. It does not try to be
 * a full parser: it only needs to classify text into comments, string literals,
 * delimited identifiers, ordinary identifiers/keywords, numbers and symbols, so
 * that keyword checks are never fooled by comments, literals or quoting.
 */
export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'symbol' | 'comment';

export interface Token {
  type: TokenType;
  /** Upper-cased for words; raw inner text for quoted identifiers (case preserved). */
  value: string;
  start: number;
  end: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
  }
}

const WORD_START = /[A-Za-z_#@$\u00C0-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_#@$\u00C0-\uFFFF]/;

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // -- line comment
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      tokens.push({ type: 'comment', value: sql.slice(start, i), start, end: i });
      continue;
    }
    // /* block comment */  (nested openers are rejected: dialect behaviour differs)
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      let closed = false;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*')
          throw new LexError('Nested block comments are not allowed', i);
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new LexError('Unterminated block comment', start);
      tokens.push({ type: 'comment', value: sql.slice(start, i), start, end: i });
      continue;
    }
    // 'string literal' ('' escapes). Prefixes such as X'..', G'..', N'..', UX'..' lex as word + string.
    if (c === "'") {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new LexError('Unterminated string literal', start);
      tokens.push({ type: 'string', value: sql.slice(start, i), start, end: i });
      continue;
    }
    // "delimited identifier" ("" escapes)
    if (c === '"') {
      const start = i;
      i++;
      let val = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        val += sql[i++];
      }
      if (!closed) throw new LexError('Unterminated delimited identifier', start);
      tokens.push({ type: 'quoted', value: val, start, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9.]/.test(sql[i])) i++;
      if (/[eE]/.test(sql[i] ?? '') && /[-+0-9]/.test(sql[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9]/.test(sql[i])) i++;
      }
      tokens.push({ type: 'number', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (WORD_START.test(c)) {
      const start = i;
      while (i < n && WORD_PART.test(sql[i])) i++;
      tokens.push({ type: 'word', value: sql.slice(start, i).toUpperCase(), start, end: i });
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '||', '¬=', '=>'].includes(two)) {
      tokens.push({ type: 'symbol', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ type: 'symbol', value: c, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}
