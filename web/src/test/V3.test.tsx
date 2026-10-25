import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { Report, RunResponse } from '../api/types';
import { AccessAuditModal, describeEvent } from '../components/AccessAuditModal';
import { ResultsTable } from '../components/ResultsTable';
import { SavedReportsPage } from '../pages/SavedReportsPage';
import { compareCells, compareDecimalStrings } from '../utils/format';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-alice', username: 'alice', displayName: 'Alice', role: 'USER' },
    loading: false,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const dec = {
  key: 'c0',
  name: 'AMT',
  label: 'AMT',
  type: 'DECIMAL',
  kind: 'decimal' as const,
  precision: 31,
  scale: 2,
  nullable: true,
};

describe('exact decimal sorting', () => {
  it('compares decimal strings beyond double precision exactly', () => {
    expect(compareDecimalStrings('12345678901234567890.02', '12345678901234567890.01')).toBe(1);
    expect(compareDecimalStrings('9223372036854775807', '9223372036854775806')).toBe(1);
    expect(compareDecimalStrings('-1.50', '-1.5')).toBe(0);
    expect(compareDecimalStrings('-0.00', '0')).toBe(0);
    expect(compareDecimalStrings('-2', '1')).toBe(-1);
    expect(compareDecimalStrings('-10.1', '-9.99')).toBe(-1);
    expect(compareDecimalStrings('1e5', '1')).toBeNull();
    expect(compareCells('100.00', '99.99', dec)).toBeGreaterThan(0);
    expect(Number('12345678901234567890.02') - Number('12345678901234567890.01')).toBe(0);
  });
});

const paged: RunResponse = {
  executionId: 'e1',
  columns: [{ ...dec, precisionAtRisk: true }],
  rows: [['12345678901234567890.01'], ['2.00']],
  rowCount: 2,
  truncated: false,
  maxRows: 100,
  startedAt: '2026-10-24T10:00:00.000Z',
  completedAt: '2026-10-24T10:00:01.000Z',
  durationMs: 10,
  dataSource: 'demo',
  hasMore: true,
  cursor: { id: 'cur-1', expiresAt: '2026-10-24T10:02:00.000Z', pageSize: 2 },
};

describe('ResultsTable server paging', () => {
  it('loads the next page and appends rows until the cursor is exhausted', async () => {
    const next = vi.spyOn(api, 'nextPage').mockResolvedValue({
      cursorId: 'cur-1',
      rows: [['3.00']],
      rowCount: 3,
      hasMore: false,
      truncated: false,
    });
    vi.spyOn(api, 'closeCursor').mockResolvedValue(undefined);
    render(<ResultsTable result={paged} />);
    expect(screen.getByText(/more available/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Precision may be reduced' })).toBeInTheDocument();
    expect(screen.getByText('12345678901234567890.01')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load next 2 rows' }));
    expect(next).toHaveBeenCalledWith('cur-1');
    expect(await screen.findByText('3.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load next/ })).not.toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Query results' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('explains an expired cursor', async () => {
    vi.spyOn(api, 'nextPage').mockRejectedValue(new ApiError(410, 'CURSOR_EXPIRED', 'gone'));
    vi.spyOn(api, 'closeCursor').mockResolvedValue(undefined);
    render(<ResultsTable result={paged} />);
    await userEvent.click(screen.getByRole('button', { name: /Load next/ }));
    expect(await screen.findByText('Result cursor expired.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load next/ })).not.toBeInTheDocument();
  });

  it('releases an open cursor when unmounted', () => {
    const close = vi.spyOn(api, 'closeCursor').mockResolvedValue(undefined);
    const { unmount } = render(<ResultsTable result={paged} />);
    unmount();
    expect(close).toHaveBeenCalledWith('cur-1');
  });

  it('explains when paging is unavailable', () => {
    render(
      <ResultsTable
        result={{
          ...paged,
          hasMore: false,
          cursor: undefined,
          truncated: true,
          pagingUnavailable: true,
        }}
      />,
    );
    expect(screen.getByText(/too many open result cursors/)).toBeInTheDocument();
  });
});

const rep = (over: Partial<Report>): Report => ({
  id: 'x',
  name: 'x',
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
  ...over,
});

describe('Saved Reports with shared reports', () => {
  it('lists owned and shared reports and filters by owner and access', async () => {
    vi.spyOn(api, 'history').mockResolvedValue([]);
    vi.spyOn(api, 'listAllReports').mockResolvedValue({
      owned: [rep({ id: '1', name: 'Mine' })],
      shared: [
        rep({ id: '2', name: 'Bobs viewer', ownerId: 'u-bob', ownerName: 'Bob', access: 'VIEWER' }),
        rep({
          id: '3',
          name: 'Carol editor',
          ownerId: 'u-carol',
          ownerName: 'Carol',
          access: 'EDITOR',
        }),
      ],
    });
    render(
      <MemoryRouter>
        <SavedReportsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mine')).toBeInTheDocument();
    expect(screen.getByText('Bobs viewer')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('My access'), 'EDITOR');
    expect(screen.queryByText('Mine')).not.toBeInTheDocument();
    expect(screen.queryByText('Bobs viewer')).not.toBeInTheDocument();
    expect(screen.getByText('Carol editor')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('My access'), 'all');
    await userEvent.selectOptions(screen.getByLabelText('Owner'), 'u-bob');
    expect(screen.getByText('Bobs viewer')).toBeInTheDocument();
    expect(screen.queryByText('Carol editor')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Owner'), 'me');
    expect(screen.getByText('Mine')).toBeInTheDocument();
    expect(screen.queryByText('Bobs viewer')).not.toBeInTheDocument();
  });
});

describe('Access and audit panel', () => {
  it('shows current access and the share history', async () => {
    vi.spyOn(api, 'getAccess').mockResolvedValue({
      owner: { id: 'u-alice', displayName: 'Alice' },
      shares: [{ type: 'GROUP', id: 'finance', role: 'VIEWER' }],
      events: [
        {
          id: 'a2',
          reportId: '1',
          action: 'REVOKE',
          principalType: 'USER',
          principalId: 'u-bob',
          principalName: 'Bob',
          oldRole: 'EDITOR',
          newRole: null,
          actorId: 'u-alice',
          actorName: 'Alice',
          occurredAt: '2026-10-24T10:00:00Z',
        },
      ],
    });
    render(<AccessAuditModal report={rep({ id: '1', name: 'Mine' })} onClose={() => {}} />);
    expect(await screen.findByText('Group finance')).toBeInTheDocument();
    expect(screen.getByText(/Alice revoked Editor access from Bob/)).toBeInTheDocument();
    await waitFor(() => expect(api.getAccess).toHaveBeenCalledWith('1'));
  });
  it('describes grants and changes', () => {
    const base = {
      id: 'a',
      reportId: '1',
      principalType: 'GROUP' as const,
      principalId: 'ops',
      actorId: 'u-a',
      actorName: 'Alice',
      occurredAt: '',
    };
    expect(describeEvent({ ...base, action: 'GRANT', oldRole: null, newRole: 'VIEWER' })).toBe(
      'Alice granted Viewer access to group ops',
    );
    expect(describeEvent({ ...base, action: 'CHANGE', oldRole: 'VIEWER', newRole: 'EDITOR' })).toBe(
      'Alice changed group ops from Viewer to Editor',
    );
  });
});
