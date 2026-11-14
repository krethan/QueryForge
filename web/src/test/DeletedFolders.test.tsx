import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach } from 'vitest';
import { ApiError, api } from '../api/client';
import type { FolderDeletion, FolderDeletionPage, FolderShareAuditEvent } from '../api/types';
import { AppShell, navFor, pageTitle } from '../components/AppShell';
import { DeletedFoldersPage, deletedRange, startOfDayIso } from '../pages/DeletedFoldersPage';
import { formatDateTime } from '../utils/format';

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

let n = 0;
const deletion = (extra: Partial<FolderDeletion> = {}): FolderDeletion => {
  n++;
  return {
    id: `d${n}`,
    folderId: `f0000000-0000-4000-8000-00000000000${n}`,
    folderName: `Folder ${n}`,
    ownerId: 'u-pat',
    ownerName: 'Pat',
    actorId: 'u-pat',
    actorName: 'Pat',
    shareCount: 2,
    placedCount: 1,
    filedCount: 3,
    reportsRole: 'VIEWER',
    deletedAt: '2026-11-12T18:30:00Z',
    ...extra,
  };
};
const pageOf = (
  deletions: FolderDeletion[],
  extra: Partial<FolderDeletionPage> = {},
): FolderDeletionPage => ({
  deletions,
  hasMore: false,
  total: deletions.length,
  next: null,
  limit: 25,
  offset: 0,
  ...extra,
});
const ev = (extra: Partial<FolderShareAuditEvent> = {}): FolderShareAuditEvent => ({
  id: `e${++n}`,
  folderId: 'f1',
  action: 'REVOKE',
  principalType: 'USER',
  principalId: 'u-sam',
  principalName: 'Sam',
  oldRole: 'VIEWER',
  newRole: null,
  actorId: 'u-pat',
  actorName: 'Pat',
  occurredAt: '2026-11-12T18:30:00Z',
  ...extra,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <DeletedFoldersPage />
    </MemoryRouter>,
  );

describe('Deleted folders navigation', () => {
  it('lists the screen in the side navigation for admins only', () => {
    expect(navFor('ADMIN').map((x) => x.label)).toContain('Deleted folders');
    expect(navFor('USER').map((x) => x.label)).not.toContain('Deleted folders');
    expect(navFor(undefined).map((x) => x.label)).not.toContain('Deleted folders');
    expect(pageTitle('/admin/deleted-folders')).toBe('Deleted folders \u2014 Uncle Bob');
  });

  it('shows the nav link to an admin and hides it from other users', () => {
    const shell = () =>
      render(
        <MemoryRouter>
          <AppShell>
            <p>body</p>
          </AppShell>
        </MemoryRouter>,
      );
    const { unmount } = shell();
    expect(screen.getByRole('link', { name: 'Deleted folders' })).toHaveAttribute(
      'href',
      '/admin/deleted-folders',
    );
    unmount();
    auth.role = 'USER';
    shell();
    expect(screen.queryByRole('link', { name: 'Deleted folders' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toBeInTheDocument();
  });
});

describe('DeletedFoldersPage', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listFolderDeletionActors').mockResolvedValue([]);
  });

  it('tells a non-admin it is admin only and never calls the API', () => {
    auth.role = 'USER';
    const list = vi.spyOn(api, 'listFolderDeletions');
    renderPage();
    expect(screen.getByRole('heading', { name: 'Admins only' })).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it('shows a loading state, then the deletions newest first with their details', async () => {
    let resolve!: (p: FolderDeletionPage) => void;
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    expect(screen.getByLabelText('Loading deleted folders')).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith({ limit: 25, cursor: null });
    const a = deletion({ folderName: 'Q3 Close', actorId: 'u-ada', actorName: 'Ada' });
    const b = deletion({
      folderName: 'Scratch',
      ownerId: 'u-gone',
      ownerName: undefined,
      actorId: 'u-gone',
      actorName: undefined,
      reportsRole: null,
      shareCount: 0,
      placedCount: 0,
      filedCount: 0,
      deletedAt: '2026-11-01T08:00:00Z',
    });
    resolve(pageOf([a, b]));
    const table = await screen.findByRole('table', { name: 'Deleted folders' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const first = within(rows[1])
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(first.slice(0, 8)).toEqual([
      'Q3 Close',
      'Pat',
      'Ada',
      formatDateTime(a.deletedAt),
      '2',
      '1',
      '3',
      'View only',
    ]);
    expect(within(rows[1]).getByText(formatDateTime(a.deletedAt))).toHaveAttribute(
      'datetime',
      a.deletedAt,
    );
    const second = within(rows[2])
      .getAllByRole('cell')
      .map((c) => c.textContent);
    // Users who no longer exist show by ID; no report sharing reads "Off".
    expect(second.slice(0, 8)).toEqual([
      'Scratch',
      'u-gone',
      'u-gone',
      formatDateTime(b.deletedAt),
      '0',
      '0',
      '0',
      'Off',
    ]);
    expect(screen.getByRole('button', { name: 'Sharing history for Q3 Close' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export CSV for Q3 Close' })).toBeEnabled();
  });

  it('shows an empty state when nothing has been deleted', async () => {
    vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([]));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No deleted folders' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error with a retry', async () => {
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockRejectedValueOnce(new ApiError(500, 'DB_ERROR', 'Db2 is unavailable'))
      .mockResolvedValueOnce(pageOf([deletion({ folderName: 'Back again' })]));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Db2 is unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back again')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('handles a 403 from the server as admin only, not as a failure', async () => {
    vi.spyOn(api, 'listFolderDeletions').mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', 'Only an admin can view deleted folders.'),
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Admins only' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pages with keyset cursors, shows the total and disables Next on the last page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => deletion({ folderName: `P1-${i}` }));
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockResolvedValueOnce(pageOf(page1, { hasMore: true, total: 26, next: 'c-2' }))
      .mockResolvedValueOnce(pageOf([deletion({ folderName: 'Oldest' })], { total: 26 }))
      .mockResolvedValueOnce(pageOf(page1, { hasMore: true, total: 26, next: 'c-2' }));
    renderPage();
    await screen.findByText('P1-0');
    expect(screen.getByText('1–25 of 26 deleted folders')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(next);
    expect(await screen.findByText('Oldest')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: 'c-2' });
    expect(screen.getByText('26–26 of 26 deleted folders')).toBeInTheDocument();
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('P1-0')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: null });
  });

  it('changes the page size and starts again from the first page', async () => {
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockResolvedValue(pageOf([deletion({ folderName: 'Only' })], { hasMore: true, next: 'c' }));
    renderPage();
    await screen.findByText('Only');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: 'c' }));
    await screen.findByText('Only');
    await userEvent.selectOptions(screen.getByLabelText('Deleted folders per page:'), '50');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ limit: 50, cursor: null }));
  });

  it('opens a deleted folder’s sharing history and loads older changes', async () => {
    const d = deletion({ folderName: 'Q3 Close', reportsRole: 'EDITOR' });
    vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([d]));
    const audit = vi
      .spyOn(api, 'getDeletedFolderAudit')
      .mockResolvedValueOnce({
        deletion: d,
        events: [
          ev(),
          ev({
            principalType: 'REPORTS',
            principalId: '*REPORTS',
            principalName: undefined,
            oldRole: 'EDITOR',
          }),
        ],
        hasMore: true,
        limit: 25,
        offset: 0,
      })
      .mockResolvedValueOnce({
        deletion: d,
        events: [ev({ action: 'GRANT', oldRole: null, newRole: 'VIEWER' })],
        hasMore: false,
        limit: 25,
        offset: 2,
      });
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Sharing history for Q3 Close' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Sharing history · Q3 Close (deleted)')).toBeInTheDocument();
    const history = await within(dialog).findByRole('list', { name: 'Sharing history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(history).toHaveTextContent('Pat revoked Viewer access from Sam');
    expect(history).toHaveTextContent('Pat turned off sharing the reports in this folder');
    const details = within(dialog).getByLabelText('Deletion details');
    expect(details).toHaveTextContent('Match folder access');
    expect(audit).toHaveBeenCalledWith(d.folderId);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(3));
    expect(audit).toHaveBeenLastCalledWith(d.folderId, 2);
    expect(
      within(dialog).queryByRole('button', { name: 'Show older changes' }),
    ).not.toBeInTheDocument();
  });

  it('exports a deleted folder’s sharing history as CSV from the row', async () => {
    const d = deletion({ folderName: 'Q3 Close' });
    vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([d]));
    const exp = vi
      .spyOn(api, 'exportDeletedFolderAudit')
      .mockResolvedValue({ filename: 'Q3 Close deleted audit.csv', size: 10 });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV for Q3 Close' }));
    expect(exp).toHaveBeenCalledWith(d.folderId);
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((s) => /Downloaded Q3 Close/.test(s.textContent ?? '')),
      ).toBe(true),
    );
  });

  it('shows an export failure without losing the list', async () => {
    const d = deletion({ folderName: 'Q3 Close' });
    vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([d]));
    vi.spyOn(api, 'exportDeletedFolderAudit').mockRejectedValue(
      new ApiError(404, 'DELETION_NOT_FOUND', 'No deletion is recorded for this folder.'),
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV for Q3 Close' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No deletion is recorded for this folder.',
    );
    expect(screen.getByRole('table', { name: 'Deleted folders' })).toBeInTheDocument();
  });
});

describe('DeletedFoldersPage search and filters', () => {
  const actors = [{ id: 'u-pat', name: 'Pat' }, { id: 'u-gone' }];
  beforeEach(() => {
    vi.spyOn(api, 'listFolderDeletionActors').mockResolvedValue(actors);
  });

  it('searches on the server after a pause, and shows how many match', async () => {
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockResolvedValueOnce(pageOf([deletion({ folderName: 'Q3 Close' }), deletion()]))
      .mockResolvedValue(pageOf([deletion({ folderName: 'Q3 Close' })], { total: 1 }));
    renderPage();
    await screen.findByText('Q3 Close');
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search deleted folders' }),
      'close%',
    );
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ q: 'close%', limit: 25, cursor: null }),
    );
    // One request for the whole word, not one per key.
    expect(list).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText('1–1 of 1 deleted folder matching your filters'),
    ).toBeInTheDocument();
  });

  it('filters by who deleted it and by local days, both inclusive', async () => {
    const list = vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([deletion()]));
    renderPage();
    const by = await screen.findByLabelText('Deleted by');
    await waitFor(() =>
      expect(within(by).getByRole('option', { name: 'Pat' })).toBeInTheDocument(),
    );
    // A deleter no longer in the user list is offered by ID.
    expect(within(by).getByRole('option', { name: 'u-gone' })).toBeInTheDocument();
    await userEvent.selectOptions(by, 'u-pat');
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ actorId: 'u-pat', limit: 25, cursor: null }),
    );
    await userEvent.type(screen.getByLabelText('Deleted from'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('Deleted to'), '2026-11-03');
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        actorId: 'u-pat',
        from: new Date(2026, 10, 1).toISOString(),
        to: new Date(2026, 10, 4).toISOString(),
        limit: 25,
        cursor: null,
      }),
    );
    expect(startOfDayIso('2026-11-01')).toBe(new Date(2026, 10, 1).toISOString());
    expect(deletedRange('', '')).toEqual({ from: undefined, to: undefined });
    expect(deletedRange('bad', '2026-11-03')).toEqual({
      from: undefined,
      to: new Date(2026, 10, 4).toISOString(),
    });
  });

  it('does not ask the server when "to" is before "from"', async () => {
    const list = vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([deletion()]));
    renderPage();
    await screen.findByRole('table', { name: 'Deleted folders' });
    await userEvent.type(screen.getByLabelText('Deleted to'), '2026-11-01');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await userEvent.type(screen.getByLabelText('Deleted from'), '2026-11-05');
    expect(await screen.findByText(/nothing can match/)).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Pick a day on or after “Deleted from”.')).toBeInTheDocument();
  });

  it('starts again from page 1 when a filter changes, and never reuses a cursor', async () => {
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockResolvedValue(pageOf([deletion({ folderName: 'Row' })], { hasMore: true, next: 'c1' }));
    renderPage();
    await screen.findByText('Row');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: 'c1' }));
    await screen.findByText('Row');
    await userEvent.selectOptions(screen.getByLabelText('Deleted by'), 'u-pat');
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ actorId: 'u-pat', limit: 25, cursor: null }),
    );
    expect(list.mock.calls.filter((c) => c[0]?.actorId && c[0]?.cursor)).toEqual([]);
    expect(await screen.findByText('Page 1')).toBeInTheDocument();
  });

  it('keeps the filters visible when nothing matches, and clears them', async () => {
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockResolvedValueOnce(pageOf([deletion({ folderName: 'Kept' })]))
      .mockResolvedValueOnce(pageOf([]))
      .mockResolvedValue(pageOf([deletion({ folderName: 'Kept' })]));
    renderPage();
    await screen.findByText('Kept');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search deleted folders' }), 'zzz');
    expect(await screen.findByText('No deleted folders match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No deleted folders' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export list' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Kept')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: null });
    expect(screen.getByRole('searchbox', { name: 'Search deleted folders' })).toHaveValue('');
  });

  it('exports the filtered list as CSV', async () => {
    vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(pageOf([deletion()]));
    const exp = vi
      .spyOn(api, 'exportFolderDeletions')
      .mockResolvedValue({ filename: 'deleted-folders.csv' } as Awaited<
        ReturnType<typeof api.exportFolderDeletions>
      >);
    renderPage();
    await screen.findByRole('table', { name: 'Deleted folders' });
    await userEvent.click(screen.getByRole('button', { name: 'Export list' }));
    expect(exp).toHaveBeenLastCalledWith({});
    expect(
      await screen.findByText('Downloaded deleted-folders.csv with every deleted folder.'),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Deleted by'), 'u-pat');
    await screen.findByRole('table', { name: 'Deleted folders' });
    await userEvent.click(screen.getByRole('button', { name: 'Export list' }));
    expect(exp).toHaveBeenLastCalledWith({ actorId: 'u-pat' });
    expect(
      await screen.findByText(
        'Downloaded deleted-folders.csv with the deleted folders matching your filters.',
      ),
    ).toBeInTheDocument();
  });

  it('still lists deletions when the deleted-by choices cannot be read', async () => {
    vi.spyOn(api, 'listFolderDeletionActors').mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'listFolderDeletions').mockResolvedValue(
      pageOf([deletion({ folderName: 'Ok' })]),
    );
    renderPage();
    expect(await screen.findByText('Ok')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Deleted by')).getAllByRole('option')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
