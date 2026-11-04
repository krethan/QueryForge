import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  CalcError,
  compile,
  evaluate,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_LENGTH,
  parse,
  type CalcType,
  type ColumnResolver,
} from '../src/catalog/calc-expr.js';
import {
  buildJoinedReportSql,
  type JoinedReportSpec,
  type ResolvedSource,
} from '../src/catalog/join-builder.js';
import type { CatalogColumn } from '../src/catalog/sql-builder.js';
import {
  availableColumns,
  defaultDetailColumns,
  deriveDetailSpec,
  groupFields,
} from '../src/reports/drill.js';
import { FakeMetadataDb } from './helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from './helpers/fake-mapepire.js';
import { testConfig } from './helpers/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ColDef = [string, string, number | null, number | null];
const DEFS: Record<string, ColDef[]> = {
  ORDER_LINES: [
    ['LINE_ID', 'INTEGER', 10, 0],
    ['ORDER_ID', 'INTEGER', 10, 0],
    ['ITEM', 'CHAR', 8, null],
    ['QTY', 'INTEGER', 10, 0],
    ['UNITPRICE', 'DECIMAL', 9, 2],
    ['NOTE', 'CLOB', 1000, null],
    ['PHOTO', 'BLOB', 1000, null],
  ],
  ORDERS: [
    ['ORDER_ID', 'INTEGER', 10, 0],
    ['REGION', 'CHAR', 5, null],
    ['ORDER_DATE', 'DATE', null, null],
    ['STAMP', 'TIMESTAMP', null, null],
    ['SHIP_TIME', 'TIME', null, null],
  ],
};
const cols = (defs: ColDef[]): CatalogColumn[] =>
  defs.map(([name, type, precision, scale], i) => ({
    name,
    type,
    length: precision,
    precision,
    scale,
    nullable: true,
    text: null,
    ordinal: i + 1,
  }));
const src = (name: string): ResolvedSource => ({
  table: { schema: 'DEMOLIB', name, type: 'T', text: null },
  columns: cols(DEFS[name]),
});

/** Resolver over ORDER_LINES (base, no alias) and ORDERS (alias O). */
const TYPES: Record<string, CalcType> = {
  QTY: 'integer',
  UNITPRICE: 'decimal',
  ITEM: 'char',
  'O.ORDER_DATE': 'date',
  'O.STAMP': 'timestamp',
  'O.REGION': 'char',
};
const resolver: ColumnResolver = (ref, pos) => {
  const key = ref.table ? `${ref.table}.${ref.column}` : ref.column;
  const type = TYPES[key];
  if (!type) throw new CalcError(`Unknown column ${key}`, pos);
  return { sql: `"${ref.table ?? 'T1'}"."${ref.column}"`, type, label: key };
};
const sqlOf = (e: string) => compile(parse(e), resolver).sql;
const typeOf = (e: string) => compile(parse(e), resolver).type;
const err = (e: string) => {
  try {
    compile(parse(e), resolver);
  } catch (x) {
    if (x instanceof CalcError) return x.message;
    throw x;
  }
  return 'NO_ERROR';
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'OK';
};

// ---------------------------------------------------------------------------
// Parser + type checker
// ---------------------------------------------------------------------------

describe('calculated field expressions', () => {
  it('compiles arithmetic with every node parenthesised', () => {
    expect(sqlOf('UNITPRICE * QTY')).toBe('(("T1"."UNITPRICE") * ("T1"."QTY"))');
    expect(sqlOf('-(QTY + 1) * 2')).toBe('((-(("T1"."QTY") + (1))) * (2))');
    expect(typeOf('UNITPRICE * QTY')).toBe('decimal');
    expect(typeOf('QTY + 1')).toBe('integer');
    expect(typeOf('QTY * 1.5')).toBe('decimal');
  });

  it('guards every divisor with NULLIF and marks integer division', () => {
    expect(sqlOf('UNITPRICE / QTY')).toBe('(("T1"."UNITPRICE") / NULLIF(("T1"."QTY"), 0))');
    expect(sqlOf('QTY / 2')).toBe('(INTEGER(("T1"."QTY") / NULLIF((2), 0)))');
    expect(typeOf('QTY / 2')).toBe('integer');
    expect(typeOf('QTY / 2.0')).toBe('decimal');
  });

  it('re-serializes literals from their parsed value', () => {
    expect(sqlOf('QTY + 007')).toBe('(("T1"."QTY") + (7))');
    expect(sqlOf('QTY + 1.50')).toBe('(("T1"."QTY") + (1.50))');
    expect(sqlOf('QTY + .5')).toBe('(("T1"."QTY") + (0.5))');
    expect(sqlOf("ITEM || 'it''s'")).toBe(`(("T1"."ITEM") || ('it''s'))`);
    expect(sqlOf("CASE WHEN O.ORDER_DATE >= DATE '2026-01-01' THEN 1 ELSE 0 END")).toBe(
      `(CASE WHEN ("O"."ORDER_DATE") >= (DATE('2026-01-01')) THEN 1 ELSE 0 END)`,
    );
    // a quote-breaking attempt stays inside one re-quoted literal
    expect(sqlOf("ITEM || ''' OR 1=1 --'")).toBe(`(("T1"."ITEM") || (''' OR 1=1 --'))`);
  });

  it('supports CASE, NULL tests, booleans and the function list', () => {
    expect(typeOf("CASE WHEN QTY > 10 AND NOT ITEM = 'X' THEN 'Bulk' ELSE 'Each' END")).toBe(
      'char',
    );
    expect(typeOf('CASE WHEN ITEM IS NOT NULL OR QTY IS NULL THEN QTY END')).toBe('integer');
    expect(typeOf('COALESCE(UNITPRICE, 0)')).toBe('decimal');
    expect(typeOf('NULLIF(QTY, 0)')).toBe('integer');
    expect(sqlOf('ROUND(UNITPRICE * 1.05, 2)')).toBe('(ROUND(("T1"."UNITPRICE") * (1.05), 2))');
    expect(sqlOf('ROUND(UNITPRICE)')).toBe('(ROUND("T1"."UNITPRICE", 0))');
    expect(typeOf('ABS(QTY)')).toBe('integer');
    expect(typeOf('UPPER(TRIM(LOWER(ITEM)))')).toBe('char');
    expect(sqlOf('SUBSTR(ITEM, 1, 3)')).toBe('(SUBSTRING("T1"."ITEM", 1, 3))');
    expect(typeOf('LENGTH(ITEM)')).toBe('integer');
    expect(typeOf('YEAR(O.ORDER_DATE) * 100 + MONTH(O.STAMP)')).toBe('integer');
    expect(typeOf('DAY(O.ORDER_DATE)')).toBe('integer');
    expect(typeOf('O.ORDER_DATE')).toBe('date');
    expect(sqlOf('"O"."REGION"')).toBe('("O"."REGION")');
    expect(sqlOf('qty + unitprice')).toBe('(("T1"."QTY") + ("T1"."UNITPRICE"))');
  });

  it('rejects unknown syntax with a helpful message and position', () => {
    expect(err('QTY; DROP TABLE X')).toMatch(/Unexpected character ";" at position 4/);
    expect(err('SLEEP(10)')).toMatch(/Unknown function SLEEP.*Supported: COALESCE/);
    expect(err('INTEGER(QTY)')).toMatch(/Unknown function INTEGER/);
    expect(err('QTY +')).toMatch(/Expected a column, number, text or function but found the end/);
    expect(err('(QTY')).toMatch(/Expected "\)"/);
    expect(err('QTY QTY')).toMatch(/Expected an operator/);
    expect(err("'abc")).toMatch(/missing its closing '/);
    expect(err('QTY -- comment')).toMatch(/Unknown column COMMENT/); // -- is two minus signs, not a comment
    expect(err('QTY /* x */')).toMatch(/Unexpected character|Expected/);
    expect(err('?')).toMatch(/Unexpected character "\?"/);
    expect(err('12abc')).toMatch(/after the number/);
    expect(err("DATE '2026-02-30'")).toMatch(/not a valid date/);
    expect(err('CASE QTY WHEN 1 THEN 2 END')).toMatch(/Expected WHEN after CASE/);
    expect(err('NOPE + 1')).toMatch(/Unknown column NOPE/);
  });

  it('type-checks operands', () => {
    expect(err('ITEM + 1')).toMatch(/Plus \(\+\) needs numbers, but got character.*Use \|\|/);
    expect(err('QTY || ITEM')).toMatch(/\|\| needs character data, but got number/);
    expect(err('O.ORDER_DATE + 1')).toMatch(/Date arithmetic is not supported/);
    expect(err("QTY = 'A'")).toMatch(/Cannot compare number with character/);
    expect(err('O.ORDER_DATE = O.STAMP')).toMatch(/Cannot compare date with timestamp/);
    expect(err('QTY = NULL')).toMatch(/use IS NULL/);
    expect(err('QTY > 1')).toMatch(/cannot be a bare true\/false condition.*CASE WHEN/);
    expect(err('NULL')).toMatch(/cannot be just NULL/);
    expect(err('CASE WHEN QTY THEN 1 END')).toMatch(/WHEN must be a condition/);
    expect(err("CASE WHEN QTY > 1 THEN 1 ELSE 'x' END")).toMatch(/CASE mixes number and character/);
    expect(err('ROUND(QTY, 1.5)')).toMatch(/whole number of decimal places/);
    expect(err('ROUND(QTY, QTY)')).toMatch(/whole number/);
    expect(err('ABS(QTY, 1)')).toMatch(/ABS takes 1 argument, not 2/);
    expect(err('YEAR(QTY)')).toMatch(/YEAR needs a date or timestamp/);
    expect(err('COALESCE(QTY)')).toMatch(/COALESCE takes 2 to 10 arguments/);
    expect(err('UPPER(QTY)')).toMatch(/UPPER needs character data/);
  });

  it('caps length, nesting depth and token count', () => {
    expect(err('QTY + ' + '1'.repeat(MAX_EXPRESSION_LENGTH))).toMatch(/longer than 1000/);
    expect(
      err('('.repeat(MAX_EXPRESSION_DEPTH + 1) + 'QTY' + ')'.repeat(MAX_EXPRESSION_DEPTH + 1)),
    ).toMatch(/nested more than/);
    expect(err('-'.repeat(60) + 'QTY')).toMatch(/nested more than/);
    expect(err(Array.from({ length: 300 }, () => '1').join('+'))).toMatch(/too long/);
    expect(err('1' + '0'.repeat(40))).toMatch(/more than 31 digits/);
    expect(err(`'${'x'.repeat(201)}'`)).toMatch(/longer than 200/);
    expect(err("'a\u0001b'")).toMatch(/control character/);
    expect(err('   ')).toMatch(/Enter an expression/);
  });

  it('evaluates like the generated SQL (demo engine)', () => {
    const row: Record<string, string | number | null> = {
      QTY: 3,
      UNITPRICE: 2.5,
      ITEM: 'WIDGET',
      'O.ORDER_DATE': '2026-03-14',
    };
    const ev = (e: string, internal = false) =>
      evaluate(
        parse(e, { internal }),
        (r) => row[r.table ? `${r.table}.${r.column}` : r.column] ?? null,
      );
    expect(ev('UNITPRICE * QTY')).toBe(7.5);
    expect(ev('QTY / 0')).toBeNull();
    expect(ev('INTEGER(7 / 2)', true)).toBe(3);
    expect(ev("CASE WHEN QTY > 2 THEN 'Bulk' ELSE 'Each' END")).toBe('Bulk');
    expect(ev('ROUND(2.345, 2)')).toBe(2.35);
    expect(ev('SUBSTRING(ITEM, 2, 3)')).toBe('IDG');
    expect(ev('YEAR(O.ORDER_DATE)')).toBe(2026);
    expect(ev('COALESCE(NULL, QTY)')).toBe(3);
    expect(ev('MISSING + 1')).toBeNull();
    // the demo can re-parse what compile() produced
    const generated = compile(parse('QTY / 2'), resolver).sql.replace(/"T1"\./g, '');
    expect(ev(generated, true)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SQL generation inside a report
// ---------------------------------------------------------------------------

const EXT = { id: 'C1', name: 'Extended Price', expression: 'UNITPRICE * QTY' };
const BAND = {
  id: 'C2',
  name: 'Size Band',
  expression: "CASE WHEN QTY >= 10 THEN 'Bulk' ELSE 'Each' END",
};
const lines = (over: Partial<JoinedReportSpec> = {}): JoinedReportSpec => ({
  schema: 'DEMOLIB',
  table: 'ORDER_LINES',
  columns: ['ITEM', { table: '@CALC', column: 'C1' }],
  calculated: [EXT],
  ...over,
});
const SRC = [src('ORDER_LINES')];

describe('calculated fields in buildJoinedReportSql', () => {
  it('selects the expression under the field name and reports its type', () => {
    const out = buildJoinedReportSql(
      lines({ sort: [{ table: '@CALC', column: 'C1', direction: 'DESC' }] }),
      SRC,
    );
    expect(out.sql).toBe(
      'SELECT "T1"."ITEM",\n       (("T1"."UNITPRICE") * ("T1"."QTY")) AS "Extended Price"\n' +
        'FROM "DEMOLIB"."ORDER_LINES" AS "T1"\n' +
        'ORDER BY (("T1"."UNITPRICE") * ("T1"."QTY")) DESC',
    );
    expect(out.columns[1]).toEqual({
      alias: '@CALC',
      table: '',
      column: 'C1',
      name: 'Extended Price',
    });
    expect(out.calculated).toEqual([{ ...EXT, type: 'decimal' }]);
    expect(out.parameters).toEqual([]);
  });

  it('filters, groups, totals and HAVING on calculated fields with bound values', () => {
    const out = buildJoinedReportSql(
      lines({
        calculated: [EXT, BAND],
        columns: [{ table: '@CALC', column: 'C2' }],
        filters: [{ table: '@CALC', column: 'C1', op: '>', value: 10 }],
        groupBy: [{ table: '@CALC', column: 'C2' }],
        aggregates: [
          { fn: 'SUM', table: '@CALC', column: 'C1' },
          { fn: 'AVG', table: '@CALC', column: 'C1', name: 'Avg Ext' },
        ],
        having: [{ aggregate: 'SUM_Extended_Price', op: '>', value: 1 }],
        sort: [{ table: '@CALC', column: 'C2', direction: 'ASC' }],
      }),
      SRC,
    );
    const band = `(CASE WHEN ("T1"."QTY") >= (10) THEN 'Bulk' ELSE 'Each' END)`;
    const ext = '(("T1"."UNITPRICE") * ("T1"."QTY"))';
    expect(out.sql).toBe(
      `SELECT ${band} AS "Size Band",\n` +
        `       SUM(${ext}) AS "SUM_Extended_Price",\n` +
        `       AVG(${ext}) AS "Avg Ext"\n` +
        'FROM "DEMOLIB"."ORDER_LINES" AS "T1"\n' +
        `WHERE ${ext} > ?\n` +
        `GROUP BY ${band}\n` +
        `HAVING SUM(${ext}) > ?\n` +
        `ORDER BY ${band} ASC`,
    );
    expect(out.parameters.map((p) => [p.type, p.defaultValue])).toEqual([
      ['decimal', '10'],
      ['decimal', '1'],
    ]);
  });

  it('works with joins, qualified columns and text filters', () => {
    const out = buildJoinedReportSql(
      {
        schema: 'DEMOLIB',
        table: 'ORDER_LINES',
        joins: [
          {
            schema: 'DEMOLIB',
            table: 'ORDERS',
            alias: 'O',
            type: 'INNER',
            on: [{ left: { table: 'T1', column: 'ORDER_ID' }, right: { column: 'ORDER_ID' } }],
          },
        ],
        columns: [{ table: '@CALC', column: 'K' }],
        calculated: [{ id: 'K', name: 'Order Year', expression: 'YEAR(O.ORDER_DATE)' }],
        filters: [{ table: '@CALC', column: 'K', op: '=', value: 2026 }],
      },
      [src('ORDER_LINES'), src('ORDERS')],
    );
    expect(out.sql).toContain('(YEAR("O"."ORDER_DATE")) AS "Order Year"');
    expect(out.sql).toContain('WHERE (YEAR("O"."ORDER_DATE")) = ?');
    expect(out.parameters[0].type).toBe('integer');
  });

  it('rejects bad definitions and references', () => {
    const with_ = (calculated: unknown, over: Partial<JoinedReportSpec> = {}) =>
      code(() => buildJoinedReportSql(lines({ calculated: calculated as never, ...over }), SRC));
    expect(with_([{ ...EXT, expression: 'QTY; DROP' }])).toBe('INVALID_CALCULATION');
    expect(with_([{ ...EXT, expression: 'NOTE || ITEM' }])).toBe('INVALID_CALCULATION'); // CLOB
    expect(with_([{ ...EXT, expression: 'LENGTH(PHOTO)' }])).toBe('INVALID_CALCULATION'); // BLOB
    expect(with_([{ ...EXT, expression: 'GONE * 2' }])).toBe('INVALID_CALCULATION');
    expect(with_([{ ...EXT, expression: 'X.QTY * 2' }])).toBe('INVALID_CALCULATION');
    expect(with_([{ ...EXT, expression: '"@CALC"."C1" + 1' }])).toBe('INVALID_CALCULATION');
    expect(with_([{ ...EXT, id: '1bad' }])).toBe('INVALID_CALCULATION');
    expect(with_([{ ...EXT, name: 'Bad"Name' }])).toBe('INVALID_CALCULATION');
    expect(with_([EXT, { ...BAND, id: 'c1' }])).toBe('INVALID_CALCULATION');
    expect(with_([EXT, { ...BAND, name: 'extended price' }])).toBe('DUPLICATE_OUTPUT_NAME');
    expect(with_([{ ...EXT, name: 'ITEM' }])).toBe('DUPLICATE_OUTPUT_NAME');
    expect(with_([EXT], { columns: [{ table: '@CALC', column: 'C9' }] })).toBe('UNKNOWN_COLUMN');
    expect(
      with_(Array.from({ length: 21 }, (_, i) => ({ ...EXT, id: `C${i}`, name: `N${i}` }))),
    ).toBe('TOO_MANY_CALCULATIONS');
    expect(
      with_([BAND], {
        columns: [],
        aggregates: [{ fn: 'SUM', table: '@CALC', column: 'C2' }],
      }),
    ).toBe('INVALID_AGGREGATE');
    // the error carries the position for the editor
    try {
      buildJoinedReportSql(lines({ calculated: [{ ...EXT, expression: 'QTY ** 2' }] }), SRC);
    } catch (e) {
      expect((e as { details?: { position?: number } }).details?.position).toBe(5);
      expect((e as Error).message).toMatch(/^Calculated field "Extended Price": /);
    }
  });
});

describe('drill on calculated groups', () => {
  const grouped = lines({
    calculated: [EXT, BAND],
    columns: [{ table: '@CALC', column: 'C2' }],
    groupBy: [{ table: '@CALC', column: 'C2' }],
    aggregates: [{ fn: 'SUM', table: '@CALC', column: 'C1', name: 'Revenue' }],
  });

  it('filters the detail query on the calculated expression', () => {
    const g = buildJoinedReportSql(grouped, SRC);
    const fields = groupFields(grouped, g.columns);
    expect(fields).toEqual([{ name: 'Size Band', table: '@CALC', column: 'C2' }]);
    const columns = defaultDetailColumns(grouped, g.aliases, SRC, fields);
    expect(columns.slice(0, 2)).toEqual([
      { table: '@CALC', column: 'C2' },
      { table: '@CALC', column: 'C1' },
    ]);
    const d = deriveDetailSpec(grouped, fields, { 'Size Band': 'Bulk' }, columns);
    const built = buildJoinedReportSql(d.spec, SRC);
    expect(built.sql).toContain(
      `WHERE (CASE WHEN ("T1"."QTY") >= (10) THEN 'Bulk' ELSE 'Each' END) = ?`,
    );
    expect(built.sql).not.toContain('GROUP BY');
    expect(built.parameters[0].defaultValue).toBe('Bulk');
    const empty = deriveDetailSpec(grouped, fields, { 'Size Band': null }, columns);
    expect(buildJoinedReportSql(empty.spec, SRC).sql).toContain('END) IS NULL');
    expect(availableColumns(g.aliases, SRC, g.calculated)[0]).toEqual({
      table: '@CALC',
      column: 'C1',
      label: 'ƒ Extended Price',
      type: 'decimal',
    });
  });
});

// ---------------------------------------------------------------------------
// API: validation endpoint, preview, versioned builder definitions
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:5173';
const PW = 'correct horse battery staple';
const hash = bcrypt.hashSync(PW, 4);
let app: ReturnType<typeof createApp>['app'];
let db: FakeMetadataDb;
let runs: { sql: string; params: unknown[] }[];

beforeEach(() => {
  db = new FakeMetadataDb();
  db.addUser({ id: 'u-alice', username: 'alice', hash, displayName: 'Alice' });
  runs = [];
  const script = (sql: string, parameters?: unknown[]): Scripted => {
    const s = sql.toUpperCase();
    const p = (parameters ?? []).map(String);
    if (s.includes('__CONNECT__')) return { columns: [], rows: [] };
    if (s.includes('QSYS2.SYSREFCST')) return { columns: [], rows: [] };
    if (s.includes('QSYS2.SYSTABLES')) {
      const [schema, table] = p.slice(-2);
      return {
        columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'TABLE_TEXT', 'TABLE_OWNER'].map(
          (n) => col(n, 'VARCHAR', 128),
        ),
        rows: schema === 'DEMOLIB' && DEFS[table] ? [['DEMOLIB', table, 'T', null, 'QSECOFR']] : [],
      };
    }
    if (s.includes('QSYS2.SYSCOLUMNS'))
      return {
        columns: ['N', 'T', 'L', 'P', 'S', 'NUL', 'TXT', 'O'].map((n) => col(n, 'VARCHAR', 128)),
        rows: (DEFS[p[1]] ?? []).map(([n, t, pr, sc], i) => [n, t, pr, pr, sc, 'Y', null, i + 1]),
      };
    runs.push({ sql, params: parameters ?? [] });
    return { columns: [col('Extended Price', 'DECIMAL', 11)], rows: [[7.5]] };
  };
  app = createApp({
    cfg: testConfig(),
    metadataDb: db,
    jobFactory: fakeFactory(script).factory,
  }).app;
});

async function login() {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username: 'alice', password: PW });
  expect(res.status).toBe(200);
  const csrf = /qf_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
  const w = <T extends request.Test>(t: T) => t.set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return {
    post: (url: string) => w(agent.post(url)),
    get: (url: string) => agent.get(url).set('Origin', ORIGIN),
  };
}

const apiSpec = {
  schema: 'DEMOLIB',
  table: 'ORDER_LINES',
  columns: ['ITEM', { table: '@CALC', column: 'C1' }],
  calculated: [EXT],
};

describe('calculated fields API', () => {
  it('validates an expression for the live editor', async () => {
    const api = await login();
    const v = (expression: string, extra = {}) =>
      api
        .post('/api/schema/calc/validate')
        .send({ schema: 'DEMOLIB', table: 'ORDER_LINES', expression, ...extra });
    const ok = await v('UNITPRICE * QTY');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ok: true,
      type: 'decimal',
      hint: 'number',
      columns: ['T1.UNITPRICE', 'T1.QTY'],
    });
    const bad = await v('UNITPRICE * ');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error.position).toBe(12);
    expect(bad.body.error.message).toMatch(/Expected a column/);
    const joined = await v("O.REGION || '-' || ITEM", {
      joins: [{ schema: 'DEMOLIB', table: 'ORDERS', alias: 'O' }],
    });
    expect(joined.body).toMatchObject({ ok: true, type: 'char', hint: 'character' });
    expect((await v('x'.repeat(1002))).status).toBe(400);
    expect((await v('QTY', { table: 'SECRET' })).status).toBe(404);
    expect(runs).toHaveLength(0); // nothing is executed
  });

  it('previews and runs the built SQL; the browser never sends SQL', async () => {
    const api = await login();
    const pv = await api.post('/api/schema/sql').send(apiSpec);
    expect(pv.status).toBe(200);
    expect(pv.body.sql).toContain('(("T1"."UNITPRICE") * ("T1"."QTY")) AS "Extended Price"');
    expect(pv.body.calculated).toEqual([{ ...EXT, type: 'decimal' }]);
    const run = await api.post('/api/schema/run').send(apiSpec);
    expect(run.status).toBe(200);
    expect(runs.at(-1)!.sql).toContain('AS "Extended Price"');
    const bad = await api
      .post('/api/schema/run')
      .send({ ...apiSpec, calculated: [{ ...EXT, expression: '1); DELETE FROM X; --' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CALCULATION');
  });

  it('stores calculated fields in a version 2 definition with the inferred type', async () => {
    const api = await login();
    const res = await api.post('/api/reports').send({
      name: 'Line values',
      sql: 'ignored',
      builderDef: { version: 2, spec: { ...apiSpec, calculated: [{ ...EXT, type: 'char' }] } },
    });
    expect(res.status).toBe(201);
    const stored = JSON.parse(String(db.reports.get(res.body.report.id)!.BUILDER_DEF));
    expect(stored.version).toBe(2);
    expect(stored.spec.calculated).toEqual([{ ...EXT, type: 'decimal' }]); // recomputed
    expect(res.body.report.sql).toContain('AS "Extended Price"');
    const got = await api.get(`/api/reports/${res.body.report.id}`);
    expect(got.body.builder).toEqual({ valid: true });
  });

  it('keeps version 1 definitions loading and running unchanged', async () => {
    const api = await login();
    const v1 = { version: 1, spec: { schema: 'DEMOLIB', table: 'ORDER_LINES', columns: ['ITEM'] } };
    const res = await api.post('/api/reports').send({ name: 'Old', sql: 'x', builderDef: v1 });
    expect(res.status).toBe(201);
    expect(res.body.report.sql).toBe('SELECT "ITEM"\nFROM "DEMOLIB"."ORDER_LINES"');
    expect(JSON.parse(String(db.reports.get(res.body.report.id)!.BUILDER_DEF))).toEqual(v1);
    // a v1 definition cannot smuggle calculated fields past the version check
    const smuggled = await api
      .post('/api/reports')
      .send({ name: 'Sneaky', sql: 'x', builderDef: { version: 1, spec: apiSpec } });
    expect(smuggled.body.error.code).toBe('INVALID_BUILDER_DEF');
    expect(smuggled.body.error.message).toMatch(/use version 2/);
  });

  it('exports calculated columns to Excel as values, never formulas', async () => {
    const api = await login();
    const id = (
      await api
        .post('/api/reports')
        .send({ name: 'Calc export', sql: 'x', builderDef: { version: 2, spec: apiSpec } })
    ).body.report.id;
    const res = await api
      .post('/api/export')
      .send({ reportId: id })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(runs.at(-1)!.sql).toContain('AS "Extended Price"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const s = wb.worksheets[0];
    expect(s.getCell('A1').value).toBe('Extended Price');
    expect(s.getCell('A2').value).toBe(7.5);
    expect(s.getCell('A2').formula).toBeUndefined();
  });
});
