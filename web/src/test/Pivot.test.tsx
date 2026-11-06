import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type {
  PivotResult,
  PivotRun,
  ReportSpec,
  SchemaColumn,
  SchemaColumnsResponse,
  SchemaTablesResponse,
} from '../api/types';
import { ReportBuilderPage } from '../pages/ReportBuilderPage';
import { PivotTable } from '../components/PivotTable';
import { pivotProblem, emptyPivot } from '../components/BuilderPivot';
import { pivotChartDefault } from '../utils/pivot';

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

const pivot: PivotResult = {
  rowFields: [{ name: 'REGION', label: 'REGION', kind: 'text', scale: 0 }],
  columnField: { name: 'STATUS', label: 'STATUS', kind: 'text', scale: 0 },
  value: { fn: 'SUM', label: 'Sum of AMOUNT', kind: 'decimal', scale: 2 },
  columns: [
    { label: 'OPEN', value: 'OPEN' },
    { label: '(null)', value: null },
  ],
  rows: [
    {
      keys: ['EAST'],
      labels: ['EAST'],
      cells: ['10.50', null],
      present: [true, false],
      total: '10.50',
    },
    {
      keys: ['WEST'],
      labels: ['WEST'],
      cells: ['1.00', '2.25'],
      present: [true, true],
      total: '3.25',
    },
  ],
  columnTotals: ['11.50', '2.25'],
  grandTotal: '13.75',
  groupCount: 3,
  exact: true,
  long: { columns: [], rows: [] },
};

function mockApi() {
  vi.spyOn(api, 'schemaTables').mockResolvedValue(tables);
  vi.spyOn(api, 'schemaColumns').mockResolvedValue(orders);
  const preview = vi.spyOn(api, 'previewReportSql').mockImplementation(async (spec) => ({
    sql: 'SELECT … GROUP BY',
    name: 'Orders',
    schema: spec.schema,
    table: spec.table,
    warnings: [],
    parameters: [],
  }));
  const run = vi.spyOn(api, 'runPivot').mockResolvedValue({
    pivot,
    executionId: 'e-1',
    completedAt: '2026-10-26T12:00:01.000Z',
    durationMs: 5,
    builder: { name: 'Orders', sql: 'SELECT … GROUP BY' },
  } as PivotRun);
  const plain = vi.spyOn(api, 'runReportBuilder');
  return { preview, run, plain };
}

const lastSpec = (preview: ReturnType<typeof mockApi>['preview']) =>
  preview.mock.calls[preview.mock.calls.length - 1][0] as ReportSpec;

describe('PivotTable', () => {
  it('shows totals, a labelled NULL column and drills with row/column keys', async () => {
    const user = userEvent.setup();
    const drill = vi.fn();
    render(<PivotTable pivot={pivot} onCellDrill={drill} />);
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['REGION', 'OPEN', '(null)', 'Total']);
    const rows = within(table).getAllByRole('row');
    expect(rows[3]).toHaveTextContent('Total11.502.2513.75');
    // EAST has no NULL-status rows: an empty, non-clickable cell
    expect(within(rows[1]).getAllByRole('button')).toHaveLength(2);
    await user.click(within(rows[2]).getByRole('button', { name: /^2\.25/ }));
    expect(drill).toHaveBeenLastCalledWith({ REGION: 'WEST', STATUS: null }, 'WEST, (null)');
    await user.click(within(rows[2]).getByRole('button', { name: /^3\.25/ }));
    expect(drill.mock.calls[1][0]).toEqual({ REGION: 'WEST' });
    await user.click(within(rows[3]).getByRole('button', { name: /^13\.75/ }));
    expect(drill.mock.calls[2][0]).toEqual({});
  });

  it('is read-only without a drill handler', () => {
    render(<PivotTable pivot={pivot} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('defaults to a stacked chart for sums and grouped for averages', () => {
    expect(pivotChartDefault(pivot)).toMatchObject({
      type: 'stackedBar',
      x: 'REGION',
      series: 'STATUS',
      y: ['PIVOT_VALUE'],
    });
    expect(pivotChartDefault({ ...pivot, value: { ...pivot.value, fn: 'AVG' } }).type).toBe(
      'groupedBar',
    );
  });

  it('explains what is missing', () => {
    const p = { ...emptyPivot(), enabled: true };
    expect(pivotProblem(p)).toMatch(/row field/);
    expect(pivotProblem({ ...p, rows: ['B|REGION'] })).toMatch(/column field/);
    expect(pivotProblem({ ...p, rows: ['B|REGION'], column: 'B|REGION' })).toMatch(/cannot/);
    expect(pivotProblem({ ...p, rows: ['B|REGION'], column: 'B|ORDER_DATE' })).toMatch(/value/);
    expect(
      pivotProblem({ ...p, rows: ['B|REGION'], column: 'B|ORDER_DATE', fn: 'COUNT' }),
    ).toBeNull();
  });
});

describe('ReportBuilderPage pivot', { timeout: 20000 }, () => {
  it('sends a pivot (no SQL), hides grouping and runs the server pivot', async () => {
    const { preview, run, plain } = mockApi();
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/report-builder']}>
        <Routes>
          <Route path="/report-builder" element={<ReportBuilderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(await screen.findByText('SALESLIB.ORDERS'));
    await screen.findByRole('checkbox', { name: /ORDER_ID/ });
    expect(screen.getByRole('button', { name: 'Add group by' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /Show as a pivot/ }));
    expect(screen.queryByRole('button', { name: 'Add group by' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Row field'), 'REGION');
    await user.selectOptions(screen.getByLabelText('Column field'), 'ORDER_DATE');
    expect(screen.getByText(/Choose a value field to sum/)).toBeInTheDocument();
    const of = screen.getByLabelText('of');
    const options = within(of)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('AMOUNT');
    expect(options).not.toContain('REGION'); // text is not summed
    await user.selectOptions(of, 'AMOUNT');
    await waitFor(() =>
      expect(lastSpec(preview)).toMatchObject({
        columns: [],
        pivot: {
          rows: [{ column: 'REGION' }],
          column: { column: 'ORDER_DATE' },
          value: { fn: 'SUM', column: 'AMOUNT' },
        },
      }),
    );
    expect(lastSpec(preview).groupBy).toBeUndefined();
    expect(JSON.stringify(lastSpec(preview))).not.toMatch(/SELECT/);
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByTestId('pivot-table')).toHaveTextContent('13.75');
    expect(run).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export pivot to Excel' })).toBeEnabled();
  });
});
