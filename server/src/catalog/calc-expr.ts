/**
 * Calculated fields: a small, hand-written expression language for the Report Builder.
 *
 * SECURITY: the browser sends the expression *text* only. It is tokenized and parsed
 * here into an AST (no eval, no SQL pass-through). Every column is resolved against
 * cached QSYS2 catalog metadata by the caller's resolver, every operator and function
 * comes from a fixed list and is written as SQL text by this module, and literals are
 * RE-SERIALIZED from their parsed, typed value (numbers re-formatted from digits,
 * strings re-quoted with `'` doubled, dates validated and re-printed) - the input text
 * of a literal is never copied into the statement.
 *
 * Literals are inlined rather than bound as `?` markers because one calculated field
 * can appear several times in one statement (SELECT, GROUP BY, ORDER BY, WHERE,
 * HAVING) and Db2 for i requires a grouped expression to match the SELECT expression
 * exactly; inlining the re-serialized literal keeps those copies identical and keeps
 * the `?` order of the report's filter parameters unchanged.
 *
 * Division: `a / b` compiles to `(a) / NULLIF((b), 0)`, so dividing by zero yields
 * NULL instead of failing the query (SQLSTATE 22012). As in Db2, integer / integer
 * truncates toward zero.
 */

export const MAX_EXPRESSION_LENGTH = 1000;
export const MAX_EXPRESSION_DEPTH = 20;
export const MAX_EXPRESSION_TOKENS = 500;
export const MAX_STRING_LITERAL = 200;
export const MAX_NUMBER_DIGITS = 31;
export const MAX_CALCULATED = 20;
/** Pseudo table alias used by the rest of a report spec to refer to a calculated field. */
export const CALC_TABLE = '@CALC';
export const CALC_ID = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;

export type CalcType = 'integer' | 'decimal' | 'char' | 'date' | 'timestamp';
type T = CalcType | 'bool' | 'null';

export const FUNCTIONS = [
  'COALESCE',
  'NULLIF',
  'ROUND',
  'ABS',
  'UPPER',
  'LOWER',
  'TRIM',
  'SUBSTR',
  'LENGTH',
  'YEAR',
  'MONTH',
  'DAY',
] as const;
/** Accepted spellings that map to a supported function. */
const ALIASES: Record<string, string> = { SUBSTRING: 'SUBSTR' };
/** Only accepted when re-parsing SQL this module generated (the demo engine). */
const INTERNAL_FUNCTIONS = ['INTEGER'];

export class CalcError extends Error {
  constructor(
    message: string,
    /** 0-based character offset in the expression. */
    public position: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'num' | 'str' | 'ident' | 'qident' | 'op' | 'eof';
interface Tok {
  k: TokKind;
  v: string;
  pos: number;
}

const OPS = ['||', '<>', '!=', '<=', '>=', '+', '-', '*', '/', '(', ')', ',', '.', '=', '<', '>'];

function hasControl(s: string) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s);
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (/[0-9]/.test(src[i] ?? '')) i++;
      if (src[i] === '.') {
        i++;
        while (/[0-9]/.test(src[i] ?? '')) i++;
      }
      if (/[A-Za-z_]/.test(src[i] ?? ''))
        throw new CalcError(`Unexpected "${src[i]}" after the number at position ${start + 1}.`, i);
      out.push({ k: 'num', v: src.slice(start, i), pos: start });
    } else if (ch === "'") {
      i++;
      let s = '';
      for (;;) {
        if (i >= src.length)
          throw new CalcError(
            `Text starting at position ${start + 1} is missing its closing '.`,
            start,
          );
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ k: 'str', v: s, pos: start });
    } else if (ch === '"') {
      i++;
      let s = '';
      for (;;) {
        if (i >= src.length)
          throw new CalcError(
            `Quoted name at position ${start + 1} is missing its closing ".`,
            start,
          );
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      if (!s.trim()) throw new CalcError(`Empty quoted name at position ${start + 1}.`, start);
      out.push({ k: 'qident', v: s, pos: start });
    } else if (/[A-Za-z_]/.test(ch)) {
      while (/[A-Za-z0-9_$#@]/.test(src[i] ?? '')) i++;
      out.push({ k: 'ident', v: src.slice(start, i).toUpperCase(), pos: start });
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op)
        throw new CalcError(
          `Unexpected character ${JSON.stringify(ch)} at position ${start + 1}. Only columns, numbers, 'text', operators (+ - * / ||, comparisons) and the listed functions are allowed.`,
          start,
        );
      i += op.length;
      out.push({ k: 'op', v: op === '!=' ? '<>' : op, pos: start });
    }
    if (out.length > MAX_EXPRESSION_TOKENS)
      throw new CalcError(
        `The expression is too long (more than ${MAX_EXPRESSION_TOKENS} parts).`,
        start,
      );
  }
  out.push({ k: 'eof', v: '', pos: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export interface ColumnRefNode {
  k: 'col';
  table?: string;
  column: string;
  pos: number;
}
export type Node =
  | ColumnRefNode
  | { k: 'num'; digits: string; scale: number; neg?: false; pos: number }
  | { k: 'str'; value: string; pos: number }
  | { k: 'date'; value: string; pos: number }
  | { k: 'null'; pos: number }
  | { k: 'neg'; a: Node; pos: number }
  | { k: 'not'; a: Node; pos: number }
  | { k: 'bin'; op: string; a: Node; b: Node; pos: number }
  | { k: 'isnull'; a: Node; not: boolean; pos: number }
  | { k: 'case'; whens: { c: Node; t: Node }[]; else?: Node; pos: number }
  | { k: 'fn'; name: string; args: Node[]; pos: number };

const KEYWORDS = new Set(['CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IS', 'NULL']);
const CMP = new Set(['=', '<>', '<', '<=', '>', '>=']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(s: string) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export interface ParseOptions {
  /** Accept forms only this module generates (used by the demo engine). */
  internal?: boolean;
}

export function parse(src: string, opts: ParseOptions = {}): Node {
  if (typeof src !== 'string' || !src.trim()) throw new CalcError('Enter an expression.', 0);
  if (src.length > MAX_EXPRESSION_LENGTH)
    throw new CalcError(
      `The expression is longer than ${MAX_EXPRESSION_LENGTH} characters.`,
      MAX_EXPRESSION_LENGTH,
    );
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().k === 'op' && peek().v === v;
  const isKw = (v: string) => peek().k === 'ident' && peek().v === v;
  const describe = (t: Tok) =>
    t.k === 'eof' ? 'the end of the expression' : `"${t.k === 'str' ? `'${t.v}'` : t.v}"`;
  const fail = (what: string): never => {
    const t = peek();
    throw new CalcError(
      `Expected ${what} but found ${describe(t)} at position ${t.pos + 1}.`,
      t.pos,
    );
  };
  const expectOp = (v: string) => (isOp(v) ? toks[p++] : fail(`"${v}"`));
  const expectKw = (v: string) => (isKw(v) ? toks[p++] : fail(v));
  const nest = <R>(pos: number, f: () => R): R => {
    if (++depth > MAX_EXPRESSION_DEPTH)
      throw new CalcError(
        `The expression is nested more than ${MAX_EXPRESSION_DEPTH} levels deep.`,
        pos,
      );
    try {
      return f();
    } finally {
      depth--;
    }
  };

  const orExpr = (): Node =>
    nest(peek().pos, () => {
      let a = andExpr();
      while (isKw('OR')) {
        const t = toks[p++];
        a = { k: 'bin', op: 'OR', a, b: andExpr(), pos: t.pos };
      }
      return a;
    });
  const andExpr = (): Node => {
    let a = notExpr();
    while (isKw('AND')) {
      const t = toks[p++];
      a = { k: 'bin', op: 'AND', a, b: notExpr(), pos: t.pos };
    }
    return a;
  };
  const notExpr = (): Node => {
    if (isKw('NOT')) {
      const t = toks[p++];
      return nest(t.pos, () => ({ k: 'not', a: notExpr(), pos: t.pos }));
    }
    return cmpExpr();
  };
  const cmpExpr = (): Node => {
    const a = addExpr();
    if (peek().k === 'op' && CMP.has(peek().v)) {
      const t = toks[p++];
      return { k: 'bin', op: t.v, a, b: addExpr(), pos: t.pos };
    }
    if (isKw('IS')) {
      const t = toks[p++];
      const not = isKw('NOT');
      if (not) p++;
      expectKw('NULL');
      return { k: 'isnull', a, not, pos: t.pos };
    }
    return a;
  };
  const addExpr = (): Node => {
    let a = mulExpr();
    while (isOp('+') || isOp('-') || isOp('||')) {
      const t = toks[p++];
      a = { k: 'bin', op: t.v, a, b: mulExpr(), pos: t.pos };
    }
    return a;
  };
  const mulExpr = (): Node => {
    let a = unary();
    while (isOp('*') || isOp('/')) {
      const t = toks[p++];
      a = { k: 'bin', op: t.v, a, b: unary(), pos: t.pos };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      const t = toks[p++];
      return nest(t.pos, () => ({ k: 'neg', a: unary(), pos: t.pos }));
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return primary();
  };
  const name = (): string => {
    const t = peek();
    if (t.k === 'qident') {
      p++;
      return t.v;
    }
    if (t.k === 'ident' && !KEYWORDS.has(t.v)) {
      p++;
      return t.v;
    }
    return fail('a column name');
  };
  const primary = (): Node => {
    const t = peek();
    if (t.k === 'num') {
      p++;
      const [int, frac = ''] = t.v.split('.');
      const digits = (int + frac).replace(/^0+(?=\d)/, '') || '0';
      if (digits.replace(/^0+/, '').length > MAX_NUMBER_DIGITS)
        throw new CalcError(
          `The number at position ${t.pos + 1} has more than ${MAX_NUMBER_DIGITS} digits.`,
          t.pos,
        );
      return { k: 'num', digits, scale: t.v.includes('.') ? frac.length : -1, pos: t.pos };
    }
    if (t.k === 'str') {
      p++;
      if (t.v.length > MAX_STRING_LITERAL)
        throw new CalcError(
          `Text at position ${t.pos + 1} is longer than ${MAX_STRING_LITERAL} characters.`,
          t.pos,
        );
      if (hasControl(t.v))
        throw new CalcError(`Text at position ${t.pos + 1} contains a control character.`, t.pos);
      return { k: 'str', value: t.v, pos: t.pos };
    }
    if (t.k === 'op' && t.v === '(') {
      p++;
      const e = nest(t.pos, orExpr);
      expectOp(')');
      return e;
    }
    if (t.k === 'qident') return column();
    if (t.k !== 'ident') return fail('a column, number, text or function');
    if (t.v === 'NULL') {
      p++;
      return { k: 'null', pos: t.pos };
    }
    if (t.v === 'CASE') {
      p++;
      return nest(t.pos, () => {
        const whens: { c: Node; t: Node }[] = [];
        while (isKw('WHEN')) {
          p++;
          const c = orExpr();
          expectKw('THEN');
          whens.push({ c, t: orExpr() });
        }
        if (!whens.length) fail('WHEN after CASE');
        let el: Node | undefined;
        if (isKw('ELSE')) {
          p++;
          el = orExpr();
        }
        expectKw('END');
        return { k: 'case', whens, else: el, pos: t.pos } as Node;
      });
    }
    if (KEYWORDS.has(t.v)) return fail('a column, number, text or function');
    if (
      t.v === 'DATE' &&
      (toks[p + 1].k === 'str' || (toks[p + 1].v === '(' && toks[p + 2]?.k === 'str'))
    ) {
      p++;
      const paren = isOp('(');
      if (paren) p++;
      const s = toks[p++];
      if (paren) expectOp(')');
      if (!validDate(s.v))
        throw new CalcError(`DATE '${s.v}' is not a valid date; use DATE 'YYYY-MM-DD'.`, s.pos);
      return { k: 'date', value: s.v, pos: t.pos };
    }
    if (toks[p + 1].k === 'op' && toks[p + 1].v === '(') {
      const fname = ALIASES[t.v] ?? t.v;
      const known =
        (FUNCTIONS as readonly string[]).includes(fname) ||
        (opts.internal && INTERNAL_FUNCTIONS.includes(fname));
      if (!known)
        throw new CalcError(
          `Unknown function ${t.v} at position ${t.pos + 1}. Supported: ${FUNCTIONS.join(', ')}, and CASE WHEN … THEN … ELSE … END.`,
          t.pos,
        );
      p += 2;
      return nest(t.pos, () => {
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(orExpr());
          while (isOp(',')) {
            p++;
            args.push(orExpr());
          }
        }
        expectOp(')');
        return { k: 'fn', name: fname, args, pos: t.pos } as Node;
      });
    }
    return column();
  };
  const column = (): Node => {
    const pos = peek().pos;
    const first = name();
    if (isOp('.')) {
      p++;
      return { k: 'col', table: first, column: name(), pos };
    }
    return { k: 'col', column: first, pos };
  };

  const root = orExpr();
  if (peek().k !== 'eof') fail('an operator or the end of the expression');
  return root;
}

// ---------------------------------------------------------------------------
// Type checking + SQL generation
// ---------------------------------------------------------------------------

export interface ResolvedColumn {
  /** SQL for the column, e.g. `"T1"."QTY"` (built by the caller from catalog names). */
  sql: string;
  type: CalcType;
  label: string;
}
export type ColumnResolver = (
  ref: { table?: string; column: string },
  pos: number,
) => ResolvedColumn;

export interface CompiledCalc {
  sql: string;
  type: CalcType;
  /** Columns used, as given by the resolver (deduplicated by label). */
  columns: string[];
}

const isNum = (t: T) => t === 'integer' || t === 'decimal';
const family = (t: T) => (isNum(t) ? 'number' : t);
export const TYPE_HINT: Record<CalcType, string> = {
  integer: 'number',
  decimal: 'number',
  char: 'character',
  date: 'date',
  timestamp: 'timestamp',
};
const say = (t: T) =>
  t === 'bool' ? 'a true/false condition' : t === 'null' ? 'NULL' : TYPE_HINT[t];

/** Merge two result types that must be the same family (NULL fits anything). */
function merge(a: T, b: T, pos: number, what: string): T {
  if (a === 'null') return b;
  if (b === 'null') return a;
  if (isNum(a) && isNum(b)) return a === 'integer' && b === 'integer' ? 'integer' : 'decimal';
  if (a === b) return a;
  throw new CalcError(`${what} mixes ${say(a)} and ${say(b)} (position ${pos + 1}).`, pos);
}

function numLiteral(digits: string, scale: number) {
  if (scale < 0) return digits;
  const padded = digits.padStart(scale + 1, '0');
  return scale === 0 ? `${padded}.` : `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

export function compile(root: Node, resolve: ColumnResolver): CompiledCalc {
  const cols = new Set<string>();
  const needNum = (n: Node, fn: string) => {
    const r = walk(n);
    if (r.t !== 'null' && !isNum(r.t))
      throw new CalcError(
        `${fn} needs a number, but got ${say(r.t)} (position ${n.pos + 1}).`,
        n.pos,
      );
    return r;
  };
  const needChar = (n: Node, fn: string) => {
    const r = walk(n);
    if (r.t !== 'null' && r.t !== 'char')
      throw new CalcError(
        `${fn} needs character data, but got ${say(r.t)} (position ${n.pos + 1}).`,
        n.pos,
      );
    return r;
  };
  const needBool = (n: Node, what: string) => {
    const r = walk(n);
    if (r.t !== 'bool')
      throw new CalcError(
        `${what} must be a condition (for example A > 0 or B IS NULL), but got ${say(r.t)} (position ${n.pos + 1}).`,
        n.pos,
      );
    return r;
  };
  const notBool = (n: Node, what: string) => {
    const r = walk(n);
    if (r.t === 'bool')
      throw new CalcError(
        `${what} cannot be a true/false condition; wrap it in CASE WHEN … THEN … ELSE … END (position ${n.pos + 1}).`,
        n.pos,
      );
    return r;
  };
  const arity = (n: { name: string; args: Node[]; pos: number }, min: number, max: number) => {
    if (n.args.length < min || n.args.length > max)
      throw new CalcError(
        `${n.name} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? '' : 's'}, not ${n.args.length} (position ${n.pos + 1}).`,
        n.pos,
      );
  };

  function walk(n: Node): { sql: string; t: T } {
    switch (n.k) {
      case 'num':
        return { sql: numLiteral(n.digits, n.scale), t: n.scale < 0 ? 'integer' : 'decimal' };
      case 'str':
        return { sql: `'${n.value.replace(/'/g, "''")}'`, t: 'char' };
      case 'date':
        if (!validDate(n.value)) throw new CalcError('Invalid date.', n.pos);
        return { sql: `DATE('${n.value}')`, t: 'date' };
      case 'null':
        return { sql: 'NULL', t: 'null' };
      case 'col': {
        if (typeof n.column !== 'string' || !n.column)
          throw new CalcError('A column name is missing.', n.pos);
        const r = resolve({ table: n.table, column: n.column }, n.pos);
        cols.add(r.label);
        return { sql: r.sql, t: r.type };
      }
      case 'neg': {
        const a = needNum(n.a, 'Minus');
        return { sql: `-(${a.sql})`, t: a.t === 'null' ? 'integer' : a.t };
      }
      case 'not': {
        const a = needBool(n.a, 'NOT');
        return { sql: `NOT (${a.sql})`, t: 'bool' };
      }
      case 'isnull': {
        const a = notBool(n.a, 'IS NULL');
        return { sql: `(${a.sql}) IS ${n.not ? 'NOT ' : ''}NULL`, t: 'bool' };
      }
      case 'bin': {
        if (n.op === 'AND' || n.op === 'OR') {
          const a = needBool(n.a, n.op);
          const b = needBool(n.b, n.op);
          return { sql: `(${a.sql}) ${n.op} (${b.sql})`, t: 'bool' };
        }
        if (CMP.has(n.op)) {
          const a = notBool(n.a, 'A comparison');
          const b = notBool(n.b, 'A comparison');
          if (a.t !== 'null' && b.t !== 'null' && family(a.t) !== family(b.t))
            throw new CalcError(
              `Cannot compare ${say(a.t)} with ${say(b.t)} (position ${n.pos + 1}).`,
              n.pos,
            );
          if (a.t === 'null' || b.t === 'null')
            throw new CalcError(
              `Comparing with NULL is never true; use IS NULL or IS NOT NULL (position ${n.pos + 1}).`,
              n.pos,
            );
          return { sql: `(${a.sql}) ${n.op} (${b.sql})`, t: 'bool' };
        }
        if (n.op === '||') {
          const a = needChar(n.a, '||');
          const b = needChar(n.b, '||');
          return { sql: `(${a.sql}) || (${b.sql})`, t: 'char' };
        }
        const sym =
          n.op === '+' ? 'Plus' : n.op === '-' ? 'Minus' : n.op === '*' ? 'Times' : 'Divide';
        const a = walk(n.a);
        const b = walk(n.b);
        for (const [x, node] of [
          [a, n.a],
          [b, n.b],
        ] as const)
          if (x.t !== 'null' && !isNum(x.t))
            throw new CalcError(
              `${sym} (${n.op}) needs numbers, but got ${say(x.t)} (position ${node.pos + 1}).${x.t === 'char' && n.op === '+' ? ' Use || to join text.' : ''}${x.t === 'date' || x.t === 'timestamp' ? ' Date arithmetic is not supported.' : ''}`,
              node.pos,
            );
        const t: T = a.t === 'integer' && b.t === 'integer' ? 'integer' : 'decimal';
        if (n.op === '/') {
          const div = `(${a.sql}) / NULLIF((${b.sql}), 0)`;
          // INTEGER(...) is a no-op on Db2 (int / int already truncates); it marks the
          // truncation explicitly so the demo engine can reproduce it.
          return { sql: t === 'integer' ? `INTEGER(${div})` : div, t };
        }
        return { sql: `(${a.sql}) ${n.op} (${b.sql})`, t };
      }
      case 'case': {
        let t: T = 'null';
        const parts = n.whens.map((w) => {
          const c = needBool(w.c, 'WHEN');
          const r = notBool(w.t, 'THEN');
          t = merge(t, r.t, w.t.pos, 'CASE');
          return `WHEN ${c.sql} THEN ${r.sql}`;
        });
        let el = '';
        if (n.else) {
          const r = notBool(n.else, 'ELSE');
          t = merge(t, r.t, n.else.pos, 'CASE');
          el = ` ELSE ${r.sql}`;
        }
        if (t === 'null')
          throw new CalcError(
            `CASE needs at least one result that is not NULL (position ${n.pos + 1}).`,
            n.pos,
          );
        return { sql: `CASE ${parts.join(' ')}${el} END`, t };
      }
      case 'fn':
        return fn(n);
    }
  }

  function fn(n: { k: 'fn'; name: string; args: Node[]; pos: number }): { sql: string; t: T } {
    const A = n.args;
    switch (n.name) {
      case 'COALESCE': {
        arity(n, 2, 10);
        let t: T = 'null';
        const parts = A.map((x) => {
          const r = notBool(x, 'COALESCE');
          t = merge(t, r.t, x.pos, 'COALESCE');
          return r.sql;
        });
        return { sql: `COALESCE(${parts.join(', ')})`, t };
      }
      case 'NULLIF': {
        arity(n, 2, 2);
        const a = notBool(A[0], 'NULLIF');
        const b = notBool(A[1], 'NULLIF');
        merge(a.t, b.t, n.pos, 'NULLIF');
        return { sql: `NULLIF(${a.sql}, ${b.sql})`, t: a.t };
      }
      case 'ROUND': {
        arity(n, 1, 2);
        const a = needNum(A[0], 'ROUND');
        let places = 0;
        if (A[1]) {
          const d = A[1];
          const neg = d.k === 'neg' && d.a.k === 'num' ? d.a : null;
          const lit = d.k === 'num' ? d : neg;
          if (!lit || lit.scale >= 0)
            throw new CalcError(
              `ROUND's second argument must be a whole number of decimal places, like 2 (position ${d.pos + 1}).`,
              d.pos,
            );
          places = Number(lit.digits) * (neg ? -1 : 1);
          if (places < -15 || places > 15)
            throw new CalcError(
              `ROUND places must be between -15 and 15 (position ${d.pos + 1}).`,
              d.pos,
            );
        }
        return { sql: `ROUND(${a.sql}, ${places})`, t: a.t === 'null' ? 'decimal' : a.t };
      }
      case 'ABS': {
        arity(n, 1, 1);
        const a = needNum(A[0], 'ABS');
        return { sql: `ABS(${a.sql})`, t: a.t === 'null' ? 'decimal' : a.t };
      }
      case 'UPPER':
      case 'LOWER':
      case 'TRIM': {
        arity(n, 1, 1);
        const a = needChar(A[0], n.name);
        return { sql: `${n.name}(${a.sql})`, t: 'char' };
      }
      case 'SUBSTR': {
        arity(n, 2, 3);
        const a = needChar(A[0], 'SUBSTR');
        const parts = [a.sql, ...A.slice(1).map((x) => needNum(x, 'SUBSTR position/length').sql)];
        // SUBSTRING does not fail when the range runs past the end of the value (SUBSTR can).
        return { sql: `SUBSTRING(${parts.join(', ')})`, t: 'char' };
      }
      case 'LENGTH': {
        arity(n, 1, 1);
        const a = needChar(A[0], 'LENGTH');
        return { sql: `LENGTH(${a.sql})`, t: 'integer' };
      }
      case 'YEAR':
      case 'MONTH':
      case 'DAY': {
        arity(n, 1, 1);
        const r = walk(A[0]);
        if (r.t !== 'null' && r.t !== 'date' && r.t !== 'timestamp')
          throw new CalcError(
            `${n.name} needs a date or timestamp, but got ${say(r.t)} (position ${A[0].pos + 1}).`,
            A[0].pos,
          );
        return { sql: `${n.name}(${r.sql})`, t: 'integer' };
      }
      case 'INTEGER': {
        arity(n, 1, 1);
        const a = needNum(A[0], 'INTEGER');
        return { sql: `INTEGER(${a.sql})`, t: 'integer' };
      }
    }
    throw new CalcError(`Unknown function ${n.name}.`, n.pos);
  }

  const r = walk(root);
  if (r.t === 'bool')
    throw new CalcError(
      'A calculated field cannot be a bare true/false condition; use CASE WHEN condition THEN … ELSE … END.',
      0,
    );
  if (r.t === 'null') throw new CalcError('A calculated field cannot be just NULL.', 0);
  return { sql: `(${r.sql})`, type: r.t, columns: [...cols] };
}

/** Map a catalog column type to a calculated-field type, or null if it cannot be used. */
export function calcTypeOf(dataType: string, scale: number | null): CalcType | null {
  const t = dataType.toUpperCase().trim();
  if (/^(SMALLINT|INTEGER|INT|BIGINT)$/.test(t)) return 'integer';
  if (/^(DECIMAL|NUMERIC)$/.test(t)) return (scale ?? 0) === 0 ? 'integer' : 'decimal';
  if (/^(DECFLOAT|REAL|FLOAT|DOUBLE|DOUBLE PRECISION)$/.test(t)) return 'decimal';
  if (/^(CHAR|CHARACTER|VARCHAR|GRAPHIC|VARGRAPHIC|NCHAR|NVARCHAR)$/.test(t)) return 'char';
  if (t === 'DATE') return 'date';
  if (t === 'TIMESTAMP' || t === 'TIMESTMP') return 'timestamp';
  return null;
}

/** Db2 type used for the synthetic catalog column that stands for a calculated field. */
export function calcCatalogType(t: CalcType): { type: string; scale: number | null } {
  switch (t) {
    case 'integer':
      return { type: 'INTEGER', scale: 0 };
    case 'decimal':
      return { type: 'DECIMAL', scale: null };
    case 'char':
      return { type: 'VARCHAR', scale: null };
    case 'date':
      return { type: 'DATE', scale: null };
    case 'timestamp':
      return { type: 'TIMESTAMP', scale: null };
  }
}

// ---------------------------------------------------------------------------
// Evaluation (demo engine only: JavaScript numbers, not Db2 decimal arithmetic)
// ---------------------------------------------------------------------------

export type CalcValue = string | number | boolean | null;

const asDate = (v: CalcValue) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Evaluate an AST against one row. `lookup` returns a column's value. */
export function evaluate(
  n: Node,
  lookup: (ref: { table?: string; column: string }) => CalcValue,
): CalcValue {
  const ev = (x: Node) => evaluate(x, lookup);
  switch (n.k) {
    case 'num':
      return Number(numLiteral(n.digits, n.scale));
    case 'str':
      return n.value;
    case 'date':
      return n.value;
    case 'null':
      return null;
    case 'col':
      return lookup({ table: n.table, column: n.column });
    case 'neg': {
      const a = ev(n.a);
      return a === null ? null : -Number(a);
    }
    case 'not': {
      const a = ev(n.a);
      return a === null ? null : !a;
    }
    case 'isnull': {
      const a = ev(n.a);
      return n.not ? a !== null : a === null;
    }
    case 'bin': {
      if (n.op === 'AND') {
        const a = ev(n.a);
        const b = ev(n.b);
        if (a === false || b === false) return false;
        return a === null || b === null ? null : true;
      }
      if (n.op === 'OR') {
        const a = ev(n.a);
        const b = ev(n.b);
        if (a === true || b === true) return true;
        return a === null || b === null ? null : false;
      }
      const a = ev(n.a);
      const b = ev(n.b);
      if (a === null || b === null) return null;
      if (CMP.has(n.op)) {
        const [x, y] =
          typeof a === 'number' || typeof b === 'number'
            ? [Number(a), Number(b)]
            : [String(a).trimEnd(), String(b).trimEnd()];
        const c = x < y ? -1 : x > y ? 1 : 0;
        return { '=': c === 0, '<>': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[
          n.op
        ]!;
      }
      if (n.op === '||') return String(a) + String(b);
      const x = Number(a);
      const y = Number(b);
      if (n.op === '+') return x + y;
      if (n.op === '-') return x - y;
      if (n.op === '*') return x * y;
      return y === 0 ? null : x / y;
    }
    case 'case': {
      for (const w of n.whens) if (ev(w.c) === true) return ev(w.t);
      return n.else ? ev(n.else) : null;
    }
    case 'fn': {
      const args = n.args.map(ev);
      const [a, b, c] = args;
      switch (n.name) {
        case 'COALESCE':
          return args.find((v) => v !== null) ?? null;
        case 'NULLIF':
          return a !== null && b !== null && String(a) === String(b) ? null : a;
      }
      if (a === null || a === undefined) return null;
      switch (n.name) {
        case 'ROUND': {
          const f = 10 ** Number(b ?? 0);
          const v = Number(a);
          return (Math.sign(v) * Math.round(Math.abs(v) * f)) / f;
        }
        case 'ABS':
          return Math.abs(Number(a));
        case 'UPPER':
          return String(a).toUpperCase();
        case 'LOWER':
          return String(a).toLowerCase();
        case 'TRIM':
          return String(a).trim();
        case 'SUBSTR': {
          if (b === null || c === null) return null;
          const s = String(a);
          const start = Math.max(Number(b), 1) - 1;
          return c === undefined ? s.slice(start) : s.slice(start, Number(b) - 1 + Number(c));
        }
        case 'LENGTH':
          return String(a).length;
        case 'YEAR':
        case 'MONTH':
        case 'DAY': {
          const d = asDate(a);
          return d ? d[n.name === 'YEAR' ? 0 : n.name === 'MONTH' ? 1 : 2] : null;
        }
        case 'INTEGER':
          return Math.trunc(Number(a));
      }
      return null;
    }
  }
}
