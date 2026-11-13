import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { SchemaColumn, SchemaColumnsResponse, SchemaTablesResponse } from '../api/types';
import { ReportBuilderPage, columnsCapOf, hydrate } from '../pages/ReportBuilderPage';

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
    { schema: 'SALESLIB', name: 'WIDE', type: 'T', typeLabel: 'Table', text: 'Very wide' },
    { schema: 'SALESLIB', name: 'ORDERS', type: 'T', typeLabel: 'Table', text: 'Orders' },
    { schema: 'SALESLIB', name: 'HUB', type: 'T', typeLabel: 'Table', text: 'Many keys' },
  ],
  truncated: false,
  cachedAt: '2026-11-13T09:00:00.000Z',
  maxTables: 500,
};

const col = (name: string, ordinal: number): SchemaColumn => ({
  name,
  type: 'INTEGER',
  displayType: 'INTEGER',
  length: 4,
  precision: 10,
  scale: 0,
  nullable: true,
  text: null,
  ordinal,
});

const response = (table: string, truncated: boolean): SchemaColumnsResponse => ({
  schema: 'SALESLIB',
  table,
  type: 'T',
  text: null,
  cachedAt: '2026-11-13T09:00:00.000Z',
  truncated,
  maxColumns: 1000,
  columns: [col('ID', 1), col('CUSTNO', 2)],
});

const columnsOf: Record<string, SchemaColumnsResponse> = {
  WIDE: response('WIDE', true),
  ORDERS: response('ORDERS', false),
  HUB: response('HUB', false),
};

function mockApi(foreignKeysTruncated: boolean) {
  vi.spyOn(api, 'schemaTables').mockResolvedValue(tables);
  vi.spyOn(api, 'schemaColumns').mockImplementation(async (_s, t) => columnsOf[t]);
  vi.spyOn(api, 'joinSuggestions').mockResolvedValue({
    suggestions: [],
    foreignKeysTruncated,
    maxForeignKeyRows: 1000,
  });
  vi.spyOn(api, 'previewReportSql').mockImplementation(async (spec) => ({
    sql: 'SELECT …',
    name: 'n',
    schema: spec.schema,
    table: spec.table,
  }));
}

async function open(table: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/report-builder']}>
      <Routes>
        <Route path="/report-builder" element={<ReportBuilderPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(await screen.findByText(`SALESLIB.${table}`));
  await screen.findByRole('checkbox', { name: /CUSTNO/ });
  return user;
}

async function join(user: ReturnType<typeof userEvent.setup>, table: string) {
  await user.selectOptions(screen.getByLabelText('Table to join'), `SALESLIB.${table}`);
  await user.click(screen.getByRole('button', { name: 'Add table' }));
  await screen.findByRole('checkbox', { name: /T2\.CUSTNO/ });
}

const COLUMNS_NOTICE = /This table has more than 1,000 columns\. Only the first 1,000/;
const FK_NOTICE = /more than 1,000 foreign-key columns; only the first 1,000 were checked/;

describe('Report Builder catalog caps', () => {
  it('columnsCapOf reads the cap only when the list was cut short', () => {
    expect(columnsCapOf(columnsOf.WIDE)).toBe(1000);
    expect(columnsCapOf(columnsOf.ORDERS)).toBeNull();
    // an older server without the fields: no notice
    const old: SchemaColumnsResponse = {
      schema: 'SALESLIB',
      table: 'ORDERS',
      type: 'T',
      text: null,
      cachedAt: '2026-11-13T09:00:00.000Z',
      columns: [col('ID', 1)],
    };
    expect(columnsCapOf(old)).toBeNull();
    // truncated without a cap falls back to the documented 1000
    expect(columnsCapOf({ ...old, truncated: true })).toBe(1000);
  });

  it('shows a notice under a base table whose columns were truncated', async () => {
    mockApi(false);
    await open('WIDE');
    expect(screen.getByText(COLUMNS_NOTICE)).toBeInTheDocument();
  });

  it('shows no notice for a complete column list', async () => {
    mockApi(false);
    await open('ORDERS');
    expect(screen.queryByText(COLUMNS_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(FK_NOTICE)).not.toBeInTheDocument();
  });

  it('shows the column notice for a joined table and the foreign-key notice', async () => {
    mockApi(true);
    const user = await open('ORDERS');
    await join(user, 'WIDE');
    expect(await screen.findByText(FK_NOTICE)).toBeInTheDocument();
    expect(screen.getAllByText(COLUMNS_NOTICE)).toHaveLength(1);
  });

  it('shows no foreign-key notice when every foreign key was checked', async () => {
    mockApi(false);
    const user = await open('ORDERS');
    await join(user, 'HUB');
    expect(await screen.findByText(/No foreign key or same-name column found/)).toBeInTheDocument();
    expect(screen.queryByText(FK_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(COLUMNS_NOTICE)).not.toBeInTheDocument();
  });

  it('keeps the flag when a saved report is reopened', async () => {
    mockApi(false);
    const h = await hydrate({
      schema: 'SALESLIB',
      table: 'WIDE',
      joins: [{ schema: 'SALESLIB', table: 'ORDERS', type: 'INNER', on: [] }],
      columns: ['ID'],
    });
    expect(h.columnsCap).toBe(1000);
    expect(h.joins[0].columnsCap).toBeNull();
  });
});
