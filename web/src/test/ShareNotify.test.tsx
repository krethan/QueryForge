import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { api } from '../api/client';
import type { Folder, Report, Share } from '../api/types';
import { FolderShareModal, ShareModal } from '../components/ShareModal';
import { ShareEmailSetting } from '../pages/AccountPage';

afterEach(() => vi.restoreAllMocks());
Element.prototype.scrollIntoView ??= () => undefined;

const rep: Report = {
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
};
const folder: Folder = {
  id: 'f1',
  name: 'Finance',
  createdAt: null,
  updatedAt: null,
  ownerId: 'u-me',
  ownerName: 'Me',
  access: 'OWNER',
  shared: true,
  reportIds: [],
};
const bob: Share = {
  type: 'USER',
  id: 'u-bob',
  role: 'VIEWER',
  displayName: 'Bob',
  expiresAt: null,
};

describe('"Notify people" in the Share dialog', () => {
  it('is on by default and asks the server to e-mail', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getReportSharing').mockResolvedValue({
      shares: [bob],
      folderGrants: [],
      mailConfigured: true,
    });
    const put = vi.spyOn(api, 'putShares').mockResolvedValue([]);
    render(<ShareModal report={rep} onClose={() => {}} />);
    const box = await screen.findByLabelText('Notify people by e-mail');
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    await screen.findByText('Bob');
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('r1', [expect.objectContaining({ id: 'u-bob' })], true),
    );
  });

  it('can be turned off for one save', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getReportSharing').mockResolvedValue({
      shares: [bob],
      folderGrants: [],
      mailConfigured: true,
    });
    const put = vi.spyOn(api, 'putShares').mockResolvedValue([]);
    render(<ShareModal report={rep} onClose={() => {}} />);
    await screen.findByText('Bob');
    await userEvent.click(screen.getByLabelText('Notify people by e-mail'));
    expect(screen.getByLabelText('Notify people by e-mail')).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('r1', expect.any(Array), false));
  });

  it('says e-mail is not set up, disables the option and still saves the shares', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getReportSharing').mockResolvedValue({
      shares: [bob],
      folderGrants: [],
      mailConfigured: false,
    });
    const put = vi.spyOn(api, 'putShares').mockResolvedValue([]);
    const onClose = vi.fn();
    render(<ShareModal report={rep} onClose={onClose} />);
    await screen.findByText('Bob');
    const box = screen.getByLabelText('Notify people by e-mail');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(
      screen.getByText(/E-mail isn't set up on this server, so nobody will be notified/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('r1', expect.any(Array), false));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('passes the choice with a folder share too', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue({
      shares: [bob],
      shareReports: null,
      reports: { included: [], skipped: [] },
      mailConfigured: true,
    });
    const put = vi.spyOn(api, 'putFolderSharing').mockResolvedValue({
      shares: [],
      shareReports: null,
      reports: { included: [], skipped: [] },
    });
    render(<FolderShareModal folder={folder} onClose={() => {}} />);
    await screen.findByText('Bob');
    expect(screen.getByLabelText('Notify people by e-mail')).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('f1', expect.any(Array), null, true));
  });

  it('sends notify in the request body only when given', async () => {
    document.cookie = 'qf_csrf=tok';
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ shares: [] }), { status: 200 }),
      );
    await api.putShares('r1', [bob], true);
    expect(JSON.parse(String(f.mock.calls[0][1]!.body))).toEqual({
      shares: [{ type: 'USER', id: 'u-bob', role: 'VIEWER', expiresAt: null }],
      notify: true,
    });
    await api.putFolderSharing('f1', [], 'VIEWER', false);
    expect(JSON.parse(String(f.mock.calls[1][1]!.body))).toEqual({
      shares: [],
      shareReports: 'VIEWER',
      notify: false,
    });
  });
});

describe('Account: e-mail me about shares', () => {
  it('shows the setting and saves a change', async () => {
    vi.spyOn(api, 'getAccountSettings').mockResolvedValue({
      settings: { shareEmails: true },
      hasEmail: true,
      mailConfigured: true,
    });
    const put = vi.spyOn(api, 'putAccountSettings').mockResolvedValue({
      settings: { shareEmails: false },
      hasEmail: true,
      mailConfigured: true,
    });
    render(<ShareEmailSetting />);
    const toggle = await screen.findByRole('switch', { name: /E-mail me about shares/ });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(put).toHaveBeenCalledWith({ shareEmails: false }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /E-mail me about shares/ })).not.toBeChecked(),
    );
  });

  it('explains when the server cannot send e-mail', async () => {
    vi.spyOn(api, 'getAccountSettings').mockResolvedValue({
      settings: { shareEmails: true },
      hasEmail: true,
      mailConfigured: false,
    });
    render(<ShareEmailSetting />);
    expect(await screen.findByText("E-mail isn't set up on this server")).toBeInTheDocument();
  });
});
