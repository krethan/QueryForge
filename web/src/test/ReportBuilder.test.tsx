import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type {
  Report,
  ReportBuilderRun,
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
    { schema: 'SALESLIB', name: 'ORDERS', type: 'T', typeLabel: 'Table', text: 'Customer orders' },
    {
      schema: 'SALESLIB',
      name: 'OPEN_ORDERS',
      type: 'V',
      typeLabel: 'View',
      text: 'Orders not shipped',
    },
  ],
  truncated: false,
  cachedAt: '2026-10-26T12:00:00.000Z',
  maxTables: 500,
};

const columns: SchemaColumnsResponse = {
  schema: 'SALESLIB',
  table: 'ORDERS',
  type: 'T',
  text: 'Customer orders',
  cachedAt: '2026-10-26T12:00:00.000Z',
  columns: [
    {
      name: 'ORDER_ID',
      type: 'INTEGER',
      displayType: 'INTEGER',
      length: 4,
      precision: 10,
      scale: 0,
      nullable: false,
      text: 'Order number',
      ordinal: 1,
    },
    {
      name: 'CUSTOMER',
      type: 'VARCHAR',
      displayType: 'VARCHAR(40)',
      length: 40,
      precision: 40,
      scale: null,
      nullable: true,
      text: 'Customer name',
      ordinal: 2,
    },
    {
      name: 'AMOUNT',
      type: 'DECIMAL',
      displayType: 'DECIMAL(11, 2)',
      length: 11,
      precision: 11,
      scale: 2,
      nullable: true,
      text: 'Order total',
      ordinal: 3,
    },
  ],
};

const runResult: ReportBuilderRun = {
  executionId: 'e-1',
  columns: [
    {
      key: 'c0',
      name: 'ORDER_ID',
      label: 'ORDER_ID',
      type: 'INTEGER',
      kind: 'integer',
      precision: 10,
      scale: 0,
      nullable: false,
    },
    {
      key: 'c1',
      name: 'CUSTOMER',
      label: 'CUSTOMER',
      type: 'VARCHAR',
      kind: 'text',
      precision: 40,
      scale: 0,
      nullable: true,
    },
  ],
  rows: [
    [1, 'Acme'],
    [2, 'Globex'],
  ],
  rowCount: 2,
  truncated: false,
  maxRows: 100,
  startedAt: '2026-10-26T12:00:00.000Z',
  completedAt: '2026-10-26T12:00:01.000Z',
  durationMs: 8,
  dataSource: 'demo',
  builder: {
    name: 'ORDERS: ORDER_ID, CUSTOMER sorted by AMOUNT DESC',
    sql: 'SELECT "ORDER_ID", "CUSTOMER"\nFROM "SALESLIB"."ORDERS"\nORDER BY "AMOUNT" DESC',
  },
};

function mockApi() {
  const schemaTables = vi.spyOn(api, 'schemaTables').mockResolvedValue(tables);
  const schemaColumns = vi.spyOn(api, 'schemaColumns').mockResolvedValue(columns);
  const preview = vi.spyOn(api, 'previewReportSql').mockImplementation(async (spec) => ({
    sql: `SELECT ${spec.columns.map((c) => `"${c}"`).join(', ')}\nFROM "${spec.schema}"."${spec.table}"${
      spec.sort?.length
        ? `\nORDER BY ${spec.sort.map((s) => `"${s.column}" ${s.direction}`).join(', ')}`
        : ''
    }`,
    name: `${spec.table}: ${spec.columns.join(', ')}`,
    schema: spec.schema,
    table: spec.table,
  }));
  const run = vi.spyOn(api, 'runReportBuilder').mockResolvedValue(runResult);
  const create = vi.spyOn(api, 'createReport').mockResolvedValue({
    id: 'rep-1',
    name: 'ORDERS: ORDER_ID, CUSTOMER',
  } as Report);
  return { schemaTables, schemaColumns, preview, run, create };
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/report-builder']}>
      <Routes>
        <Route path="/report-builder" element={<ReportBuilderPage />} />
        <Route path="/reports/:id" element={<p>saved report page</p>} />
      </Routes>
    </MemoryRouter>,
  );

async function chooseTable(name = 'SALESLIB.ORDERS') {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByText(name));
  await screen.findByRole('checkbox', { name: /ORDER_ID/ });
  return user;
}

describe('describeSelection', () => {
  it('summarises columns and sort keys', () => {
    expect(describeSelection({ schema: 'S', table: 'T', columns: ['A'] })).toBe('1 column');
    expect(
      describeSelection({
        schema: 'S',
        table: 'T',
        columns: ['A', 'B'],
        sort: [{ column: 'A', direction: 'DESC' }],
      }),
    ).toBe('2 columns, 1 sort key');
  });
});

describe('ReportBuilderPage', () => {
  it('lists catalogued tables and flags views', async () => {
    const { schemaTables } = mockApi();
    renderPage();
    expect(await screen.findByText('SALESLIB.ORDERS')).toBeInTheDocument();
    expect(screen.getByText('OPEN_ORDERS', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('View')).toBeInTheDocument();
    expect(schemaTables).toHaveBeenCalledWith('', 100);
  });

  it('searches the catalog through the API, not the whole list client-side', async () => {
    const { schemaTables } = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SALESLIB.ORDERS');
    await user.type(screen.getByPlaceholderText('Search schema or table'), 'cust');
    await waitFor(() => expect(schemaTables).toHaveBeenCalledWith('cust', 100));
  });

  it('loads the columns of the chosen table', async () => {
    const { schemaColumns } = mockApi();
    await chooseTable();
    expect(schemaColumns).toHaveBeenCalledWith('SALESLIB', 'ORDERS');
    expect(screen.getByRole('checkbox', { name: /CUSTOMER/ })).toBeInTheDocument();
  });

  it('selects all columns, then reorders and removes them', async () => {
    const { preview } = mockApi();
    const user = await chooseTable();
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ columns: ['ORDER_ID', 'CUSTOMER', 'AMOUNT'] }),
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Move CUSTOMER up' }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ columns: ['CUSTOMER', 'ORDER_ID', 'AMOUNT'] }),
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Remove AMOUNT' }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ columns: ['CUSTOMER', 'ORDER_ID'] }),
        expect.any(AbortSignal),
      ),
    );
  });

  it('adds and removes sort rows with the chosen direction', async () => {
    const { preview } = mockApi();
    const user = await chooseTable();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await user.click(screen.getByRole('checkbox', { name: /CUSTOMER/ }));
    await user.click(screen.getByRole('button', { name: /Add sort column/ }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: [{ column: 'ORDER_ID', direction: 'ASC' }] }),
        expect.any(AbortSignal),
      ),
    );
    await user.selectOptions(screen.getByLabelText('Direction'), 'DESC');
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: [{ column: 'ORDER_ID', direction: 'DESC' }] }),
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Remove sort 1' }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: [] }),
        expect.any(AbortSignal),
      ),
    );
  });

  it('shows the server-built SQL preview and runs it', async () => {
    const { run } = mockApi();
    const user = await chooseTable();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await user.click(screen.getByRole('checkbox', { name: /CUSTOMER/ }));
    expect(
      await screen.findByText(/FROM "SALESLIB"."ORDERS"/, { exact: false }),
    ).toBeInTheDocument();
    const runButton = screen.getByRole('button', { name: 'Run report' });
    await waitFor(() => expect(runButton).toBeEnabled());
    await user.click(runButton);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0]).toEqual({
      schema: 'SALESLIB',
      table: 'ORDERS',
      columns: ['ORDER_ID', 'CUSTOMER'],
      sort: [],
    });
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });

  it('saves the built SQL as a new report with a generated name', async () => {
    const { create } = mockApi();
    const user = await chooseTable();
    await user.click(screen.getByRole('checkbox', { name: /ORDER_ID/ }));
    await screen.findByText(/FROM "SALESLIB"."ORDERS"/, { exact: false });
    await user.click(screen.getByRole('button', { name: 'Save as report' }));
    const name = await screen.findByLabelText(/Report name|Name/);
    await waitFor(() => expect(name).toHaveValue('ORDERS: ORDER_ID'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'ORDERS: ORDER_ID',
      sql: 'SELECT "ORDER_ID"\nFROM "SALESLIB"."ORDERS"',
      parameters: [],
    });
    expect(await screen.findByText('saved report page')).toBeInTheDocument();
  });

  it('surfaces catalog errors without breaking the page', async () => {
    vi.spyOn(api, 'schemaTables').mockRejectedValue(new Error('catalog is down'));
    renderPage();
    expect(await screen.findByText(/catalog is down/)).toBeInTheDocument();
  });
});
