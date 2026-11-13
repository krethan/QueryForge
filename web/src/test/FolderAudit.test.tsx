import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach } from 'vitest';
import { ApiError, api } from '../api/client';
import type { Folder, FolderAccess, FolderShareAuditEvent } from '../api/types';
import {
  FolderAccessAuditModal,
  describeFolderEvent,
  folderEventRoles,
  folderEventTarget,
  reportSharingLabel,
} from '../components/FolderAccessAuditModal';
import { ManageFoldersModal } from '../components/Folders';
import { FolderShareModal } from '../components/ShareModal';
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
let n = 0;
const ev = (extra: Partial<FolderShareAuditEvent> = {}): FolderShareAuditEvent => ({
  id: `e${++n}`,
  folderId: FIN,
  action: 'GRANT',
  principalType: 'USER',
  principalId: 'u-bob',
  principalName: 'Bob',
  oldRole: null,
  newRole: 'VIEWER',
  actorId: 'u-me',
  actorName: 'Me',
  occurredAt: '2026-11-12T18:30:00Z',
  ...extra,
});
const REPORTS = {
  principalType: 'REPORTS' as const,
  principalId: '*REPORTS',
  principalName: undefined,
};
const access = (extra: Partial<FolderAccess> = {}): FolderAccess => ({
  owner: { id: 'u-me', displayName: 'Me' },
  shares: [
    { type: 'USER', id: 'u-bob', role: 'EDITOR', displayName: 'Bob' },
    { type: 'GROUP', id: 'finance', role: 'VIEWER' },
  ],
  shareReports: 'VIEWER',
  events: [
    ev({ ...REPORTS, action: 'CHANGE', oldRole: 'EDITOR', newRole: 'VIEWER' }),
    ev({
      action: 'REVOKE',
      principalId: 'u-pat',
      principalName: 'Pat',
      oldRole: 'VIEWER',
      newRole: null,
    }),
    ev({ ...REPORTS, action: 'GRANT', oldRole: null, newRole: 'EDITOR' }),
    ev({ action: 'CHANGE', oldRole: 'VIEWER', newRole: 'EDITOR' }),
    ev({ principalType: 'GROUP', principalId: 'finance', principalName: undefined }),
  ],
  hasMore: false,
  ...extra,
});

describe('folder audit wording', () => {
  it('describes report-sharing rows in the share dialog’s words', () => {
    expect(reportSharingLabel(null)).toBe('Off');
    expect(reportSharingLabel('VIEWER')).toBe('View only');
    expect(reportSharingLabel('EDITOR')).toBe('Match folder access');
    const on = ev({ ...REPORTS, newRole: 'VIEWER' });
    expect(describeFolderEvent(on)).toBe(
      'Me turned on sharing the reports in this folder (view only)',
    );
    expect(folderEventTarget(on)).toBe('Reports in this folder');
    expect(folderEventRoles(on)).toEqual({ before: 'Off', after: 'View only' });
    const change = ev({ ...REPORTS, action: 'CHANGE', oldRole: 'VIEWER', newRole: 'EDITOR' });
    expect(describeFolderEvent(change)).toBe(
      'Me changed report sharing from view only to match folder access',
    );
    const off = ev({ ...REPORTS, action: 'REVOKE', oldRole: 'EDITOR', newRole: null });
    expect(describeFolderEvent(off)).toBe('Me turned off sharing the reports in this folder');
    expect(folderEventRoles(off)).toEqual({ before: 'Match folder access', after: 'Off' });
  });

  it('describes user and group rows like the report audit panel', () => {
    expect(describeFolderEvent(ev())).toBe('Me granted Viewer access to Bob');
    expect(folderEventRoles(ev())).toEqual({ before: 'No access', after: 'Viewer' });
    const g = ev({
      principalType: 'GROUP',
      principalId: 'sales',
      principalName: undefined,
      action: 'REVOKE',
      oldRole: 'EDITOR',
      newRole: null,
    });
    expect(describeFolderEvent(g)).toBe('Me revoked Editor access from group sales');
    expect(folderEventTarget(g)).toBe('Group sales');
    // a removed user or actor falls back to the id
    const gone = ev({
      principalName: undefined,
      actorName: undefined,
      action: 'CHANGE',
      oldRole: 'VIEWER',
      newRole: 'EDITOR',
    });
    expect(describeFolderEvent(gone)).toBe('u-me changed u-bob from Viewer to Editor');
  });
});

describe('Folder Access and audit panel', () => {
  it('shows current access, the report-sharing option and the history with before and after', async () => {
    const get = vi.spyOn(api, 'getFolderAccess').mockResolvedValue(access());
    render(<FolderAccessAuditModal folder={folder()} onClose={() => {}} />);
    expect(screen.getByText('Access and audit · Finance')).toBeInTheDocument();
    const current = await screen.findByRole('list', { name: 'Current access' });
    expect(get).toHaveBeenCalledWith(FIN);
    expect(within(current).getByText('Owner')).toBeInTheDocument();
    expect(within(current).getByText(/^Bob/)).toBeInTheDocument();
    expect(within(current).getByText(/Group finance/)).toBeInTheDocument();
    expect(screen.getByText('Shared · View only')).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Sharing history' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('Changed');
    expect(items[0]).toHaveTextContent(
      'Me changed report sharing from match folder access to view only',
    );
    expect(items[0]).toHaveTextContent('Reports in this folder: Match folder access → View only');
    expect(items[1]).toHaveTextContent('Revoked');
    expect(items[1]).toHaveTextContent('Pat: Viewer → No access');
    expect(items[2]).toHaveTextContent('Turned on');
    expect(items[2]).toHaveTextContent('Reports in this folder: Off → Match folder access');
    expect(items[3]).toHaveTextContent('Bob: Viewer → Editor');
    expect(items[4]).toHaveTextContent('Granted');
    expect(items[4]).toHaveTextContent('Group finance: No access → Viewer');
    const time = items[0].querySelector('time')!;
    expect(time).toHaveAttribute('dateTime', '2026-11-12T18:30:00Z');
    expect(time.textContent).not.toBe('');
    expect(screen.queryByRole('button', { name: 'Show older changes' })).not.toBeInTheDocument();
  });

  it('says so when the folder is not shared and nothing was recorded', async () => {
    vi.spyOn(api, 'getFolderAccess').mockResolvedValue(
      access({ shares: [], shareReports: null, events: [] }),
    );
    render(<FolderAccessAuditModal folder={folder({ shared: false })} onClose={() => {}} />);
    expect(await screen.findByText('Not shared with anyone.')).toBeInTheDocument();
    expect(screen.getByText(/not shared through the folder/)).toBeInTheDocument();
    expect(screen.getByText('No sharing changes recorded.')).toBeInTheDocument();
  });

  it('loads older changes a page at a time and skips repeats', async () => {
    const first = access({ events: [ev({ id: 'a' }), ev({ id: 'b' })], hasMore: true });
    vi.spyOn(api, 'getFolderAccess').mockResolvedValue(first);
    const more = vi
      .spyOn(api, 'getFolderAudit')
      .mockResolvedValueOnce({
        // 'b' again: a change recorded while the panel was open shifted the page
        events: [ev({ id: 'b' }), ev({ id: 'c', principalName: 'Cy' })],
        hasMore: true,
        limit: 25,
        offset: 2,
      })
      .mockResolvedValueOnce({
        events: [ev({ id: 'd', principalName: 'Di' })],
        hasMore: false,
        limit: 25,
        offset: 3,
      });
    render(<FolderAccessAuditModal folder={folder()} onClose={() => {}} />);
    const history = await screen.findByRole('list', { name: 'Sharing history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(3));
    expect(more).toHaveBeenLastCalledWith(FIN, 2);
    expect(within(history).getByText(/granted Viewer access to Cy/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(4));
    expect(more).toHaveBeenLastCalledWith(FIN, 3);
    expect(screen.queryByRole('button', { name: 'Show older changes' })).not.toBeInTheDocument();
  });

  it('keeps what it has and shows the error when an older page fails', async () => {
    vi.spyOn(api, 'getFolderAccess').mockResolvedValue(
      access({ events: [ev({ id: 'a' })], hasMore: true }),
    );
    vi.spyOn(api, 'getFolderAudit').mockRejectedValue(new Error('Network down'));
    render(<FolderAccessAuditModal folder={folder()} onClose={() => {}} />);
    const history = await screen.findByRole('list', { name: 'Sharing history' });
    await userEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
    expect(await screen.findByText(/Network down/)).toBeInTheDocument();
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show older changes' })).toBeEnabled();
  });

  it('shows the server’s refusal instead of any access data', async () => {
    vi.spyOn(api, 'getFolderAccess').mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', 'Only the folder owner or an admin can view access audit.'),
    );
    render(<FolderAccessAuditModal folder={folder({ access: 'EDITOR' })} onClose={() => {}} />);
    expect(
      await screen.findByText(/Only the folder owner or an admin can view access audit/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Current access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Sharing history' })).not.toBeInTheDocument();
  });
});

describe('reaching the panel', () => {
  const manage = (folders: Folder[], onAudit = vi.fn()) => {
    render(
      <ManageFoldersModal
        open
        folders={folders}
        counts={new Map()}
        onClose={() => {}}
        onChanged={() => {}}
        onShare={() => {}}
        onAudit={onAudit}
      />,
    );
    return { onAudit, dialog: screen.getByRole('dialog', { name: 'Manage folders' }) };
  };

  it('Manage folders offers it for your folders, shared or not', async () => {
    const own = folder();
    const priv = folder({ id: 'f2', name: 'Private', shared: false });
    const { onAudit, dialog } = manage([own, priv]);
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Access and audit for Finance' }),
    );
    expect(onAudit).toHaveBeenCalledWith(own);
    expect(
      within(dialog).getByRole('button', { name: 'Access and audit for Private' }),
    ).toBeInTheDocument();
  });

  it('offers it to admins for folders shared with anyone, never to viewers or editors', () => {
    const { dialog } = manage([
      folder({
        id: 'f3',
        name: 'Sales Team',
        ownerId: 'u-pat',
        ownerName: 'Pat',
        access: 'VIEWER',
      }),
      folder({ id: 'f4', name: 'Ops', ownerId: 'u-pat', ownerName: 'Pat', access: 'EDITOR' }),
      folder({ id: 'f5', name: 'HR', ownerId: 'u-sam', ownerName: 'Sam', access: 'ADMIN' }),
    ]);
    const others = within(dialog).getByRole('list', { name: 'Folders shared with you' });
    expect(
      within(others).queryByRole('button', { name: 'Access and audit for Sales Team' }),
    ).not.toBeInTheDocument();
    expect(
      within(others).queryByRole('button', { name: 'Access and audit for Ops' }),
    ).not.toBeInTheDocument();
    expect(
      within(others).getByRole('button', { name: 'Access and audit for HR' }),
    ).toBeInTheDocument();
  });

  it('is not offered when the page does not wire it up', () => {
    render(
      <ManageFoldersModal
        open
        folders={[folder()]}
        counts={new Map()}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Access and audit/ })).not.toBeInTheDocument();
  });

  it('the folder Share dialog links to it', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue({
      shares: [],
      shareReports: null,
      reports: { included: [], skipped: [] },
    });
    const onAudit = vi.fn();
    const f = folder();
    render(<FolderShareModal folder={f} onClose={() => {}} onAudit={onAudit} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'View access and audit history' }),
    );
    expect(onAudit).toHaveBeenCalledWith(f);
  });

  it('opens from the dashboard’s Manage folders and the Share dialog, and returns to Manage folders', async () => {
    vi.spyOn(api, 'listAllReports').mockResolvedValue({ owned: [], shared: [] });
    vi.spyOn(api, 'listFolders').mockResolvedValue([folder()]);
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue({
      shares: [],
      shareReports: null,
      reports: { included: [], skipped: [] },
    });
    const get = vi.spyOn(api, 'getFolderAccess').mockResolvedValue(access());
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Manage folders' }));
    let dialog = await screen.findByRole('dialog', { name: 'Manage folders' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Access and audit for Finance' }));
    expect(await screen.findByRole('list', { name: 'Sharing history' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(FIN);
    const panel = screen.getByText('Access and audit · Finance').closest('.cds--modal');
    fireEvent.click(within(panel as HTMLElement).getByRole('button', { name: /close/i }));
    dialog = await screen.findByRole('dialog', { name: 'Manage folders' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share Finance' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View access and audit history' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Access and audit · Finance')).toBeInTheDocument();
  });
});
