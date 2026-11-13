import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach } from 'vitest';
import { ApiError, api } from '../api/client';
import type { FolderDeletion, FolderDeletionPage, FolderShareAuditEvent } from '../api/types';
import { AppShell, navFor, pageTitle } from '../components/AppShell';
import { DeletedFoldersPage } from '../pages/DeletedFoldersPage';
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
): FolderDeletionPage => ({ deletions, hasMore: false, limit: 25, offset: 0, ...extra });
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
    expect(list).toHaveBeenCalledWith(0, 25);
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

  it('pages with limit / offset and disables Next on the last page', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => deletion({ folderName: `P1-${i}` }));
    const list = vi
      .spyOn(api, 'listFolderDeletions')
      .mockResolvedValueOnce(pageOf(page1, { hasMore: true }))
      .mockResolvedValueOnce(pageOf([deletion({ folderName: 'Oldest' })], { offset: 25 }))
      .mockResolvedValueOnce(pageOf(page1, { hasMore: true }));
    renderPage();
    await screen.findByText('P1-0');
    expect(screen.getByText('1–25 deleted folders')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(next);
    expect(await screen.findByText('Oldest')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(25, 25);
    expect(screen.getByText('26–26 deleted folders')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('P1-0')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(0, 25);
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
