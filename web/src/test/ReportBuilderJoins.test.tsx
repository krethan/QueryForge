import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type {
  ReportBuilderRun,
  ReportSpec,
  SchemaColumn,
  SchemaColumnsResponse,
  SchemaTablesResponse,
} from '../api/types';
import { ReportBuilderPage, describeSelection } from '../pages/ReportBuilderPage';

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
  tables: [
    { schema: 'SALESLIB', name: 'ORDERS', type: 'T', typeLabel: 'Table', text: 'Orders' },
    { schema: 'SALESLIB', name: 'CUSTOMERS', type: 'T', typeLabel: 'Table', text: 'Customers' },
  ],
  truncated: false,
  cachedAt: '2026-10-26T12:00:00.000Z',
  maxTables: 500,
};

const col = (name: string, displayType: string, ordinal: number): SchemaColumn => ({
  name,
  type: displayType.replace(/\(.*/, ''),
  displayType,
  length: 4,
  precision: 10,
  scale: 0,
  nullable: true,
  text: null,
  ordinal,
});

const columnsOf: Record<string, SchemaColumnsResponse> = {
  ORDERS: {
    schema: 'SALESLIB',
    table: 'ORDERS',
    type: 'T',
    text: 'Orders',
    cachedAt: '2026-10-26T12:00:00.000Z',
    columns: [col('ORDER_ID', 'INTEGER', 1), col('CUSTNO', 'INTEGER', 2)],
  },
  CUSTOMERS: {
    schema: 'SALESLIB',
    table: 'CUSTOMERS',
    type: 'T',
    text: 'Customers',
    cachedAt: '2026-10-26T12:00:00.000Z',
    columns: [col('CUSTNO', 'INTEGER', 1), col('NAME', 'VARCHAR(40)', 2)],
  },
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
  builder: { name: 'ORDERS + CUSTOMERS', sql: 'SELECT 1' },
} as unknown as ReportBuilderRun;

function mockApi(withSuggestion = true) {
  vi.spyOn(api, 'schemaTables').mockResolvedValue(tables);
  vi.spyOn(api, 'schemaColumns').mockImplementation(async (_s, t) => columnsOf[t]);
  const suggest = vi.spyOn(api, 'joinSuggestions').mockResolvedValue({
    suggestions: withSuggestion
      ? [
          {
            source: 'foreign-key',
            constraint: 'ORDERS_FK_CUSTOMER',
            label: 'ORDERS_FK_CUSTOMER: T1.CUSTNO = CUSTNO',
            on: [{ left: { table: 'T1', column: 'CUSTNO' }, right: { column: 'CUSTNO' } }],
          },
        ]
      : [],
  });
  const preview = vi.spyOn(api, 'previewReportSql').mockImplementation(async (spec) => ({
    sql: spec.joins?.length ? 'SELECT …\nINNER JOIN "SALESLIB"."CUSTOMERS" AS "T2"' : 'SELECT …',
    name: 'n',
    schema: spec.schema,
    table: spec.table,
    warnings: spec.joins?.length ? ['T1.D (DATE) is compared with T2.TS (TIMESTAMP).'] : [],
  }));
  const run = vi.spyOn(api, 'runReportBuilder').mockResolvedValue(runResult);
  return { suggest, preview, run };
}

async function setup() {
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
  return user;
}

async function addCustomers(user: ReturnType<typeof userEvent.setup>, type = 'LEFT') {
  await user.selectOptions(screen.getByLabelText('Table to join'), 'SALESLIB.CUSTOMERS');
  await user.selectOptions(screen.getByLabelText('Join type'), type);
  await user.click(screen.getByRole('button', { name: 'Add table' }));
  await screen.findByRole('checkbox', { name: /T2\.NAME/ });
}

const lastSpec = (preview: ReturnType<typeof mockApi>['preview']) =>
  preview.mock.calls[preview.mock.calls.length - 1][0] as ReportSpec;

describe('describeSelection with joins', () => {
  it('counts the tables', () => {
    expect(
      describeSelection({
        schema: 'S',
        table: 'T',
        joins: [{ schema: 'S', table: 'U', type: 'INNER', on: [] }],
        columns: ['A'],
      }),
    ).toBe('1 column from 2 tables');
  });
});

describe('ReportBuilderPage joins', () => {
  it('adds a joined table and applies the suggested foreign-key condition', async () => {
    const { suggest, preview } = mockApi();
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await addCustomers(user);
    expect(suggest).toHaveBeenCalledWith(
      [{ alias: 'T1', schema: 'SALESLIB', table: 'ORDERS' }],
      'SALESLIB',
      'CUSTOMERS',
    );
    expect(await screen.findByText('ORDERS_FK_CUSTOMER: T1.CUSTNO = CUSTNO')).toBeInTheDocument();
    expect(screen.getByText('Joins can multiply rows.')).toBeInTheDocument();
    const diagram = screen.getByRole('list', { name: 'Join diagram' });
    expect(within(diagram).getByText(/ON T1\.CUSTNO = T2\.CUSTNO/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /T2\.NAME/ }));
    await waitFor(() =>
      expect(lastSpec(preview)).toEqual({
        schema: 'SALESLIB',
        table: 'ORDERS',
        joins: [
          {
            schema: 'SALESLIB',
            table: 'CUSTOMERS',
            type: 'LEFT',
            on: [{ left: { table: 'T1', column: 'CUSTNO' }, right: { column: 'CUSTNO' } }],
          },
        ],
        columns: [
          { table: 'T1', column: 'ORDER_ID' },
          { table: 'T2', column: 'NAME' },
        ],
        sort: [],
      }),
    );
    expect(await screen.findByText(/INNER JOIN "SALESLIB"."CUSTOMERS"/)).toBeInTheDocument();
    expect(screen.getByText(/compared with T2.TS/)).toBeInTheDocument();
  });

  it('lets the user alias the table, edit the condition and sort on a joined column', async () => {
    const { preview, run } = mockApi();
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await addCustomers(user, 'INNER');
    await user.type(screen.getByLabelText('Alias for CUSTOMERS'), 'c');
    await screen.findByRole('checkbox', { name: /C\.NAME/ });
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    await user.selectOptions(screen.getByLabelText('C condition 2 left column'), 'T1.ORDER_ID');
    await user.selectOptions(
      screen.getByLabelText('C condition 2 right column'),
      'C.CUSTNO (INTEGER)',
    );
    await user.click(screen.getByRole('checkbox', { name: /C\.NAME/ }));
    await user.click(screen.getByRole('button', { name: 'Add sort column' }));
    await user.selectOptions(screen.getByLabelText('Sort 1 column'), 'C.NAME');
    await waitFor(() => {
      const spec = lastSpec(preview);
      expect(spec.joins?.[0]).toMatchObject({ alias: 'C', type: 'INNER' });
      expect(spec.joins?.[0].on).toHaveLength(2);
      expect(spec.joins?.[0].on[1]).toEqual({
        left: { table: 'T1', column: 'ORDER_ID' },
        right: { column: 'CUSTNO' },
      });
      expect(spec.sort).toEqual([{ table: 'C', column: 'NAME', direction: 'ASC' }]);
    });
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ joins: expect.any(Array) }),
        expect.any(String),
      ),
    );
  });

  it('flags a join with no condition and an invalid alias, and blocks Run', async () => {
    mockApi(false);
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await addCustomers(user);
    expect(await screen.findByText(/No foreign key or same-name column/)).toBeInTheDocument();
    expect(screen.getByText(/needs at least one ON condition/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Alias for CUSTOMERS'), '1X');
    expect(await screen.findByText(/aliases start with a letter/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run report' })).toBeDisabled();
  });

  it('removes a joined table with its columns and returns to the single-table spec', async () => {
    const { preview } = mockApi();
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await addCustomers(user);
    await user.click(screen.getByRole('checkbox', { name: /T2\.NAME/ }));
    await user.click(screen.getByRole('button', { name: 'Remove T2' }));
    await waitFor(() =>
      expect(lastSpec(preview)).toEqual({
        schema: 'SALESLIB',
        table: 'ORDERS',
        columns: ['ORDER_ID'],
        sort: [],
      }),
    );
    expect(screen.queryByText('Joins can multiply rows.')).not.toBeInTheDocument();
  });

  it('joins the same table twice under different aliases', async () => {
    const { suggest, preview } = mockApi(false);
    const user = await setup();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await user.selectOptions(screen.getByLabelText('Table to join'), 'SALESLIB.ORDERS');
    await user.click(screen.getByRole('button', { name: 'Add table' }));
    await screen.findByRole('checkbox', { name: /T2\.ORDER_ID/ });
    expect(suggest).toHaveBeenCalledWith(
      [{ alias: 'T1', schema: 'SALESLIB', table: 'ORDERS' }],
      'SALESLIB',
      'ORDERS',
    );
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    await user.selectOptions(screen.getByLabelText('T2 condition 1 left column'), 'T1.CUSTNO');
    await user.selectOptions(
      screen.getByLabelText('T2 condition 1 right column'),
      'T2.CUSTNO (INTEGER)',
    );
    await waitFor(() =>
      expect(lastSpec(preview).joins?.[0]).toMatchObject({
        table: 'ORDERS',
        on: [expect.anything()],
      }),
    );
  });
});
