import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage';
import { api } from '../api/client';

describe('DashboardPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows an empty state when there are no reports', async () => {
    vi.spyOn(api, 'listReports').mockResolvedValue([]);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No saved reports yet')).toBeInTheDocument();
  });

  it('renders a tile per report with last-run details', async () => {
    vi.spyOn(api, 'listReports').mockResolvedValue([
      {
        id: '1',
        name: 'Open Orders',
        description: 'Unshipped',
        category: 'Sales',
        sql: 'SELECT 1 FROM T',
        version: 1,
        createdAt: null,
        updatedAt: null,
        lastExecutedAt: '2026-10-23T10:00:00Z',
        lastStatus: 'SUCCEEDED',
        lastRowCount: 42,
        lastDurationMs: 250,
      },
    ]);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Open Orders')).toBeInTheDocument();
    expect(screen.getByText(/42 rows/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run/ })).toBeInTheDocument();
  });
});
