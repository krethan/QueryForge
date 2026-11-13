import {
  Button,
  DataTableSkeleton,
  Pagination,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Download, RecentlyViewed } from '@carbon/icons-react';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { FolderDeletion, FolderDeletionPage } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DeletedFolderAuditModal } from '../components/DeletedFolderAuditModal';
import { ErrorNotice } from '../components/ErrorNotice';
import { reportSharingLabel } from '../components/FolderAccessAuditModal';
import { formatDateTime } from '../utils/format';

export const DELETED_FOLDERS_PAGE_SIZES = [25, 50, 100];

const isForbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

/** Shown instead of the list to anyone who is not an app admin (the server returns 403 too). */
function AdminsOnly() {
  return (
    <div className="qf-empty" role="status">
      <h2>Admins only</h2>
      <p>Only an Uncle Bob administrator can view deleted folders.</p>
    </div>
  );
}

/**
 * Admin screen: every folder deletion recorded by migration 013, newest first, a page at a time
 * (the API's limit / offset). Each row can open the deleted folder's sharing history or export
 * it as CSV. Admin-only in the nav and here; the server enforces it (403) regardless.
 */
export function DeletedFoldersPage() {
  const { user } = useAuth();
  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Deleted folders</h1>
          <p>
            Folders their owners deleted, newest first. Deleting a folder never deletes reports;
            this record keeps who deleted it, when, and what access it had.
          </p>
        </div>
      </div>
      {user?.role === 'ADMIN' ? <DeletedFoldersList /> : <AdminsOnly />}
    </>
  );
}

function DeletedFoldersList() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DELETED_FOLDERS_PAGE_SIZES[0]);
  const [data, setData] = useState<FolderDeletionPage | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [actionError, setActionError] = useState<unknown>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [viewing, setViewing] = useState<FolderDeletion | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setLoadError(null);
    api
      .listFolderDeletions((page - 1) * pageSize, pageSize)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e);
      });
    return () => {
      live = false;
    };
  }, [page, pageSize, reload]);

  const exportCsv = async (d: FolderDeletion) => {
    setExporting(d.folderId);
    setExported(null);
    setActionError(null);
    try {
      const { filename } = await api.exportDeletedFolderAudit(d.folderId);
      setExported(`Downloaded ${filename} with the sharing history of “${d.folderName}”.`);
    } catch (e) {
      setActionError(e);
    } finally {
      setExporting(null);
    }
  };

  if (isForbidden(loadError) || isForbidden(actionError)) return <AdminsOnly />;

  if (loadError)
    return (
      <>
        <ErrorNotice error={loadError} />
        <Button kind="tertiary" size="sm" onClick={() => setReload((n) => n + 1)}>
          Try again
        </Button>
      </>
    );

  if (data === null)
    return (
      <div aria-busy="true" aria-label="Loading deleted folders">
        <DataTableSkeleton columnCount={8} rowCount={4} showHeader={false} showToolbar={false} />
      </div>
    );

  const first = (page - 1) * pageSize + 1;

  if (data.deletions.length === 0 && page === 1)
    return (
      <div className="qf-empty">
        <h2>No deleted folders</h2>
        <p>
          When someone deletes a folder, it is listed here. Folders deleted before migration 013 was
          applied were not recorded.
        </p>
      </div>
    );

  return (
    <>
      <ErrorNotice error={actionError} onClose={() => setActionError(null)} />
      <p className="qf-muted qf-deleted-folders__status" role="status">
        {exporting ? 'Exporting…' : (exported ?? '')}
      </p>
      <TableContainer>
        <Table aria-label="Deleted folders" className="qf-deleted-folders">
          <TableHead>
            <TableRow>
              <TableHeader>Folder</TableHeader>
              <TableHeader>Owner</TableHeader>
              <TableHeader>Deleted by</TableHeader>
              <TableHeader>Deleted at</TableHeader>
              <TableHeader>
                <span title="Users and groups the folder was shared with">Shares</span>
              </TableHeader>
              <TableHeader>
                <span title="Reports that people placed in the folder">Placed reports</span>
              </TableHeader>
              <TableHeader>
                <span title="The owner's own reports filed there (now Unfiled)">Filed reports</span>
              </TableHeader>
              <TableHeader>Report sharing</TableHeader>
              <TableHeader aria-label="Actions" />
            </TableRow>
          </TableHead>
          <tbody aria-live="polite">
            {data.deletions.length === 0 && (
              <TableRow>
                <TableCell colSpan={9}>No more deleted folders.</TableCell>
              </TableRow>
            )}
            {data.deletions.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.folderName}</TableCell>
                <TableCell>{d.ownerName ?? d.ownerId}</TableCell>
                <TableCell>{d.actorName ?? d.actorId}</TableCell>
                <TableCell>
                  <time dateTime={d.deletedAt}>{formatDateTime(d.deletedAt)}</time>
                </TableCell>
                <TableCell className="qf-deleted-folders__count">{d.shareCount}</TableCell>
                <TableCell className="qf-deleted-folders__count">{d.placedCount}</TableCell>
                <TableCell className="qf-deleted-folders__count">{d.filedCount}</TableCell>
                <TableCell>
                  {d.reportsRole ? (
                    <Tag size="sm" type="teal">
                      {reportSharingLabel(d.reportsRole)}
                    </Tag>
                  ) : (
                    reportSharingLabel(null)
                  )}
                </TableCell>
                <TableCell>
                  <div className="qf-deleted-folders__actions">
                    <Button
                      kind="ghost"
                      size="sm"
                      renderIcon={RecentlyViewed}
                      aria-label={`Sharing history for ${d.folderName}`}
                      onClick={() => setViewing(d)}
                    >
                      Sharing history
                    </Button>
                    <Button
                      kind="ghost"
                      size="sm"
                      renderIcon={Download}
                      aria-label={`Export CSV for ${d.folderName}`}
                      disabled={exporting !== null}
                      onClick={() => void exportCsv(d)}
                    >
                      Export CSV
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </TableContainer>
      <Pagination
        page={page}
        pageSize={pageSize}
        pageSizes={DELETED_FOLDERS_PAGE_SIZES}
        pagesUnknown
        isLastPage={!data.hasMore}
        itemText={() =>
          data.deletions.length
            ? `${first}–${first + data.deletions.length - 1} deleted folders`
            : 'No deleted folders on this page'
        }
        pageText={(p: number) => `Page ${p}`}
        backwardText="Previous page"
        forwardText="Next page"
        itemsPerPageText="Deleted folders per page:"
        onChange={({ page: p, pageSize: size }: { page: number; pageSize: number }) => {
          if (size !== pageSize) {
            setPageSize(size);
            setPage(1);
          } else setPage(p);
        }}
      />
      {viewing && <DeletedFolderAuditModal deletion={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
