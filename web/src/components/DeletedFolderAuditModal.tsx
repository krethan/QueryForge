import { Download } from '@carbon/icons-react';
import { Button, InlineLoading, Modal } from '@carbon/react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { FolderDeletion, FolderShareAuditEvent } from '../api/types';
import { formatDateTime } from '../utils/format';
import { ErrorNotice } from './ErrorNotice';
import { FolderAuditEventList, reportSharingLabel } from './FolderAccessAuditModal';

/**
 * Admin-only, read-only view of a deleted folder's sharing history (migration 013), styled like
 * the folder's Access and audit panel. The history ends with the REVOKE rows the deletion
 * recorded. Older events load a page at a time; Export CSV downloads the whole history.
 */
export function DeletedFolderAuditModal({
  deletion,
  onClose,
}: {
  deletion: FolderDeletion;
  onClose(): void;
}) {
  const [events, setEvents] = useState<FolderShareAuditEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setError(null);
    api
      .getDeletedFolderAudit(deletion.folderId)
      .then((page) => {
        if (!live) return;
        setEvents(page.events);
        setHasMore(page.hasMore);
      })
      .catch((e: unknown) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [deletion.folderId]);

  const loadMore = async () => {
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.getDeletedFolderAudit(deletion.folderId, events?.length ?? 0);
      setEvents((cur) => {
        const seen = new Set((cur ?? []).map((e) => e.id));
        return [...(cur ?? []), ...page.events.filter((e) => !seen.has(e.id))];
      });
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    setExported(null);
    setError(null);
    try {
      const { filename } = await api.exportDeletedFolderAudit(deletion.folderId);
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
      modalHeading={`Sharing history · ${deletion.folderName} (deleted)`}
      onRequestClose={onClose}
    >
      <dl className="qf-deleted-folder__summary" aria-label="Deletion details">
        <dt>Owner</dt>
        <dd>{deletion.ownerName ?? deletion.ownerId}</dd>
        <dt>Deleted by</dt>
        <dd>{deletion.actorName ?? deletion.actorId}</dd>
        <dt>Deleted at</dt>
        <dd>
          <time dateTime={deletion.deletedAt}>{formatDateTime(deletion.deletedAt)}</time>
        </dd>
        <dt>Report sharing at deletion</dt>
        <dd>{reportSharingLabel(deletion.reportsRole)}</dd>
      </dl>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      <div className="qf-folder-audit__history-head">
        <h3 className="qf-modal-subheading">Sharing history</h3>
        {exporting ? (
          <InlineLoading description="Exporting…" />
        ) : (
          <Button kind="tertiary" size="sm" renderIcon={Download} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        )}
      </div>
      {exported && (
        <p className="qf-muted qf-folder-audit__exported" role="status">
          Downloaded {exported} with the full sharing history.
        </p>
      )}
      {events === null && !error && <InlineLoading description="Loading sharing history…" />}
      {events && <FolderAuditEventList events={events} />}
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
    </Modal>
  );
}
