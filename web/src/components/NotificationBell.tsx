import { Button, HeaderGlobalAction, HeaderPanel, InlineLoading } from '@carbon/react';
import { Notification } from '@carbon/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Notice, NoticeCount } from '../api/types';
import { ErrorNotice } from './ErrorNotice';

/** How often the unread count is refreshed while the tab is visible. */
export const NOTICE_POLL_MS = 60_000;

const roleName = (r?: string) => (r === 'EDITOR' ? 'Editor' : 'Viewer');
const what = (n: Notice) =>
  n.targetType === 'FOLDER' ? 'folder' : n.targetType === 'SCHEDULE' ? 'schedule' : 'report';
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) {
    const d = Math.floor(s / 86_400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return day(iso);
}

/** Where a notification leads, or null when it names nothing the user may open. */
export function noticeLink(n: Notice): string | null {
  if (!n.target) return null;
  const id = encodeURIComponent(n.target.id);
  if (n.targetType === 'REPORT') return `/reports/${id}`;
  if (n.targetType === 'FOLDER') return `/?folder=${id}`;
  return `/schedules?history=${id}`;
}

/** One line describing the notification. */
export function noticeText(n: Notice): string {
  const name = n.target ? `the ${what(n)} “${n.target.name}”` : `a ${what(n)}`;
  const viaGroup = n.principal?.type === 'GROUP' ? ` (group ${n.principal.name})` : '';
  switch (n.kind) {
    case 'SHARED':
      return `${n.actorName ?? 'Someone'} shared ${name} with you${viaGroup} as ${roleName(n.role)}`;
    case 'ROLE_CHANGED':
      return `${n.actorName ?? 'Someone'} changed your access to ${name}${viaGroup} to ${roleName(n.role)}`;
    case 'SHARE_ENDING':
      return n.side === 'OWNER'
        ? `Your share of ${name} with ${n.principal?.name ?? 'someone'} ends ${day(n.expiresAt)}`
        : `Your access to ${name}${viaGroup} ends ${day(n.expiresAt)}`;
    case 'SHARE_ENDED':
      return n.side === 'OWNER'
        ? `Your share of ${name} with ${n.principal?.name ?? 'someone'} ended ${day(n.expiresAt)}`
        : n.target
          ? `Your access to ${name}${viaGroup} ended ${day(n.expiresAt)}`
          : `A ${what(n)} shared with you is no longer shared with you (ended ${day(n.expiresAt)})`;
    case 'DELIVERY_FAILED':
      return `A scheduled e-mail of “${n.report?.name ?? n.target?.name ?? 'a report'}” failed`;
  }
}

const countLabel = (c: NoticeCount | null) =>
  !c || c.unread === 0 ? '' : c.capped ? `${c.unread}+` : String(c.unread);

/**
 * The bell in the header: unread count (fetched on load and every minute while the tab is
 * visible) and a panel listing recent notifications with "Mark all read".
 */
export function NotificationBell() {
  const [count, setCount] = useState<NoticeCount | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [readable, setReadable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refreshCount = useCallback(async () => {
    try {
      setCount(await api.notificationCount());
    } catch {
      /* the bell stays as it was; the next poll tries again */
    }
  }, []);

  useEffect(() => {
    const poll = () => {
      if (!document.hidden) void refreshCount();
    };
    poll();
    const timer = window.setInterval(poll, NOTICE_POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refreshCount]);

  const load = useCallback(
    async (more: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const page = await api.listNotifications(more ? cursor : null);
        setItems((cur) => (more && cur ? [...cur, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setReadable(page.readStateAvailable);
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [cursor],
  );

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void load(false);
      void refreshCount();
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const markAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.markNotificationsRead();
      setCount({ unread: c.unread, capped: c.capped });
      setItems((cur) => cur?.map((n) => ({ ...n, unread: false })) ?? cur);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const badge = countLabel(count);
  const anyUnread = (count?.unread ?? 0) > 0 || Boolean(items?.some((n) => n.unread));
  return (
    <>
      <HeaderGlobalAction
        aria-label={badge ? `Notifications, ${badge} unread` : 'Notifications'}
        aria-expanded={open}
        isActive={open}
        tooltipAlignment="end"
        onClick={toggle}
      >
        <span className="qf-bell">
          <Notification size={20} />
          {badge && (
            <span className="qf-bell__badge" data-testid="notification-badge" aria-hidden="true">
              {badge}
            </span>
          )}
        </span>
      </HeaderGlobalAction>
      <HeaderPanel expanded={open} aria-label="Notifications" className="qf-notices">
        {open && (
          <div className="qf-notices__body">
            <div className="qf-notices__head">
              <h2>Notifications</h2>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy || !anyUnread || !readable}
                onClick={markAll}
              >
                Mark all read
              </Button>
            </div>
            {!readable && (
              <p className="qf-notices__hint">
                Marking read needs metadata migration 016. Ask an administrator to run it.
              </p>
            )}
            <ErrorNotice error={error} onClose={() => setError(null)} />
            {items === null ? (
              <InlineLoading description="Loading notifications" />
            ) : items.length === 0 ? (
              <p className="qf-notices__empty">Nothing new in the last 30 days.</p>
            ) : (
              <ul className="qf-notices__list" aria-label="Notifications">
                {items.map((n) => {
                  const to = noticeLink(n);
                  const text = noticeText(n);
                  return (
                    <li
                      key={n.id}
                      className={n.unread ? 'qf-notice qf-notice--unread' : 'qf-notice'}
                    >
                      {n.unread && <span className="qf-notice__dot" aria-label="Unread" />}
                      <div>
                        {to ? (
                          <Link to={to} onClick={() => setOpen(false)}>
                            {text}
                          </Link>
                        ) : (
                          <span>{text}</span>
                        )}
                        {n.kind === 'DELIVERY_FAILED' && n.error && (
                          <div className="qf-notice__detail">{n.error}</div>
                        )}
                        <div className="qf-notice__time" title={new Date(n.at).toLocaleString()}>
                          {timeAgo(n.at)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {cursor && (
              <Button kind="ghost" size="sm" disabled={busy} onClick={() => load(true)}>
                Show older
              </Button>
            )}
          </div>
        )}
      </HeaderPanel>
    </>
  );
}
