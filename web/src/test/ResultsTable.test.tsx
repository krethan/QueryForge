import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultsTable } from '../components/ResultsTable';
import type { RunResponse } from '../api/types';

const base: RunResponse = {
  executionId: 'e',
  columns: [
    {
      key: 'c0',
      name: 'ID',
      label: 'ID',
      type: 'INTEGER',
      kind: 'integer',
      precision: 10,
      scale: 0,
      nullable: false,
    },
    {
      key: 'c1',
      name: 'AMT',
      label: 'AMT',
      type: 'DECIMAL',
      kind: 'decimal',
      precision: 9,
      scale: 2,
      nullable: true,
    },
    {
      key: 'c2',
      name: 'NOTE',
      label: 'NOTE',
      type: 'VARCHAR',
      kind: 'text',
      precision: 20,
      scale: 0,
      nullable: true,
    },
  ],
  rows: [
    [1, '10.00', ''],
    [2, null, 'b'],
    [3, '9.50', null],
  ],
  rowCount: 3,
  truncated: false,
  maxRows: 5000,
  startedAt: '2026-10-23T10:00:00.000Z',
  completedAt: '2026-10-23T10:00:01.000Z',
  durationMs: 1234,
  dataSource: 'TEST400',
};

const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('ResultsTable', () => {
  it('shows headers, row count, duration and data source', () => {
    render(<ResultsTable result={base} />);
    expect(screen.getByRole('columnheader', { name: /AMT/ })).toBeInTheDocument();
    expect(screen.getByText('rows').parentElement).toHaveTextContent('3 rows');
    expect(screen.getByText(/1\.23 s/)).toBeInTheDocument();
    expect(screen.getByText(/TEST400/)).toBeInTheDocument();
  });

  it('renders NULL distinctly from empty strings', () => {
    render(<ResultsTable result={base} />);
    expect(screen.getAllByTitle('NULL')).toHaveLength(2);
    const firstRowCells = within(bodyRows()[0]).getAllByRole('cell');
    expect(firstRowCells[2]).toHaveTextContent(/^$/);
  });

  it('sorts numerically with NULLs last', async () => {
    render(<ResultsTable result={base} />);
    await userEvent.click(screen.getByRole('button', { name: /AMT/ }));
    expect(bodyRows().map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      '3',
      '1',
      '2',
    ]);
    await userEvent.click(screen.getByRole('button', { name: /AMT/ }));
    expect(bodyRows().map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      '1',
      '3',
      '2',
    ]);
  });

  it('warns when results are truncated', () => {
    render(<ResultsTable result={{ ...base, truncated: true, maxRows: 3 }} />);
    expect(screen.getByText(/Results limited/)).toBeInTheDocument();
  });

  it('shows an empty state for zero rows', () => {
    render(<ResultsTable result={{ ...base, rows: [], rowCount: 0 }} />);
    expect(screen.getByText('No rows returned')).toBeInTheDocument();
  });
});
