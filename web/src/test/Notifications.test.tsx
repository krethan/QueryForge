import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach } from 'vitest';
import { api } from '../api/client';
import type { Notice, NoticePage } from '../api/types';
import {
  NOTICE_POLL_MS,
  NotificationBell,
  noticeLink,
  noticeText,
  timeAgo,
} from '../components/NotificationBell';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const shared: Notice = {
  id: 'rs:1',
  kind: 'SHARED',
  at: at(5),
  unread: true,
  targetType: 'REPORT',
  target: { id: 'r-1', name: 'Orders' },
  actorName: 'Alice',
  role: 'VIEWER',
};
const folder: Notice = {
  id: 'fs:2',
  kind: 'ROLE_CHANGED',
  at: at(60),
  unread: true,
  targetType: 'FOLDER',
  target: { id: 'f-1', name: 'Month end' },
  actorName: 'Alice',
  role: 'EDITOR',
  oldRole: 'VIEWER',
  principal: { type: 'GROUP', name: 'finance' },
};
const failed: Notice = {
  id: 'df:3',
  kind: 'DELIVERY_FAILED',
  at: at(120),
  unread: false,
  targetType: 'SCHEDULE',
  target: { id: 's-1', name: 'Orders' },
  report: { id: 'r-1', name: 'Orders' },
  error: 'SQL0204 ORDERS in SALESLIB not found',
};
const endedHidden: Notice = {
  id: 'xe:abc',
  kind: 'SHARE_ENDED',
  at: at(3000),
  unread: false,
  targetType: 'REPORT',
  target: null,
  side: 'RECIPIENT',
  expiresAt: at(3000),
};
const endingOwner: Notice = {
  id: 'xs:def',
  kind: 'SHARE_ENDING',
  at: at(10),
  unread: true,
  targetType: 'REPORT',
  target: { id: 'r-2', name: 'Payroll' },
  side: 'OWNER',
  principal: { type: 'USER', name: 'Bob' },
  expiresAt: '2026-11-15T12:00:00.000Z',
};

const page = (items: Notice[], over: Partial<NoticePage> = {}): NoticePage => ({
  items,
  nextCursor: null,
  lastReadAt: null,
  readStateAvailable: true,
  ...over,
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}
const renderBell = () =>
  render(
    <MemoryRouter initialEntries={['/reports']}>
      <NotificationBell />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('notification text and links', () => {
  it('describes each kind and links to the report, folder or schedule', () => {
    expect(noticeText(shared)).toBe('Alice shared the report “Orders” with you as Viewer');
    expect(noticeLink(shared)).toBe('/reports/r-1');
    expect(noticeText(folder)).toBe(
      'Alice changed your access to the folder “Month end” (group finance) to Editor',
    );
    expect(noticeLink(folder)).toBe('/?folder=f-1');
    expect(noticeText(failed)).toBe('A scheduled e-mail of “Orders” failed');
    expect(noticeLink(failed)).toBe('/schedules?history=s-1');
    expect(noticeText(endingOwner)).toMatch(/^Your share of the report “Payroll” with Bob ends /);
  });

  it('names nothing and links nowhere when the share of yours has ended', () => {
    expect(noticeLink(endedHidden)).toBeNull();
    expect(noticeText(endedHidden)).toMatch(/^A report shared with you is no longer shared/);
  });

  it('says how long ago', () => {
    expect(timeAgo(at(0), NOW)).toBe('just now');
    expect(timeAgo(at(5), NOW)).toBe('5 min ago');
    expect(timeAgo(at(180), NOW)).toBe('3 h ago');
    expect(timeAgo(at(60 * 24), NOW)).toBe('yesterday');
    expect(timeAgo(at(60 * 24 * 3), NOW)).toBe('3 days ago');
  });
});

describe('NotificationBell', () => {
  it('shows the unread count on load and polls every minute, but not while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const count = vi
      .spyOn(api, 'notificationCount')
      .mockResolvedValue({ unread: 3, capped: false });
    renderBell();
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeVisible();
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('3');
    expect(count).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(NOTICE_POLL_MS);
    });
    expect(count).toHaveBeenCalledTimes(2);

    hidden = true;
    await act(async () => {
      vi.advanceTimersByTime(NOTICE_POLL_MS * 3);
    });
    expect(count).toHaveBeenCalledTimes(2);

    // back to the tab: refreshed straight away
    hidden = false;
    count.mockResolvedValue({ unread: 99, capped: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(count).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole('button', { name: 'Notifications, 99+ unread' })).toBeVisible();
  });

  it('opens a panel listing notifications with links, and marks all read', async () => {
    vi.spyOn(api, 'notificationCount').mockResolvedValue({ unread: 2, capped: false });
    const list = vi
      .spyOn(api, 'listNotifications')
      .mockResolvedValue(page([shared, folder, failed, endedHidden]));
    const mark = vi
      .spyOn(api, 'markNotificationsRead')
      .mockResolvedValue({ unread: 0, capped: false, lastReadAt: at(0) });
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    const panel = await screen.findByRole('list', { name: 'Notifications' });
    expect(list).toHaveBeenCalledWith(null);
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByRole('link')).toHaveAttribute('href', '/reports/r-1');
    expect(within(items[1]).getByRole('link')).toHaveAttribute('href', '/?folder=f-1');
    expect(within(items[2]).getByRole('link')).toHaveAttribute('href', '/schedules?history=s-1');
    expect(within(items[2]).getByText('SQL0204 ORDERS in SALESLIB not found')).toBeVisible();
    expect(within(items[3]).queryByRole('link')).toBeNull();
    expect(within(panel).getAllByLabelText('Unread')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(mark).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(panel).queryAllByLabelText('Unread')).toHaveLength(0));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeVisible();
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();

    // following a link closes the panel
    await userEvent.click(within(items[0]).getByRole('link'));
    expect(screen.getByTestId('where')).toHaveTextContent('/reports/r-1');
    expect(screen.queryByRole('list', { name: 'Notifications' })).toBeNull();
  });

  it('pages older notifications with the cursor', async () => {
    vi.spyOn(api, 'notificationCount').mockResolvedValue({ unread: 0, capped: false });
    const list = vi
      .spyOn(api, 'listNotifications')
      .mockResolvedValueOnce(page([shared], { nextCursor: 'c1' }))
      .mockResolvedValueOnce(page([failed]));
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    await screen.findByText(/shared the report “Orders”/);
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(list).toHaveBeenLastCalledWith('c1');
    expect(await screen.findByText('A scheduled e-mail of “Orders” failed')).toBeVisible();
    expect(screen.getByText(/shared the report “Orders”/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('explains when marking read is not available yet (migration 016)', async () => {
    vi.spyOn(api, 'notificationCount').mockResolvedValue({ unread: 1, capped: false });
    vi.spyOn(api, 'listNotifications').mockResolvedValue(
      page([shared], { readStateAvailable: false }),
    );
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByText(/needs metadata migration 016/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('shows an empty state and closes on Escape', async () => {
    vi.spyOn(api, 'notificationCount').mockResolvedValue({ unread: 0, capped: false });
    vi.spyOn(api, 'listNotifications').mockResolvedValue(page([]));
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Nothing new in the last 30 days.')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Nothing new in the last 30 days.')).toBeNull();
  });
});
