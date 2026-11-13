import { Download } from '@carbon/icons-react';
import { Button, InlineLoading, Modal, Tag } from '@carbon/react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Folder, FolderAccess, FolderShareAuditEvent } from '../api/types';
import { formatDateTime } from '../utils/format';
import { ErrorNotice } from './ErrorNotice';

type Role = 'VIEWER' | 'EDITOR' | null;

const roleLabel = (r: Role) => (r === 'EDITOR' ? 'Editor' : r === 'VIEWER' ? 'Viewer' : '');
/** The folder's "also share the reports" option, as the share dialog words it. */
export const reportSharingLabel = (r: Role) =>
  r === 'EDITOR' ? 'Match folder access' : r === 'VIEWER' ? 'View only' : 'Off';

/** What an event was about: a user, a group, or the folder's report-sharing option. */
export function folderEventTarget(e: FolderShareAuditEvent): string {
  if (e.principalType === 'REPORTS') return 'Reports in this folder';
  if (e.principalType === 'GROUP') return `Group ${e.principalId}`;
  return e.principalName ?? e.principalId;
}

/** Before / after, in the words of the row's kind. */
export function folderEventRoles(e: FolderShareAuditEvent): { before: string; after: string } {
  if (e.principalType === 'REPORTS')
    return { before: reportSharingLabel(e.oldRole), after: reportSharingLabel(e.newRole) };
  return {
    before: e.oldRole ? roleLabel(e.oldRole) : 'No access',
    after: e.newRole ? roleLabel(e.newRole) : 'No access',
  };
}

export function describeFolderEvent(e: FolderShareAuditEvent): string {
  const actor = e.actorName ?? e.actorId;
  if (e.principalType === 'REPORTS') {
    if (e.action === 'GRANT')
      return `${actor} turned on sharing the reports in this folder (${reportSharingLabel(e.newRole).toLowerCase()})`;
    if (e.action === 'REVOKE') return `${actor} turned off sharing the reports in this folder`;
    return `${actor} changed report sharing from ${reportSharingLabel(e.oldRole).toLowerCase()} to ${reportSharingLabel(e.newRole).toLowerCase()}`;
  }
  const who = e.principalType === 'GROUP' ? `group ${e.principalId}` : folderEventTarget(e);
  if (e.action === 'GRANT') return `${actor} granted ${roleLabel(e.newRole)} access to ${who}`;
  if (e.action === 'REVOKE') return `${actor} revoked ${roleLabel(e.oldRole)} access from ${who}`;
  return `${actor} changed ${who} from ${roleLabel(e.oldRole)} to ${roleLabel(e.newRole)}`;
}

const actionTag = (e: FolderShareAuditEvent) => {
  const reports = e.principalType === 'REPORTS';
  if (e.action === 'GRANT')
    return { type: 'green' as const, text: reports ? 'Turned on' : 'Granted' };
  if (e.action === 'REVOKE')
    return { type: 'red' as const, text: reports ? 'Turned off' : 'Revoked' };
  return { type: 'cyan' as const, text: 'Changed' };
};

/**
 * A folder's sharing history, newest first: one line per grant / change / revoke, including the
 * report-sharing option. Shared by the folder's Access and audit panel and the admin
 * Deleted folders screen.
 */
export function FolderAuditEventList({ events }: { events: FolderShareAuditEvent[] }) {
  if (events.length === 0) return <p>No sharing changes recorded.</p>;
  return (
    <ol className="qf-audit-list" aria-label="Sharing history">
      {events.map((e) => {
        const tag = actionTag(e);
        const { before, after } = folderEventRoles(e);
        return (
          <li key={e.id}>
            <Tag size="sm" type={tag.type}>
              {tag.text}
            </Tag>{' '}
            {describeFolderEvent(e)}
            <span className="qf-folder-audit__roles">
              {folderEventTarget(e)}: {before} → {after}
            </span>
            <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Owner (or admin) panel for a folder, like the report's Access and audit panel: who can reach
 * the folder now, whether its reports are shared, and the grant / change / revoke history,
 * including the report-sharing option, newest first, a page at a time.
 */
export function FolderAccessAuditModal({
  folder,
  onClose,
}: {
  folder: Pick<Folder, 'id' | 'name'>;
  onClose(): void;
}) {
  const [data, setData] = useState<FolderAccess | null>(null);
  const [events, setEvents] = useState<FolderShareAuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .getFolderAccess(folder.id)
      .then((d) => {
        if (!live) return;
        setData(d);
        setEvents(d.events);
        setHasMore(d.hasMore);
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [folder.id]);

  const loadMore = async () => {
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.getFolderAudit(folder.id, events.length);
      // An event recorded while the panel was open shifts the pages by one: skip repeats.
      setEvents((cur) => {
        const seen = new Set(cur.map((e) => e.id));
        return [...cur, ...page.events.filter((e) => !seen.has(e.id))];
      });
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  /** The whole history as CSV, straight from the server (every event, not just those loaded). */
  const exportCsv = async () => {
    setExporting(true);
    setExported(null);
    setError(null);
    try {
      const { filename } = await api.exportFolderAudit(folder.id);
      setExported(filename);
    } catch (e) {
      setError(e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      open
      passiveModal
      size="md"
      modalHeading={`Access and audit · ${folder.name}`}
      onRequestClose={onClose}
    >
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {!data && !error && <InlineLoading description="Loading access…" />}
      {data && (
        <>
          <h3 className="qf-modal-subheading">Current access</h3>
          <ul className="qf-audit-list" aria-label="Current access">
            <li>
              {data.owner.displayName}{' '}
              <Tag size="sm" type="blue">
                Owner
              </Tag>
            </li>
            {data.shares.map((s) => (
              <li key={`${s.type}:${s.id}`}>
                {s.type === 'GROUP' ? `Group ${s.id}` : (s.displayName ?? s.id)}{' '}
                <Tag size="sm" type={s.role === 'EDITOR' ? 'purple' : 'gray'}>
                  {roleLabel(s.role)}
                </Tag>
              </li>
            ))}
            {data.shares.length === 0 && <li>Not shared with anyone.</li>}
          </ul>
          <div className="qf-muted qf-folder-audit__reports">
            Reports in this folder:{' '}
            {data.shareReports ? (
              <Tag size="sm" type="teal">
                Shared · {reportSharingLabel(data.shareReports)}
              </Tag>
            ) : (
              'not shared through the folder'
            )}
          </div>
          <div className="qf-folder-audit__history-head">
            <h3 className="qf-modal-subheading">Sharing history</h3>
            {exporting ? (
              <InlineLoading description="Exporting…" />
            ) : (
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Download}
                onClick={() => void exportCsv()}
              >
                Export CSV
              </Button>
            )}
          </div>
          {exported && (
            <p className="qf-muted qf-folder-audit__exported" role="status">
              Downloaded {exported} with the full sharing history.
            </p>
          )}
          <FolderAuditEventList events={events} />
          {hasMore && (
            <Button
              kind="ghost"
              size="sm"
              className="qf-folder-audit__more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Show older changes'}
            </Button>
          )}
        </>
      )}
    </Modal>
  );
}
