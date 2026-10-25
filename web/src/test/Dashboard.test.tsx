import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage';
import { api } from '../api/client';

describe('DashboardPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows an empty state when there are no reports', async () => {
    vi.spyOn(api, 'listAllReports').mockResolvedValue({ owned: [], shared: [] });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No saved reports yet')).toBeInTheDocument();
  });

  it('renders a tile per report with last-run details', async () => {
    vi.spyOn(api, 'listAllReports').mockResolvedValue({
      shared: [],
      owned: [
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
      ],
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Open Orders')).toBeInTheDocument();
    expect(screen.getByText(/42 rows/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run/ })).toBeInTheDocument();
  });

  it('lists reports shared with me with owner and access, without delete', async () => {
    vi.spyOn(api, 'listAllReports').mockResolvedValue({
      owned: [],
      shared: [
        {
          id: 's1',
          name: 'Regional Pipeline (Pat)',
          description: null,
          category: null,
          sql: 'SELECT 1 FROM T',
          version: 1,
          createdAt: null,
          updatedAt: null,
          lastExecutedAt: null,
          lastStatus: 'NEVER',
          lastRowCount: null,
          lastDurationMs: null,
          ownerId: 'u-pat',
          ownerName: 'Pat Lee',
          access: 'VIEWER',
          parameters: [],
        },
      ],
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Shared with me' })).toBeInTheDocument();
    expect(screen.getByText(/Shared by Pat Lee/)).toBeInTheDocument();
    expect(screen.getByTitle('Viewer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Regional/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Open/ })).toBeInTheDocument();
  });
});
