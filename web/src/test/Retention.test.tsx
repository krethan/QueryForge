import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach } from 'vitest';
import { ApiError, api } from '../api/client';
import type { RetentionRun, RetentionState } from '../api/types';
import { navFor, pageTitle } from '../components/AppShell';
import { RetentionPage, keptFor } from '../pages/RetentionPage';

const auth = vi.hoisted(() => ({ role: 'ADMIN' as 'ADMIN' | 'USER' }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', username: 'admin', displayName: 'Ada Admin', role: auth.role },
    loading: false,
    logout: vi.fn(),
  }),
}));

beforeEach(() => {
  auth.role = 'ADMIN';
});
afterEach(() => vi.restoreAllMocks());

const state = (extra: Partial<RetentionState> = {}): RetentionState => ({
  settings: [
    {
      key: 'deliveries',
      table: 'QF_SCHEDULE_DELIVERIES',
      label: 'Scheduled delivery history',
      group: 'history',
      days: 365,
    },
    {
      key: 'reminders',
      table: 'QF_SHARE_REMINDERS',
      label: 'Share expiry reminders sent (by share end date)',
      group: 'history',
      days: 180,
    },
    {
      key: 'shareAudit',
      table: 'QF_SHARE_AUDIT',
      label: 'Report sharing audit',
      group: 'audit',
      days: 0,
    },
  ],
  batchSize: 1000,
  maxBatches: 100,
  automatic: true,
  running: false,
  nextAutomaticAfter: null,
  lastRun: null,
  ...extra,
});
const run = (extra: Partial<RetentionRun> = {}): RetentionRun => ({
  trigger: 'MANUAL',
  requestedBy: 'admin',
  startedAt: '2026-11-13T09:00:00Z',
  finishedAt: '2026-11-13T09:00:01Z',
  deleted: 1204,
  tables: [
    {
      key: 'deliveries',
      table: 'QF_SCHEDULE_DELIVERIES',
      days: 365,
      cutoff: '2025-11-13T09:00:00Z',
      deleted: 1200,
      batches: 2,
      complete: true,
      error: null,
    },
    {
      key: 'reminders',
      table: 'QF_SHARE_REMINDERS',
      days: 180,
      cutoff: '2026-05-17T09:00:00Z',
      deleted: 4,
      batches: 1,
      complete: true,
      error: null,
    },
    {
      key: 'shareAudit',
      table: 'QF_SHARE_AUDIT',
      days: 0,
      cutoff: null,
      deleted: 0,
      batches: 0,
      complete: true,
      error: null,
    },
  ],
  ...extra,
});
const renderPage = () =>
  render(
    <MemoryRouter>
      <RetentionPage />
    </MemoryRouter>,
  );

describe('Data retention', () => {
  it('is in the side navigation for admins only', () => {
    expect(navFor('ADMIN').map((x) => x.label)).toContain('Data retention');
    expect(navFor('USER').map((x) => x.label)).not.toContain('Data retention');
    expect(pageTitle('/admin/retention')).toBe('Data retention \u2014 Uncle Bob');
  });

  it('formats periods, 0 meaning for ever', () => {
    expect(keptFor(0)).toBe('Forever');
    expect(keptFor(1)).toBe('1 day');
    expect(keptFor(365)).toBe('365 days');
  });

  it('tells a non-admin it is admin only and never calls the API', () => {
    auth.role = 'USER';
    const get = vi.spyOn(api, 'getRetention');
    renderPage();
    expect(screen.getByRole('heading', { name: 'Admins only' })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('shows admins only if the server says 403', async () => {
    vi.spyOn(api, 'getRetention').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'No'));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Admins only' })).toBeInTheDocument();
  });

  it('lists each table with how long it is kept', async () => {
    vi.spyOn(api, 'getRetention').mockResolvedValue(state());
    renderPage();
    const table = await screen.findByRole('table', { name: 'Retention settings' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[2].textContent)).toEqual([
      '365 days',
      '180 days',
      'Forever',
    ]);
    expect(within(rows[2]).getByText('Audit')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Retention status' })).toHaveTextContent(
      'Runs automatically about once a day on the scheduler. No run since the server started.',
    );
  });

  it('says when automatic runs are off', async () => {
    vi.spyOn(api, 'getRetention').mockResolvedValue(state({ automatic: false }));
    renderPage();
    expect(await screen.findByRole('status', { name: 'Retention status' })).toHaveTextContent(
      'Automatic runs are off on this server',
    );
  });

  it('runs now after confirming, then shows what was deleted', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getRetention').mockResolvedValue(state());
    const done = run();
    const post = vi
      .spyOn(api, 'runRetention')
      .mockResolvedValue({ ...state({ lastRun: done }), run: done });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    expect(post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete old history' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(await screen.findByText('Deleted 1,204 old row(s).')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Retention settings' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[3].textContent)).toEqual([
      '1,200',
      '4',
      'Kept',
    ]);
    expect(screen.getByRole('status', { name: 'Retention status' })).toHaveTextContent(
      '(run now by admin): 1,204 row(s)',
    );
  });

  it('cancelling the confirmation runs nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getRetention').mockResolvedValue(state());
    const post = vi.spyOn(api, 'runRetention');
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();
  });

  it('flags tables that failed or have more left', async () => {
    const last = run();
    last.tables[0] = { ...last.tables[0], error: 'Row or object in use.', complete: false };
    last.tables[1] = { ...last.tables[1], complete: false };
    vi.spyOn(api, 'getRetention').mockResolvedValue(state({ lastRun: last }));
    renderPage();
    expect(await screen.findByText('Some tables could not be pruned')).toBeInTheDocument();
    expect(screen.getByText(/QF_SCHEDULE_DELIVERIES: Row or object in use\./)).toBeInTheDocument();
    expect(screen.getByText('4 (more left)')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('cannot run when every table is kept for ever, or while a run is in progress', async () => {
    const forever = state();
    forever.settings = forever.settings.map((s) => ({ ...s, days: 0 }));
    vi.spyOn(api, 'getRetention').mockResolvedValue(forever);
    const { unmount } = renderPage();
    expect(await screen.findByRole('button', { name: 'Run now' })).toBeDisabled();
    unmount();
    vi.spyOn(api, 'getRetention').mockResolvedValue(state({ running: true }));
    renderPage();
    expect(await screen.findByRole('button', { name: 'Run now' })).toBeDisabled();
  });
});
