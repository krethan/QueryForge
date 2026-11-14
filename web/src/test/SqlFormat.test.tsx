import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { api } from '../api/client';
import type { Report } from '../api/types';
import { ReportEditorPage } from '../pages/ReportEditorPage';
import { formatRange, formatSql, lexSql } from '../utils/sqlFormat';

vi.mock('../components/charts/ChartView', () => ({ default: () => <div /> }));

// jsdom has no layout: CodeMirror measures text ranges when the selection moves
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => ({ ...rect, toJSON: () => rect }) as DOMRect;

/** The non-whitespace token stream: what must be identical before and after formatting. */
const stream = (sql: string) => lexSql(sql).tokens.map((t) => `${t.kind}:${t.text}`);
const markersInOrder = (sql: string) =>
  lexSql(sql)
    .tokens.map((t, i, all) =>
      t.kind === 'marker' ? `${all[i - 2]?.text} ${all[i - 1]?.text} ?` : '',
    )
    .filter(Boolean);
const fmt = (sql: string) => {
  const r = formatSql(sql);
  if (!r.ok) throw new Error(r.reason);
  return r.text;
};

const corpus = [
  "select a, b, 'x  --y ; ?' as \"My  Col\" from mylib/myfile f join lib2.t2 on f.k=t2.k -- c  ?\nwhere a = ? and b in (?, ?) /* block ? */ and c like 'a%' fetch first 10 rows only",
  'with x as (select * from qsys2.sysschemas where schema_name like ?) select count(*) from x where schema_size>? order by 1 desc',
  'select * from table(qsys2.active_job_info(subsystem_list_filter => ?)) j',
  "SELECT CUSNUM, LSTNAM||', '||INIT AS NAME, CDTLMT-BALDUE FROM QIWS/QCUSTCDT WHERE STATE IN (?,?) AND CDTLMT>=? ORDER BY BALDUE DESC",
  'select rrn(f), f.* from "MyLib"."My""File" f, lateral (select 1 from sysibm.sysdummy1) y offset 5 rows fetch next ? rows only',
  "select case when a=1 then 'y' else 'n' end, coalesce(a,0), row_number() over (partition by b order by c) from t group by a,b having count(*)>1 union all select 1,2,3 from sysibm.sysdummy1",
  "select x'0A', ux'0041', g'abc', 1.5e3, .5, current date - 1 day from t where h = :hv and d <> ? and e != ?",
  "/* header\n     comment, indented ? 'not a string' */\nselect 1 from sysibm.sysdummy1;\nvalues ?;\nselect 'it''s' from t",
  'select a/b, 4/2, a / b, "Lib"/"File".c from "Lib"/"File"',
];

describe('lexSql', () => {
  it('keeps strings, delimited identifiers and comments whole and finds markers', () => {
    const toks = lexSql(
      `SELECT 'a ''?'' b' "X ""?"" Y", A.B -- x ?\n/* ? */ ? <> 1.5E2 X'0A'`,
    ).tokens;
    expect(toks.map((t) => [t.kind, t.text])).toEqual([
      ['word', 'SELECT'],
      ['string', "'a ''?'' b'"],
      ['quoted', '"X ""?"" Y"'],
      ['op', ','],
      ['word', 'A'],
      ['op', '.'],
      ['word', 'B'],
      ['line-comment', '-- x ?'],
      ['block-comment', '/* ? */'],
      ['marker', '?'],
      ['op', '<>'],
      ['number', '1.5E2'],
      ['word', 'X'],
      ['string', "'0A'"],
    ]);
  });
  it('flags unterminated text', () => {
    expect(lexSql("select 'open").unterminated).toBe('string');
    expect(lexSql('select "open').unterminated).toBe('quoted');
    expect(lexSql('select /* open').unterminated).toBe('block-comment');
  });
});

describe('formatSql keeps every token', () => {
  it.each(corpus.map((sql, i) => [i, sql]))(
    'corpus %i: same token stream, markers in order',
    (_i, sql) => {
      const out = fmt(sql as string);
      expect(stream(out)).toEqual(stream(sql as string));
      expect(markersInOrder(out)).toEqual(markersInOrder(sql as string));
      expect(out).toContain('\n'); // it really did reformat
      expect(fmt(out)).toBe(out); // and formatting again changes nothing
    },
  );

  it('only ever changes whitespace', () => {
    for (const sql of corpus) expect(fmt(sql).replace(/\s+/g, '')).toBe(sql.replace(/\s+/g, ''));
  });

  it('never touches strings, delimited identifiers or comments (byte for byte)', () => {
    const sql =
      'select \'two  spaces\n  and a line\' as "My  Col", a /* multi\n     line\n   * comment */ , b -- keep   trailing   \nfrom t';
    const out = fmt(sql);
    expect(out).toContain("'two  spaces\n  and a line'");
    expect(out).toContain('"My  Col"');
    expect(out).toContain('/* multi\n     line\n   * comment */');
    expect(out).toContain('-- keep   trailing   \n');
  });

  it('keeps LIB/FILE system naming and LIB.FILE together, and keeps keyword case', () => {
    const out = fmt('select * from mylib/myfile a join "Lib"/"File" b on a.k=b.k where a.x = 4/2');
    expect(out).toContain('mylib/myfile a');
    expect(out).toContain('"Lib"/"File" b');
    expect(out).toContain('a.k = b.k');
    expect(out).toContain('4 / 2'); // arithmetic is spaced like any other operator
    expect(out.startsWith('select\n')).toBe(true);
    expect(fmt('SELECT A / B FROM T')).toContain('A / B');
  });

  it('keeps prefixed literals and host variables glued', () => {
    const out = fmt("select x'0A', g'abc' from t where h=:hv");
    expect(out).toContain("x'0A'");
    expect(out).toContain("g'abc'");
    expect(out).toContain('h = :hv');
  });

  it('keeps the ? markers and their order exactly', () => {
    const sql = 'select * from t where a = ? and b between ? and ? or c in (?, ?, ?)';
    const out = fmt(sql);
    expect(out.match(/\?/g)).toHaveLength(6);
    expect(markersInOrder(out)).toEqual([
      'a = ?',
      'b between ?',
      '? and ?',
      'in ( ?',
      '? , ?',
      '? , ?',
    ]);
  });

  it('is a no-op with a reason when the SQL cannot be read', () => {
    expect(formatSql("select 'open from t")).toEqual({
      ok: false,
      reason: 'The SQL has a string that is never closed.',
    });
    expect(formatSql('select /* open')).toMatchObject({ ok: false, reason: /comment/ });
    expect(formatSql('select ) from')).toMatchObject({
      ok: false,
      reason: 'The formatter could not read the SQL near line 1, column 8.',
    });
    expect(formatSql('   ')).toMatchObject({ ok: false });
  });
});

describe('formatRange', () => {
  const doc = 'select 1 from sysibm.sysdummy1;\n\n  select a,b from t where c=?;\n';
  it('formats the whole text when nothing is selected, leaving outer whitespace alone', () => {
    const r = formatRange(doc, { from: 3, to: 3 });
    expect(r).toMatchObject({ ok: true, changed: true, scope: 'all' });
    if (!r.ok) throw new Error();
    expect(r.edit.from).toBe(0);
    expect(r.edit.to).toBe(doc.length - 1); // the trailing newline stays
    expect(stream(r.edit.insert)).toEqual(stream(doc));
  });
  it('formats only the selection and keeps the indentation of its first line', () => {
    const start = doc.indexOf('select a');
    const r = formatRange(doc, { from: start, to: doc.lastIndexOf(';') });
    if (!r.ok) throw new Error();
    expect(r.scope).toBe('selection');
    expect(r.edit.from).toBe(start);
    expect(r.edit.insert).toBe('select\n    a,\n    b\n  from\n    t\n  where\n    c = ?');
  });
  it('reports a selection that is already formatted as unchanged', () => {
    const r = formatRange('select\n  1', { from: 0, to: 0 });
    expect(r).toMatchObject({ ok: true, changed: false });
  });
});

// ---- the editor ----

const editorView = () => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('no editor');
  return view;
};
const doc = () => editorView().state.doc.toString();
const typeSql = (text: string) =>
  act(() => {
    const v = editorView();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  });
const select = (anchor: number, head = anchor) =>
  act(() => {
    editorView().dispatch({ selection: { anchor, head } });
  });
const actions = () => within(document.querySelector('.qf-editor-actions') as HTMLElement);

const openNew = () => {
  const router = createMemoryRouter([{ path: '/editor', element: <ReportEditorPage /> }], {
    initialEntries: ['/editor'],
  });
  render(<RouterProvider router={router} />);
};

describe('Format SQL in the editor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('formats everything from the toolbar and Ctrl+Z undoes it', async () => {
    openNew();
    const sql = 'select a,b from qiws/qcustcdt where state=? and cdtlmt>?';
    typeSql(sql);
    fireEvent.click(actions().getByRole('button', { name: 'Format SQL' }));
    expect(doc()).toBe(
      'select\n  a,\n  b\nfrom\n  qiws/qcustcdt\nwhere\n  state = ?\n  and cdtlmt > ?',
    );
    expect(await screen.findByText('Formatted the SQL.')).toBeInTheDocument();
    fireEvent.keyDown(editorView().contentDOM, { key: 'z', ctrlKey: true });
    expect(doc()).toBe(sql);
  });

  it('Shift+Alt+F formats only the selection and leaves the rest alone', async () => {
    openNew();
    const sql = 'select 1 from sysibm.sysdummy1;\nselect a,b from t';
    typeSql(sql);
    select(sql.indexOf('select a'), sql.length);
    fireEvent.keyDown(editorView().contentDOM, {
      key: 'F',
      code: 'KeyF',
      keyCode: 70,
      shiftKey: true,
      altKey: true,
    });
    expect(doc()).toBe('select 1 from sysibm.sysdummy1;\nselect\n  a,\n  b\nfrom\n  t');
    expect(await screen.findByText('Formatted the selected SQL.')).toBeInTheDocument();
    // the formatted part stays selected
    const { from, to } = editorView().state.selection.main;
    expect(doc().slice(from, to)).toBe('select\n  a,\n  b\nfrom\n  t');
  });

  it('leaves SQL it cannot read untouched with a gentle message', async () => {
    openNew();
    typeSql("select a from t where b = 'open");
    fireEvent.click(actions().getByRole('button', { name: 'Format SQL' }));
    expect(doc()).toBe("select a from t where b = 'open");
    expect(await screen.findByText('The SQL was not formatted')).toBeInTheDocument();
    expect(screen.getByText(/never closed\. Nothing was changed\./)).toBeInTheDocument();
  });

  it('viewers get no Format SQL button and the shortcut does nothing', async () => {
    vi.spyOn(api, 'getReport').mockResolvedValue({
      id: 'r1',
      name: 'Orders',
      description: null,
      sql: 'select a,b from t',
      access: 'VIEWER',
      parameters: [],
    } as unknown as Report);
    const router = createMemoryRouter([{ path: '/reports/:id', element: <ReportEditorPage /> }], {
      initialEntries: ['/reports/r1'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Orders' });
    expect(actions().queryByRole('button', { name: 'Format SQL' })).toBeNull();
    fireEvent.keyDown(editorView().contentDOM, {
      key: 'F',
      code: 'KeyF',
      keyCode: 70,
      shiftKey: true,
      altKey: true,
    });
    expect(doc()).toBe('select a,b from t');
  });
});
