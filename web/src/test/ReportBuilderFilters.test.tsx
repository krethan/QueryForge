import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type {
  ParameterDef,
  Report,
  ReportBuilderRun,
  ReportSpec,
  SchemaColumn,
  SchemaColumnsResponse,
  SchemaTablesResponse,
} from '../api/types';
import { ReportBuilderPage, describeSelection } from '../pages/ReportBuilderPage';
import { RunParamsModal } from '../components/RunParamsModal';
import { filterProblems, toFilter, valueKind } from '../utils/builderState';
import { newFilterRow } from '../components/BuilderFilters';

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

const regionParam: ParameterDef = {
  name: 'REGION',
  label: 'Region',
  type: 'string',
  required: true,
  defaultValue: null,
};

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

describe('builder filter helpers', () => {
  it('knows column kinds and validates typed values', () => {
    expect(valueKind(col('AMOUNT', 'DECIMAL', 1, 2))).toBe('decimal');
    expect(valueKind(col('ID', 'INTEGER', 1))).toBe('integer');
    const row = { ...newFilterRow('base|AMOUNT'), op: '>' as const, value: 'abc' };
    expect(filterProblems(row, 'decimal')).toMatch(/not a number/);
    expect(filterProblems({ ...row, value: '10.5' }, 'decimal')).toBeNull();
    expect(toFilter({ ...row, value: '10.5' }, () => ({ column: 'AMOUNT' }), 'decimal')).toEqual({
      column: 'AMOUNT',
      op: '>',
      value: 10.5,
    });
  });

  it('describes filters and totals', () => {
    expect(
      describeSelection({
        schema: 'S',
        table: 'T',
        columns: ['A'],
        filters: [{ column: 'A', op: 'IS_NULL' }],
        aggregates: [{ fn: 'COUNT', name: 'Rows' }],
      }),
    ).toBe('1 column, 1 filter, 1 total');
  });
});

describe('ReportBuilderPage filters', () => {
  it('adds a typed filter and sends it in the spec', async () => {
    const { preview } = mockApi();
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    const row = screen.getByRole('group', { name: /filter 1/ });
    await user.selectOptions(within(row).getByLabelText('Column'), 'AMOUNT');
    await user.selectOptions(within(row).getByLabelText('Condition'), 'greater than');
    await user.type(within(row).getByLabelText('Value'), 'abc');
    expect(await within(row).findByText(/not a number/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run report' })).toBeDisabled();
    await user.clear(within(row).getByLabelText('Value'));
    await user.type(within(row).getByLabelText('Value'), '100');
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        filters: [{ column: 'AMOUNT', op: '>', value: 100 }],
        filterLogic: 'AND',
      }),
    );
  });

  it('turns an ask-when-run filter into a prompt at run time', async () => {
    const { preview, run } = mockApi([
      { ...regionParam },
      {
        name: 'QF_F1',
        label: 'QF_F1',
        type: 'decimal',
        required: true,
        defaultValue: '5',
        fixed: true,
      },
    ]);
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    const row = screen.getByRole('group', { name: /filter 1/ });
    await user.selectOptions(within(row).getByLabelText('Column'), 'REGION');
    await user.click(within(row).getByLabelText('Ask when run'));
    expect(within(row).getByLabelText('Parameter name')).toHaveValue('REGION');
    await waitFor(() =>
      expect(lastSpec(preview).filters).toEqual([
        { column: 'REGION', op: '=', ask: { name: 'REGION', label: 'REGION' } },
      ]),
    );
    expect(await screen.findByTestId('builder-asks')).toHaveTextContent('Region');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report parameters' });
    expect(within(dialog).queryByLabelText(/QF_F1/)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Region/), 'West');
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ filters: expect.any(Array) }),
        expect.any(String),
        undefined,
        { REGION: 'West' },
      ),
    );
  });
});

describe('ReportBuilderPage grouping', () => {
  it('groups, totals numeric columns only, and sorts by a total', async () => {
    const { preview } = mockApi();
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /REGION/ }));
    await user.click(screen.getByRole('button', { name: 'Add total' }));
    const total = screen.getByRole('group', { name: 'Total 1' });
    await user.selectOptions(within(total).getByLabelText('Function'), 'SUM');
    const of = within(total).getByLabelText('Of');
    const options = within(of)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('AMOUNT');
    expect(options).not.toContain('REGION');
    await user.selectOptions(of, 'AMOUNT');
    await user.type(within(total).getByLabelText('Column name'), 'Revenue');
    expect(screen.getByText(/REGION/, { selector: '.qf-muted *, .qf-muted' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add sort column' }));
    await user.selectOptions(screen.getByLabelText('Sort 1 column'), 'Revenue');
    await user.click(screen.getByRole('button', { name: 'Add total filter' }));
    const h = screen.getByRole('group', { name: 'Total filter 1' });
    await user.type(within(h).getByLabelText('Value'), '1000');
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        columns: ['REGION'],
        aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Revenue' }],
        sort: [{ aggregate: 'Revenue', direction: 'ASC' }],
        having: [{ aggregate: 'Revenue', value: 1000 }],
      }),
    );
  });
});

describe('Open in Report Builder', () => {
  const saved = {
    id: 'r-1',
    name: 'West revenue',
    description: null,
    category: null,
    version: 3,
    sql: 'SELECT 1',
    parameters: [],
    builder: { valid: true, error: null },
    builderDef: {
      version: 1,
      spec: {
        schema: 'SALESLIB',
        table: 'ORDERS',
        columns: ['REGION'],
        filters: [{ column: 'REGION', op: 'STARTS_WITH', value: 'We' }],
        aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Revenue' }],
        sort: [{ aggregate: 'Revenue', direction: 'DESC' }],
      },
    },
  } as unknown as Report;

  it('restores the saved definition and saves changes to the same report', async () => {
    const { preview } = mockApi();
    vi.spyOn(api, 'getReport').mockResolvedValue(saved);
    const update = vi.spyOn(api, 'updateReport').mockResolvedValue(saved);
    const user = await setup('/report-builder?report=r-1', false);
    expect(await screen.findByTestId('builder-source')).toHaveTextContent('West revenue');
    const row = await screen.findByRole('group', { name: /filter 1/ });
    expect(within(row).getByLabelText('Value')).toHaveValue('We');
    expect(screen.getByRole('checkbox', { name: /REGION/ })).toBeChecked();
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        columns: ['REGION'],
        filters: [{ column: 'REGION', op: 'STARTS_WITH', value: 'We' }],
        aggregates: [{ fn: 'SUM', column: 'AMOUNT', name: 'Revenue' }],
        sort: [{ aggregate: 'Revenue', direction: 'DESC' }],
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save changes' });
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'r-1',
        expect.objectContaining({
          version: 3,
          builderDef: { version: 1, spec: expect.objectContaining({ table: 'ORDERS' }) },
        }),
      ),
    );
  });

  it('explains when the saved definition no longer validates', async () => {
    mockApi();
    vi.spyOn(api, 'getReport').mockResolvedValue({
      ...saved,
      builder: { valid: false, error: 'Column AMOUNT no longer exists.' },
    } as Report);
    await setup('/report-builder?report=r-1', false);
    expect(await screen.findByText(/AMOUNT no longer exists/)).toBeInTheDocument();
  });
});

describe('RunParamsModal', () => {
  it('never prompts for fixed builder values', () => {
    render(
      <RunParamsModal
        open
        title="Run"
        parameters={[
          regionParam,
          {
            name: 'QF_F1',
            label: 'Hidden',
            type: 'string',
            required: true,
            defaultValue: 'x',
            fixed: true,
          },
        ]}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByLabelText(/Region/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Hidden/)).not.toBeInTheDocument();
  });
});
