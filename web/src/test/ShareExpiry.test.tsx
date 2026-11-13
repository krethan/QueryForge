import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { api } from '../api/client';
import type { Folder, FolderAccess, Report, ReportAccess, Share } from '../api/types';
import { AccessAuditModal } from '../components/AccessAuditModal';
import { FolderAccessAuditModal } from '../components/FolderAccessAuditModal';
import { FolderShareModal, ShareModal } from '../components/ShareModal';
import {
  endOfDayIso,
  formatLastDay,
  isExpired,
  lastDayOf,
  localDate,
  todayLocal,
} from '../utils/expiry';

afterEach(() => vi.restoreAllMocks());
// jsdom has no scrollIntoView; Carbon's ComboBox calls it on the highlighted option.
Element.prototype.scrollIntoView ??= () => undefined;

const DAY = 86_400_000;
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
/** A day N days from today (local), and the expiry instant the dialog stores for it. */
const dayFromNow = (n: number) => localDate(new Date(Date.now() + n * DAY));
const past = new Date(Date.now() - 2 * DAY).toISOString();
const future = endOfDayIso(dayFromNow(10))!;
const bob = (expiresAt: string | null, expired = false): Share => ({
  type: 'USER',
  id: 'u-bob',
  role: 'VIEWER',
  displayName: 'Bob',
  expiresAt,
  expired,
});

describe('share end dates in the browser', () => {
  it('ends access at the start of the day after the chosen one, in local time', () => {
    expect(endOfDayIso('2026-11-20')).toBe(new Date(2026, 10, 21, 0, 0, 0, 0).toISOString());
    expect(lastDayOf(endOfDayIso('2026-11-20'))).toBe('2026-11-20');
    // month and year ends roll over
    expect(lastDayOf(endOfDayIso('2026-12-31'))).toBe('2026-12-31');
    expect(endOfDayIso('2026-12-31')).toBe(new Date(2027, 0, 1).toISOString());
    expect(endOfDayIso('not a day')).toBeNull();
    expect(lastDayOf(null)).toBe('');
  });
  it('is expired from the exact expiry instant on', () => {
    const t = Date.parse('2026-11-14T06:00:00.000Z');
    expect(isExpired('2026-11-14T06:00:00.000Z', t - 1)).toBe(false);
    expect(isExpired('2026-11-14T06:00:00.000Z', t)).toBe(true);
    expect(isExpired(null, t)).toBe(false);
  });
  it('sends each share with its end date (null for none) and no display fields', async () => {
    document.cookie = 'qf_csrf=tok';
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ shares: [] }), { status: 200 }));
    await api.putShares('r1', [
      bob(future),
      { type: 'GROUP', id: 'finance', role: 'EDITOR', displayName: 'Group: finance' },
    ]);
    expect(JSON.parse(String(f.mock.calls[0][1]!.body))).toEqual({
      shares: [
        { type: 'USER', id: 'u-bob', role: 'VIEWER', expiresAt: future },
        { type: 'GROUP', id: 'finance', role: 'EDITOR', expiresAt: null },
      ],
    });
  });
});

describe('Share dialog end dates', () => {
  it('marks an expired share, lets it be saved unchanged, renewed or cleared', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getReportSharing').mockResolvedValue({
      shares: [bob(past, true)],
      folderGrants: [],
    });
    const put = vi.spyOn(api, 'putShares').mockResolvedValue([]);
    const onClose = vi.fn();
    render(<ShareModal report={rep} onClose={onClose} />);
    const row = (await screen.findByText('Bob')).closest(
      '.cds--structured-list-row',
    ) as HTMLElement;
    expect(within(row).getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('1 share has expired')).toBeInTheDocument();
    const date = within(row).getByLabelText('Access until, Bob') as HTMLInputElement;
    expect(date.value).toBe(lastDayOf(past));
    // unchanged: nothing to fix, saving keeps the stored expiry
    const save = screen.getByRole('button', { name: 'Save sharing' });
    expect(save).toBeEnabled();
    // renew: a later day clears the Expired state
    fireEvent.change(date, { target: { value: dayFromNow(10) } });
    expect(within(row).queryByText('Expired')).not.toBeInTheDocument();
    expect(screen.queryByText(/has expired/)).not.toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        'r1',
        [expect.objectContaining({ expiresAt: future })],
        true,
      ),
    );
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('refuses a changed end date that has already passed', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue([]);
    vi.spyOn(api, 'getReportSharing').mockResolvedValue({
      shares: [bob(future)],
      folderGrants: [],
    });
    const put = vi.spyOn(api, 'putShares').mockResolvedValue([]);
    render(<ShareModal report={rep} onClose={() => undefined} />);
    const date = (await screen.findByLabelText('Access until, Bob')) as HTMLInputElement;
    expect(date.value).toBe(dayFromNow(10));
    fireEvent.change(date, { target: { value: dayFromNow(-3) } });
    expect(screen.getByText('Pick today or a later day.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save sharing' })).toBeDisabled();
    // "No end date" clears it and the dialog can be saved again
    await userEvent.click(screen.getByRole('button', { name: 'No end date' }));
    expect(date.value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('r1', [expect.objectContaining({ expiresAt: null })], true),
    );
  });

  it('adds a folder share with an end date (end of that day, local time)', async () => {
    vi.spyOn(api, 'groups').mockResolvedValue(['finance']);
    vi.spyOn(api, 'getFolderSharing').mockResolvedValue({
      shares: [],
      shareReports: null,
      reports: { included: [], skipped: [] },
    });
    const put = vi.spyOn(api, 'putFolderSharing').mockResolvedValue({
      shares: [],
      shareReports: null,
      reports: { included: [], skipped: [] },
    });
    render(<FolderShareModal folder={folder} onClose={() => undefined} />);
    expect(await screen.findByText('Not shared with anyone yet.')).toBeInTheDocument();
    expect(screen.getByText(/works until the end of that day/)).toBeInTheDocument();
    const until = screen.getByLabelText('Until (optional)') as HTMLInputElement;
    expect(until.min).toBe(todayLocal());
    fireEvent.change(until, { target: { value: dayFromNow(-1) } });
    expect(screen.getByText('Pick today or a later day.')).toBeInTheDocument();
    fireEvent.change(until, { target: { value: dayFromNow(7) } });
    await userEvent.type(screen.getByRole('combobox', { name: /Add a user or group/ }), 'fin');
    await userEvent.click(await screen.findByText('Group: finance'));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((screen.getByLabelText('Access until, group finance') as HTMLInputElement).value).toBe(
      dayFromNow(7),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save sharing' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        'f1',
        [
          expect.objectContaining({
            type: 'GROUP',
            id: 'finance',
            expiresAt: endOfDayIso(dayFromNow(7)),
          }),
        ],
        null,
        true,
      ),
    );
  });
});

describe('Access and audit panels show end dates', () => {
  it('report panel: Expired / until in current access, End date events in the history', async () => {
    const data: ReportAccess = {
      owner: { id: 'u-me', displayName: 'Me' },
      shares: [
        bob(past, true),
        { type: 'GROUP', id: 'finance', role: 'EDITOR', expiresAt: future, expired: false },
      ],
      events: [
        {
          id: 'e3',
          reportId: 'r1',
          action: 'EXPIRY',
          principalType: 'USER',
          principalId: 'u-bob',
          principalName: 'Bob',
          oldRole: 'VIEWER',
          newRole: 'VIEWER',
          oldExpiresAt: future,
          newExpiresAt: null,
          actorId: 'u-me',
          actorName: 'Me',
          occurredAt: '2026-11-13T12:00:00Z',
        },
        {
          id: 'e2',
          reportId: 'r1',
          action: 'EXPIRY',
          principalType: 'USER',
          principalId: 'u-bob',
          principalName: 'Bob',
          oldRole: 'VIEWER',
          newRole: 'VIEWER',
          oldExpiresAt: past,
          newExpiresAt: future,
          actorId: 'u-me',
          actorName: 'Me',
          occurredAt: '2026-11-13T11:00:00Z',
        },
        {
          id: 'e1',
          reportId: 'r1',
          action: 'GRANT',
          principalType: 'USER',
          principalId: 'u-bob',
          principalName: 'Bob',
          oldRole: null,
          newRole: 'VIEWER',
          oldExpiresAt: null,
          newExpiresAt: past,
          actorId: 'u-me',
          actorName: 'Me',
          occurredAt: '2026-11-10T11:00:00Z',
        },
      ],
    };
    vi.spyOn(api, 'getAccess').mockResolvedValue(data);
    render(<AccessAuditModal report={rep} onClose={() => undefined} />);
    const current = await screen.findByRole('list', { name: 'Current access' });
    expect(within(current).getByText('Expired')).toBeInTheDocument();
    expect(within(current).getByText(`until ${formatLastDay(future)}`)).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Sharing history' });
    expect(within(history).getAllByText('End date')).toHaveLength(2);
    expect(
      within(history).getByText(/Me removed the end date from Bob's access/),
    ).toBeInTheDocument();
    expect(
      within(history).getByText(
        `Me changed Bob's access to end after ${formatLastDay(future)} (was ${formatLastDay(past)})`,
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(
      within(history).getByText(`Me granted Viewer access to Bob until ${formatLastDay(past)}`, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it('folder panel: before / after end dates on an End date event', async () => {
    const data: FolderAccess = {
      owner: { id: 'u-me', displayName: 'Me' },
      shares: [bob(future)],
      shareReports: null,
      hasMore: false,
      events: [
        {
          id: 'e1',
          folderId: 'f1',
          action: 'EXPIRY',
          principalType: 'USER',
          principalId: 'u-bob',
          principalName: 'Bob',
          oldRole: 'VIEWER',
          newRole: 'VIEWER',
          oldExpiresAt: null,
          newExpiresAt: future,
          actorId: 'u-me',
          actorName: 'Me',
          occurredAt: '2026-11-13T12:00:00Z',
        },
      ],
    };
    vi.spyOn(api, 'getFolderAccess').mockResolvedValue(data);
    render(<FolderAccessAuditModal folder={folder} onClose={() => undefined} />);
    const history = await screen.findByRole('list', { name: 'Sharing history' });
    expect(within(history).getByText('End date')).toBeInTheDocument();
    expect(
      within(history).getByText(`Me set Bob's access to end after ${formatLastDay(future)}`, {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      within(history).getByText(`Bob: No end date → until ${formatLastDay(future)}`),
    ).toBeInTheDocument();
    const current = screen.getByRole('list', { name: 'Current access' });
    expect(within(current).getByText(`until ${formatLastDay(future)}`)).toBeInTheDocument();
  });
});
