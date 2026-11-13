import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { api } from '../api/client';
import type { Folder, FolderSharing, Report } from '../api/types';
import { AccessAuditModal } from '../components/AccessAuditModal';
import { ManageFoldersModal } from '../components/Folders';
import { FolderShareModal, ShareModal } from '../components/ShareModal';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage';

afterEach(() => vi.restoreAllMocks());

const FIN = 'f0000000-0000-4000-8000-000000000001';
const folder = (extra: Partial<Folder> = {}): Folder => ({
  id: FIN,
  name: 'Finance',
  createdAt: null,
  updatedAt: null,
  ownerId: 'u-me',
  ownerName: 'Me',
  access: 'OWNER',
  shared: true,
  reportIds: [],
  ...extra,
});
const rep = (extra: Partial<Report> = {}): Report => ({
  id: 'r1',
  name: 'Alpha',
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
  ...extra,
});
const sharing = (extra: Partial<FolderSharing> = {}): FolderSharing => ({
  shares: [{ type: 'USER', id: 'u-bob', role: 'EDITOR', displayName: 'Bob' }],
  shareReports: null,
  reports: {
    included: [
      { id: 'r1', name: 'Alpha' },
      { id: 'r2', name: 'Beta' },
    ],
    skipped: [
      { id: 'r3', name: 'Carol data', ownerName: 'Carol', reason: 'NOT_OWNER' },
      { id: 'r4', name: 'Pinned by Bob', ownerName: 'Me', reason: 'ADDED_BY_OTHER' },
    ],
  },
  ...extra,
});
const toggle = () => screen.getByRole('switch', { name: /Also share the reports in this folder/ });

describe('Folder share dialog: sharing the reports in the folder', () => {
  it('is off by default and saves the folder shares with the option still off', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue(sharing());
    const put = vi.spyOn(api, 'putFolderSharing').mockResolvedValue(sharing());
    const onClose = vi.fn();
    render(<FolderShareModal folder={folder()} onClose={onClose} />);
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByText(/Sharing a folder does not share the reports in it/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText(/won't be shared/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        FIN,
        [expect.objectContaining({ type: 'USER', id: 'u-bob', role: 'EDITOR' })],
        null,
      ),
    );
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('turning it on defaults to view only, lists what is shared and what is skipped, and saves the choice', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue(sharing());
    const put = vi.spyOn(api, 'putFolderSharing').mockResolvedValue(sharing());
    render(<FolderShareModal folder={folder()} onClose={() => {}} />);
    await screen.findByText('Bob');
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('View only, for everyone')).toBeChecked();
    expect(
      screen.getByText(/The reports listed below are shared with them too/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 of your reports in this folder will be shared with the people above/),
    ).toBeInTheDocument();
    expect(screen.getByText("2 reports won't be shared")).toBeInTheDocument();
    const skipped = screen.getByRole('list', { name: 'Reports not shared through this folder' });
    expect(
      within(skipped).getByText(/Carol data \(owned by Carol\): only its owner can share it/),
    ).toBeInTheDocument();
    expect(
      within(skipped).getByText(
        /Pinned by Bob: added by someone else; add it to the folder yourself/,
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Match their folder access/));
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(FIN, expect.any(Array), 'EDITOR'));
  });

  it('shows the saved option and can turn it off', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue(
      sharing({ shareReports: 'EDITOR', reports: { included: [], skipped: [] } }),
    );
    const put = vi.spyOn(api, 'putFolderSharing').mockResolvedValue(sharing());
    render(<FolderShareModal folder={folder()} onClose={() => {}} />);
    await screen.findByText('Bob');
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/Match their folder access/)).toBeChecked();
    expect(screen.getByText(/None of your reports are in this folder yet/)).toBeInTheDocument();
    await userEvent.click(toggle());
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(FIN, expect.any(Array), null));
  });

  it('shows the server’s refusal and stays open', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue(sharing());
    vi.spyOn(api, 'putFolderSharing').mockRejectedValue(
      new Error('Only the folder owner can do this.'),
    );
    const onClose = vi.fn();
    render(<FolderShareModal folder={folder()} onClose={onClose} />);
    await screen.findByText('Bob');
    await userEvent.click(toggle());
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    expect(await screen.findByText(/Only the folder owner can do this/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Report sharing: access through folders', () => {
  it('lists folder access read-only in the report share dialog and saves only report shares', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getReportSharing').mockResolvedValue({
      shares: [],
      folderGrants: [
        {
          folderId: FIN,
          folderName: 'Finance',
          type: 'USER',
          id: 'u-bob',
          role: 'EDITOR',
          displayName: 'Bob',
        },
        { folderId: FIN, folderName: 'Finance', type: 'GROUP', id: 'ops', role: 'VIEWER' },
      ],
    });
    const save = vi.spyOn(api, 'putShares').mockResolvedValue([]);
    render(<ShareModal report={rep()} onClose={() => {}} />);
    const list = await screen.findByRole('table', { name: 'Access through folders' });
    expect(within(list).getByText('Bob')).toBeInTheDocument();
    expect(within(list).getByText('Group: ops')).toBeInTheDocument();
    expect(within(list).getAllByText('Finance')).toHaveLength(2);
    expect(screen.getByText('Not shared with anyone yet.')).toBeInTheDocument();
    // folder access has no role pickers or remove buttons
    expect(screen.queryByRole('button', { name: 'Remove access' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    expect(save).toHaveBeenCalledWith('r1', []);
  });

  it('shows folder access in the access and audit panel', async () => {
    vi.spyOn(api, 'getAccess').mockResolvedValue({
      owner: { id: 'u-me', displayName: 'Me' },
      shares: [],
      folderGrants: [
        {
          folderId: FIN,
          folderName: 'Finance',
          type: 'USER',
          id: 'u-bob',
          role: 'VIEWER',
          displayName: 'Bob',
        },
      ],
      events: [],
    });
    render(<AccessAuditModal report={rep()} onClose={() => {}} />);
    const list = await screen.findByRole('list', { name: 'Current access' });
    expect(within(list).getByText(/through folder Finance/)).toBeInTheDocument();
    expect(within(list).queryByText('Not shared with anyone.')).not.toBeInTheDocument();
  });
});

describe('Manage folders: folders that share their reports', () => {
  it('tags your folders and folders shared with you that share their reports', () => {
    render(
      <ManageFoldersModal
        open
        folders={[
          folder({ shareReports: 'VIEWER' }),
          folder({ id: 'f2', name: 'Private', shared: false, shareReports: null }),
          folder({
            id: 'f3',
            name: 'Sales Team',
            ownerId: 'u-pat',
            ownerName: 'Pat',
            access: 'VIEWER',
            shareReports: 'EDITOR',
          }),
        ]}
        counts={new Map()}
        onClose={() => {}}
        onChanged={() => {}}
        onShare={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Manage folders' });
    expect(within(dialog).getAllByText('Reports shared')).toHaveLength(2);
    const others = within(dialog).getByRole('list', { name: 'Folders shared with you' });
    expect(within(others).getByText('Reports shared')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/unless you turn that on when you share it/),
    ).toBeInTheDocument();
  });
});

describe('Dashboard: reports shared through a folder', () => {
  it('says when a shared report comes through a folder', async () => {
    vi.spyOn(api, 'listAllReports').mockResolvedValue({
      owned: [],
      shared: [
        rep({ id: 'r1', name: 'Alpha', access: 'VIEWER', ownerName: 'Pat', viaFolder: true }),
        rep({ id: 'r2', name: 'Beta', access: 'EDITOR', ownerName: 'Pat' }),
      ],
    });
    vi.spyOn(api, 'listFolders').mockResolvedValue([]);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Shared by Pat through a folder/)).toBeInTheDocument();
    expect(screen.getAllByText(/Shared by Pat/)).toHaveLength(2);
  });
});
