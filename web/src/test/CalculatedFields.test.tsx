import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type {
  ParameterDef,
  Report,
  CalcValidation,
  ReportBuilderRun,
  ReportSpec,
  SchemaColumn,
  SchemaColumnsResponse,
  SchemaTablesResponse,
} from '../api/types';
import { ReportBuilderPage } from '../pages/ReportBuilderPage';
import { calcNameProblem, newCalcRow } from '../components/CalculatedFields';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-alice', username: 'alice', displayName: 'Alice', role: 'USER' },
    loading: false,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const tables: SchemaTablesResponse = {
  tables: [{ schema: 'SALESLIB', name: 'ORDERS', type: 'T', typeLabel: 'Table', text: 'Orders' }],
  truncated: false,
  cachedAt: '2026-10-26T12:00:00.000Z',
  maxTables: 500,
};

const col = (name: string, type: string, ordinal: number, scale = 0): SchemaColumn => ({
  name,
  type,
  displayType: type,
  length: 4,
  precision: 11,
  scale,
  nullable: true,
  text: null,
  ordinal,
});

const orders: SchemaColumnsResponse = {
  schema: 'SALESLIB',
  table: 'ORDERS',
  type: 'T',
  text: 'Orders',
  cachedAt: '2026-10-26T12:00:00.000Z',
  columns: [
    col('ORDER_ID', 'INTEGER', 1),
    col('REGION', 'VARCHAR', 2),
    col('AMOUNT', 'DECIMAL', 3, 2),
    col('ORDER_DATE', 'DATE', 4),
  ],
};

const runResult = {
  executionId: 'e-1',
  columns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  maxRows: 100,
  startedAt: '2026-10-26T12:00:00.000Z',
  completedAt: '2026-10-26T12:00:01.000Z',
  durationMs: 8,
  dataSource: 'demo',
  builder: { name: 'ORDERS', sql: 'SELECT 1' },
} as unknown as ReportBuilderRun;

function mockValidate() {
  return vi.spyOn(api, 'validateCalc').mockImplementation(async ({ expression }) => {
    if (expression.includes('*')) {
      const at = expression.indexOf('*');
      if (!expression.slice(at + 1).trim())
        return {
          ok: false,
          error: { message: 'Expected a column, number, text or function.', position: at + 1 },
        } as CalcValidation;
      return { ok: true, type: 'decimal', hint: 'number', sql: '(…)', columns: [] };
    }
    if (expression.startsWith('CASE'))
      return { ok: true, type: 'char', hint: 'character', sql: '(…)', columns: [] };
    return { ok: true, type: 'integer', hint: 'number', sql: '(…)', columns: [] };
  });
}

function mockApi(parameters: ParameterDef[] = []) {
  vi.spyOn(api, 'schemaTables').mockResolvedValue(tables);
  vi.spyOn(api, 'schemaColumns').mockResolvedValue(orders);
  const preview = vi.spyOn(api, 'previewReportSql').mockImplementation(async (spec) => ({
    sql: `SELECT … ${spec.filters?.length ? 'WHERE ?' : ''} ${spec.groupBy?.length ? 'GROUP BY' : ''}`,
    name: 'Orders',
    schema: spec.schema,
    table: spec.table,
    warnings: [],
    parameters,
  }));
  const run = vi.spyOn(api, 'runReportBuilder').mockResolvedValue(runResult);
  return { preview, run };
}

const lastSpec = (preview: ReturnType<typeof mockApi>['preview']) =>
  preview.mock.calls[preview.mock.calls.length - 1][0] as ReportSpec;

async function setup(url = '/report-builder', pick = true) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/report-builder" element={<ReportBuilderPage />} />
      </Routes>
    </MemoryRouter>,
  );
  if (pick) {
    await user.click(await screen.findByText('SALESLIB.ORDERS'));
    await screen.findByRole('checkbox', { name: /ORDER_ID/ });
  }
  return user;
}

async function addCalc(user: ReturnType<typeof userEvent.setup>, name: string, expression: string) {
  await user.click(screen.getByRole('button', { name: 'Add calculated field' }));
  const rows = screen.getAllByRole('group', { name: /^ƒ / });
  const row = rows[rows.length - 1];
  const nameInput = within(row).getByLabelText('Name');
  await user.clear(nameInput);
  await user.type(nameInput, name);
  const expr = within(row).getByLabelText('Expression');
  await user.click(expr);
  await user.paste(expression);
  return row;
}

describe('calculated field helpers', () => {
  it('gives new fields unique ids and checks names', () => {
    const a = newCalcRow([]);
    const b = newCalcRow([a]);
    expect([a.id, b.id]).toEqual(['CALC1', 'CALC2']);
    expect(calcNameProblem({ ...b, name: a.name }, [a, b])).toMatch(/Another/);
    expect(calcNameProblem({ ...a, name: 'Bad"name' }, [a])).toMatch(/Use letters/);
    expect(calcNameProblem({ ...a, name: ' ' }, [a])).toMatch(/Enter a name/);
  });
});

describe('ReportBuilderPage calculated fields', { timeout: 20000 }, () => {
  it('edits a field with live server checks, a type hint and inline errors', async () => {
    const { preview } = mockApi();
    const validate = mockValidate();
    const user = await setup();
    const row = await addCalc(user, 'Extended', 'AMOUNT *');
    expect(await within(row).findByText(/Expected a column/)).toBeInTheDocument();
    expect(within(row).getByLabelText('Error position')).toHaveTextContent('^');
    expect(screen.getByRole('button', { name: 'Run report' })).toBeDisabled();
    // the field picker inserts a column at the cursor
    await user.selectOptions(within(row).getByLabelText('Insert field'), 'ORDER_ID');
    await waitFor(() =>
      expect(within(row).getByLabelText('Expression')).toHaveValue('AMOUNT * ORDER_ID'),
    );
    expect(await within(row).findByText(/Result: number \(decimal\)/)).toBeInTheDocument();
    expect(validate).toHaveBeenLastCalledWith(
      { schema: 'SALESLIB', table: 'ORDERS', joins: [], expression: 'AMOUNT * ORDER_ID' },
      expect.anything(),
    );
    await user.click(within(row).getByRole('checkbox', { name: 'Show as a column' }));
    expect(screen.getByText(/1\. ƒ Extended/)).toBeInTheDocument();
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        columns: [{ table: '@CALC', column: 'CALC1' }],
        calculated: [{ id: 'CALC1', name: 'Extended', expression: 'AMOUNT * ORDER_ID' }],
      }),
    );
    // the browser sends the expression text, never SQL
    expect(JSON.stringify(lastSpec(preview))).not.toMatch(/NULLIF|SELECT/);
  });

  it('filters, groups, totals and sorts by calculated fields (marked ƒ)', async () => {
    const { preview } = mockApi();
    mockValidate();
    const user = await setup();
    await addCalc(user, 'Size', "CASE WHEN AMOUNT > 10 THEN 'Big' ELSE 'Small' END");
    await addCalc(user, 'Ext', 'AMOUNT * 2');
    await screen.findByText(/Result: character/);
    await screen.findByText(/Result: number \(decimal\)/);
    await user.click(screen.getByRole('button', { name: 'Add group by' }));
    await user.selectOptions(screen.getByLabelText('Group by 1'), 'ƒ Size');
    await user.click(screen.getByRole('button', { name: 'Add total' }));
    const total = screen.getByRole('group', { name: 'Total 1' });
    await user.selectOptions(within(total).getByLabelText('Function'), 'SUM');
    const of = within(total).getByLabelText('Of');
    const options = within(of)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('ƒ Ext');
    expect(options).not.toContain('ƒ Size'); // text is not summed
    await user.selectOptions(of, 'ƒ Ext');
    await user.click(screen.getByRole('button', { name: 'Add total filter' }));
    await user.type(
      within(screen.getByRole('group', { name: 'Total filter 1' })).getByLabelText('Value'),
      '5',
    );
    await user.click(screen.getByRole('button', { name: 'Add sort column' }));
    await user.selectOptions(screen.getByLabelText('Sort 1 column'), 'ƒ Size');
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        groupBy: [{ table: '@CALC', column: 'CALC1' }],
        aggregates: [{ fn: 'SUM', table: '@CALC', column: 'CALC2', name: 'Total Ext' }],
        having: [{ aggregate: 'Total Ext', value: 5 }],
        sort: [{ table: '@CALC', column: 'CALC1', direction: 'DESC' }],
      }),
    );
    // removing a field removes every use of it
    await user.click(screen.getByRole('button', { name: 'Remove Ext' }));
    expect(screen.queryByRole('group', { name: 'Total 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Total filter 1' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /REGION/ }));
    await waitFor(() => expect(lastSpec(preview).columns).toEqual(['REGION']));
    expect(lastSpec(preview).aggregates).toBeUndefined();
    expect(lastSpec(preview).having).toBeUndefined();
    expect(lastSpec(preview).calculated).toEqual([
      {
        id: 'CALC1',
        name: 'Size',
        expression: "CASE WHEN AMOUNT > 10 THEN 'Big' ELSE 'Small' END",
      },
    ]);
  });

  const v2 = {
    id: 'r-2',
    name: 'Calc report',
    description: null,
    category: null,
    version: 4,
    sql: 'SELECT 1',
    parameters: [],
    builder: { valid: true, error: null },
    builderDef: {
      version: 2,
      spec: {
        schema: 'SALESLIB',
        table: 'ORDERS',
        columns: ['REGION', { table: '@CALC', column: 'EXT' }],
        calculated: [{ id: 'EXT', name: 'Ext', expression: 'AMOUNT * 2', type: 'decimal' }],
        filters: [{ table: '@CALC', column: 'EXT', op: '>', value: 3 }],
      },
    },
  } as unknown as Report;

  it('reopens a version 2 definition and saves it as version 2', async () => {
    const { preview } = mockApi();
    const validate = mockValidate();
    vi.spyOn(api, 'getReport').mockResolvedValue(v2);
    const update = vi.spyOn(api, 'updateReport').mockResolvedValue(v2);
    const user = await setup('/report-builder?report=r-2', false);
    const row = await screen.findByRole('group', { name: 'ƒ Ext' });
    expect(within(row).getByLabelText('Expression')).toHaveValue('AMOUNT * 2');
    expect(within(row).getByRole('checkbox', { name: 'Show as a column' })).toBeChecked();
    const f = await screen.findByRole('group', { name: /filter 1/ });
    expect(within(f).getByLabelText('Value')).toHaveValue('3');
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        columns: ['REGION', { table: '@CALC', column: 'EXT' }],
        filters: [{ table: '@CALC', column: 'EXT', op: '>', value: 3 }],
        calculated: [{ id: 'EXT', name: 'Ext', expression: 'AMOUNT * 2' }],
      }),
    );
    await within(row).findByText(/Result: number/);
    await waitFor(() => expect(screen.getByLabelText('Run report')).toBeEnabled());
    // the server check settles before saving
    await waitFor(() => expect(validate).toHaveBeenCalled());
    await waitFor(() => expect(preview.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save changes' });
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'r-2',
        expect.objectContaining({
          builderDef: {
            version: 2,
            spec: expect.objectContaining({ calculated: expect.any(Array) }),
          },
        }),
      ),
    );
  });
});
