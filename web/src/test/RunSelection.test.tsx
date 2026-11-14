import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { api } from '../api/client';
import type { ParameterDef, Report, ResultColumn, RunResponse } from '../api/types';
import { ReportEditorPage } from '../pages/ReportEditorPage';
import {
  describeLines,
  lineAt,
  resolveRunTarget,
  scanSql,
  statementAt,
} from '../utils/sqlStatements';

vi.mock('../components/charts/ChartView', () => ({ default: () => <div /> }));

// jsdom has no layout: CodeMirror measures text ranges when the selection moves
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => ({ ...rect, toJSON: () => rect }) as DOMRect;

const p = (name: string, over: Partial<ParameterDef> = {}): ParameterDef =>
  ({ name, label: name, type: 'string', required: false, ...over }) as ParameterDef;
const texts = (sql: string) => scanSql(sql).statements.map((r) => sql.slice(r.from, r.to));

describe('scanSql', () => {
  it('splits on top-level semicolons and trims each statement', () => {
    expect(texts('SELECT 1 FROM SYSIBM.SYSDUMMY1;\n\n  VALUES 2 ;\nSELECT 3')).toEqual([
      'SELECT 1 FROM SYSIBM.SYSDUMMY1',
      'VALUES 2',
      'SELECT 3',
    ]);
  });
  it('ignores semicolons and markers in strings, delimited identifiers and comments', () => {
    const sql = [
      "SELECT 'a;b', 'it''s;?' AS \"X;?\"\"\" FROM T -- no; split ?",
      'WHERE A = ? /* still; one ? */ AND B = ?;',
      'VALUES ?',
    ].join('\n');
    const { statements, markers } = scanSql(sql);
    expect(statements).toHaveLength(2);
    expect(markers.map((m) => sql[m])).toEqual(['?', '?', '?']);
    expect(sql.slice(statements[1].from, statements[1].to)).toBe('VALUES ?');
  });
  it('drops empty and comment-only pieces', () => {
    expect(texts(';; -- only a comment\n; /* x */ SELECT 1; ')).toEqual(['SELECT 1']);
    expect(texts('   ')).toEqual([]);
  });
  it('keeps comments inside a statement and runs unterminated text to the end', () => {
    expect(texts('SELECT /* a */ 1 FROM T')).toEqual(['SELECT /* a */ 1 FROM T']);
    expect(texts("SELECT 'open; string")).toEqual(["SELECT 'open; string"]);
  });
});

describe('statementAt / lineAt / describeLines', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\n';
  const { statements } = scanSql(sql);
  it('picks the statement under or before the cursor', () => {
    expect(statementAt(statements, 0)).toBe(statements[0]);
    expect(statementAt(statements, 9)).toBe(statements[0]); // just after the first ;
    expect(statementAt(statements, 11)).toBe(statements[1]);
    expect(statementAt(statements, sql.length)).toBe(statements[1]);
    expect(statementAt([], 3)).toBeUndefined();
  });
  it('reports 1-based lines', () => {
    expect(lineAt(sql, 0)).toBe(1);
    expect(lineAt(sql, 11)).toBe(3);
    expect(describeLines({ firstLine: 3, lastLine: 3 })).toBe('line 3');
    expect(describeLines({ firstLine: 2, lastLine: 5 })).toBe('lines 2–5');
  });
});

describe('resolveRunTarget', () => {
  it('returns null for a single statement with no selection (whole editor runs)', () => {
    expect(resolveRunTarget('SELECT 1;', { from: 3, to: 3 }, [])).toBeNull();
    expect(resolveRunTarget('SELECT 1', { from: 0, to: 0 }, [])).toBeNull();
  });
  it('runs the selected text, trimmed, with its line range', () => {
    const sql = 'SELECT A,\n  B\nFROM T\nWHERE A > 1';
    const t = resolveRunTarget(sql, { from: sql.indexOf('FROM') - 1, to: sql.length }, []);
    expect(t).toMatchObject({ kind: 'selection', text: 'FROM T\nWHERE A > 1' });
    expect(describeLines(t!)).toBe('lines 3–4');
    // a backwards (head before anchor) selection is the same selection
    const back = resolveRunTarget(sql, { from: sql.length, to: 0 }, []);
    expect(back?.text).toBe(sql);
  });
  it('ignores a whitespace-only selection', () => {
    expect(resolveRunTarget('SELECT 1   FROM T', { from: 8, to: 11 }, [])).toBeNull();
    expect(resolveRunTarget('SELECT 1;\n\nSELECT 2', { from: 9, to: 10 }, [])).toMatchObject({
      kind: 'statement',
      text: 'SELECT 1',
    });
  });
  it('runs the statement at the cursor when there are several', () => {
    const sql = 'SELECT 1 FROM T;\nSELECT 2 FROM U;';
    expect(resolveRunTarget(sql, { from: 20, to: 20 }, [])).toMatchObject({
      kind: 'statement',
      text: 'SELECT 2 FROM U',
      firstLine: 2,
      lastLine: 2,
    });
  });
  it('gives the part the parameter definitions of its own markers, in order', () => {
    const defs = [p('A'), p('B'), p('C')];
    const sql = 'SELECT * FROM T WHERE A = ?;\nSELECT * FROM U WHERE B = ? AND C = ?';
    const second = resolveRunTarget(sql, { from: sql.length, to: sql.length }, defs);
    expect(second?.parameters.map((d) => d.name)).toEqual(['B', 'C']);
    const first = resolveRunTarget(sql, { from: 0, to: 0 }, defs);
    expect(first?.parameters.map((d) => d.name)).toEqual(['A']);
    const sel = sql.lastIndexOf('C = ?');
    const onlyC = resolveRunTarget(sql, { from: sel, to: sql.length }, defs);
    expect(onlyC?.parameters.map((d) => d.name)).toEqual(['C']);
    expect(onlyC?.error).toBeUndefined();
  });
  it('flags a part with markers when the definitions do not match the markers', () => {
    const sql = 'SELECT 1 FROM T WHERE A = ?;\nSELECT 2 FROM U';
    expect(resolveRunTarget(sql, { from: 0, to: 0 }, [])?.error).toMatch(/1 parameter marker/);
    // a part without markers is fine even when the definitions are incomplete
    const second = resolveRunTarget(sql, { from: sql.length, to: sql.length }, []);
    expect(second?.error).toBeUndefined();
    expect(second?.parameters).toEqual([]);
  });
});

// ---- the editor page ----

const col = (name: string): ResultColumn =>
  ({ key: name, name, label: name, kind: 'text', type: 'VARCHAR', nullable: true }) as ResultColumn;
const result = (id: string, v: string): RunResponse =>
  ({
    executionId: id,
    columns: [col('V')],
    rows: [[v]],
    rowCount: 1,
    truncated: false,
    durationMs: 2,
    completedAt: '2026-11-13T00:00:00Z',
    dataSource: 'demo',
    maxRows: 1000,
  }) as unknown as RunResponse;
const savedReport = (over: Partial<Report> = {}): Report =>
  ({
    id: 'r1',
    name: 'Orders',
    description: null,
    category: null,
    sql: 'SELECT ORDER_ID FROM ORDERS',
    version: 1,
    createdAt: null,
    updatedAt: null,
    lastExecutedAt: null,
    lastStatus: 'NEVER',
    lastRowCount: null,
    lastDurationMs: null,
    access: 'OWNER',
    parameters: [],
    ...over,
  }) as Report;

const editorView = () => {
  const el = document.querySelector('.cm-editor') as HTMLElement;
  const view = EditorView.findFromDOM(el);
  if (!view) throw new Error('no editor');
  return view;
};
const typeSql = (text: string) =>
  act(() => {
    const v = editorView();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  });
const select = (anchor: number, head = anchor) =>
  act(() => {
    editorView().dispatch({ selection: { anchor, head } });
  });

const runButton = (name: string) =>
  within(document.querySelector('.qf-editor-actions') as HTMLElement).getByRole('button', { name });

const openNew = () => {
  const router = createMemoryRouter([{ path: '/editor', element: <ReportEditorPage /> }], {
    initialEntries: ['/editor'],
  });
  render(<RouterProvider router={router} />);
};
const openSaved = async (r: Report) => {
  vi.spyOn(api, 'getReport').mockResolvedValue(r);
  const router = createMemoryRouter([{ path: '/reports/:id', element: <ReportEditorPage /> }], {
    initialEntries: [`/reports/${r.id}`],
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: r.name });
};

describe('Run selection / statement at cursor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs only the selected text and labels the result', async () => {
    const exec = vi.spyOn(api, 'execute').mockResolvedValue(result('x1', 'sel'));
    openNew();
    const sql = 'SELECT ORDER_ID, STATUS\nFROM ORDERS\nWHERE STATUS = 1';
    typeSql(sql);
    expect(runButton('Run')).toBeInTheDocument();
    select(0, sql.indexOf('\nWHERE'));
    const btn = runButton('Run selection');
    expect(btn).toHaveAttribute('title', 'Run only the selected text (lines 1–2)');
    fireEvent.click(btn);
    await screen.findByText(/Results for the selected text on lines 1–2/);
    expect(exec).toHaveBeenCalledWith(
      'SELECT ORDER_ID, STATUS\nFROM ORDERS',
      expect.any(String),
      undefined,
      { parameters: [], values: {} },
    );
  });

  it('Ctrl+Enter runs the statement under the cursor and highlights it', async () => {
    const exec = vi.spyOn(api, 'execute').mockResolvedValue(result('x2', 'two'));
    openNew();
    const sql = 'SELECT 1 FROM SYSIBM.SYSDUMMY1;\n\nSELECT 2 FROM SYSIBM.SYSDUMMY1;';
    typeSql(sql);
    select(sql.indexOf('SELECT 2') + 3);
    expect(runButton('Run statement')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.qf-editor__statement')?.textContent).toBe(
        'SELECT 2 FROM SYSIBM.SYSDUMMY1',
      ),
    );
    fireEvent.keyDown(editorView().contentDOM, { key: 'Enter', ctrlKey: true });
    await screen.findByText(/Results for the statement on line 3/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe('SELECT 2 FROM SYSIBM.SYSDUMMY1');
  });

  it("asks only for the part's parameters and binds them positionally", async () => {
    const exec = vi.spyOn(api, 'execute').mockResolvedValue(result('x3', 'p'));
    const r = savedReport({
      sql: 'SELECT * FROM T WHERE A = ?;\nSELECT * FROM U WHERE B = ?',
      parameters: [p('REGION', { label: 'Region' }), p('STATUS', { label: 'Status' })],
    });
    await openSaved(r);
    select(r.sql.length);
    fireEvent.click(runButton('Run statement'));
    const heading = await screen.findByText('Run the statement (line 2)');
    const dialog = heading.closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).queryByLabelText(/Region/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Status/), { target: { value: 'OPEN' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    await screen.findByText(/Results for the statement on line 2/);
    expect(exec).toHaveBeenCalledWith(
      'SELECT * FROM U WHERE B = ?',
      expect.any(String),
      undefined,
      {
        parameters: [r.parameters![1]],
        values: { STATUS: 'OPEN' },
      },
    );
  });

  it('runs a selection of a clean saved report ad hoc and turns drill-down off', async () => {
    const execReport = vi.spyOn(api, 'executeReport').mockResolvedValue(result('x4', 'full'));
    const exec = vi.spyOn(api, 'execute').mockResolvedValue(result('x5', 'part'));
    const r = savedReport({
      drill: { builder: { fields: ['V'] }, target: null, targetUnavailable: false },
    });
    await openSaved(r);
    fireEvent.click(runButton('Run'));
    await screen.findAllByTestId('drill-row');
    expect(execReport).toHaveBeenCalledTimes(1);
    select(0, 'SELECT ORDER_ID'.length);
    fireEvent.click(runButton('Run selection'));
    await screen.findByText(/Results for the selected text on line 1/);
    expect(exec.mock.calls[0][0]).toBe('SELECT ORDER_ID');
    expect(screen.queryAllByTestId('drill-row')).toHaveLength(0);
  });

  it('reports a marker/definition mismatch without calling the server', async () => {
    const exec = vi.spyOn(api, 'execute');
    openNew();
    typeSql('SELECT 1 FROM T WHERE A = ?;\nSELECT 2 FROM T');
    select(3);
    fireEvent.click(runButton('Run statement'));
    await screen.findByText(/before running part of the SQL/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('viewers keep running the saved report whatever is selected', async () => {
    const execReport = vi.spyOn(api, 'executeReport').mockResolvedValue(result('x6', 'v'));
    const exec = vi.spyOn(api, 'execute');
    await openSaved(savedReport({ access: 'VIEWER', sql: 'SELECT 1 FROM T;\nSELECT 2 FROM T' }));
    select(0, 6);
    fireEvent.click(runButton('Run'));
    await waitFor(() => expect(execReport).toHaveBeenCalledTimes(1));
    expect(exec).not.toHaveBeenCalled();
    expect(document.querySelector('.qf-editor__statement')).toBeNull();
  });
});
