import {
  Button,
  DataTableSkeleton,
  Search,
  Select,
  SelectItem,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { ChevronLeft, ChevronRight, Download, RecentlyViewed } from '@carbon/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  FolderDeletion,
  FolderDeletionActor,
  FolderDeletionFilter,
  FolderDeletionPage,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DeletedFolderAuditModal } from '../components/DeletedFolderAuditModal';
import { ErrorNotice } from '../components/ErrorNotice';
import { reportSharingLabel } from '../components/FolderAccessAuditModal';
import { browserTimeZone, endOfDayIso } from '../utils/expiry';
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
 * Admin screen: every folder deletion recorded by migration 013, newest first, a page at a time.
 * Search, "deleted by" and the date range are applied on the server, which also returns the
 * total that match and a keyset cursor for the next page (kept per page here for Previous). Each row can open the deleted folder's sharing history or export
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

/**
 * A native date input in Carbon's text-input style. Carbon's TextInput adds an always-present
 * live "alert" region, which would compete with the page's real error notices.
 */
function DateField(props: {
  id: string;
  label: string;
  value: string;
  min?: string;
  max?: string;
  invalidText?: string;
  onChange: (value: string) => void;
}) {
  const { id, label, value, min, max, invalidText, onChange } = props;
  return (
    <div className="cds--form-item cds--text-input-wrapper">
      <label htmlFor={id} className="cds--label">
        {label}
      </label>
      <input
        id={id}
        type="date"
        className={`cds--text-input cds--text-input--md${invalidText ? ' cds--text-input--invalid' : ''}`}
        value={value}
        min={min}
        max={max}
        aria-invalid={invalidText ? true : undefined}
        aria-describedby={invalidText ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalidText && (
        <div id={`${id}-error`} className="cds--form-requirement qf-deleted-folders__invalid">
          {invalidText}
        </div>
      )}
    </div>
  );
}

/** How long typing in the search box waits before asking the server. */
export const DELETED_FOLDERS_SEARCH_DELAY_MS = 300;

/** Start of a local calendar day (YYYY-MM-DD) as an ISO-8601 instant, or null if invalid. */
export function startOfDayIso(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The server filter for a "deleted from / to" pair of local days, both inclusive: from the
 * start of `from` to the start of the day after `to` (the server's `to` is exclusive).
 */
export function deletedRange(from: string, to: string): { from?: string; to?: string } {
  return {
    from: from ? (startOfDayIso(from) ?? undefined) : undefined,
    to: to ? (endOfDayIso(to) ?? undefined) : undefined,
  };
}

function DeletedFoldersList() {
  const [pageSize, setPageSize] = useState(DELETED_FOLDERS_PAGE_SIZES[0]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [actorId, setActorId] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [actors, setActors] = useState<FolderDeletionActor[]>([]);
  const [data, setData] = useState<FolderDeletionPage | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [actionError, setActionError] = useState<unknown>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [viewing, setViewing] = useState<FolderDeletion | null>(null);

  const rangeBad = fromDay !== '' && toDay !== '' && fromDay > toDay;
  const filter = useMemo<FolderDeletionFilter>(
    () => ({
      q: q.trim() || undefined,
      actorId: actorId || undefined,
      ...deletedRange(fromDay, toDay),
    }),
    [q, actorId, fromDay, toDay],
  );
  const filtered = Boolean(filter.q || filter.actorId || filter.from || filter.to);
  // Keyset cursors of the pages visited so far (the last is the page on screen), for one set of
  // filters and page size only: any change starts again at page 1 in the same render, so a
  // cursor is never sent with filters it did not come from.
  const pagingKey = JSON.stringify([filter, pageSize]);
  const [paging, setPaging] = useState<{ key: string; cursors: (string | null)[] }>({
    key: pagingKey,
    cursors: [null],
  });
  const cursors = paging.key === pagingKey ? paging.cursors : [null];
  const page = cursors.length;
  const cursor = cursors[cursors.length - 1];
  const setCursors = (c: (string | null)[]) => setPaging({ key: pagingKey, cursors: c });

  // Typing waits a moment; the other filters apply at once.
  useEffect(() => {
    const t = setTimeout(() => setQ(search), DELETED_FOLDERS_SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    api
      .listFolderDeletionActors()
      .then((a) => {
        if (live) setActors(a);
      })
      .catch(() => undefined); // the filter just offers "Anyone"; the list reports real errors
    return () => {
      live = false;
    };
  }, [reload]);

  useEffect(() => {
    if (rangeBad) return;
    let live = true;
    setData(null);
    setLoadError(null);
    api
      .listFolderDeletions({ ...filter, limit: pageSize, cursor })
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e);
      });
    return () => {
      live = false;
    };
  }, [filter, pageSize, cursor, reload, rangeBad]);

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

  const exportList = async () => {
    setExporting('*list');
    setExported(null);
    setActionError(null);
    try {
      const { filename } = await api.exportFolderDeletions(filter);
      setExported(
        `Downloaded ${filename} with ${filtered ? 'the deleted folders matching your filters' : 'every deleted folder'}.`,
      );
    } catch (e) {
      setActionError(e);
    } finally {
      setExporting(null);
    }
  };

  const clearFilters = () => {
    setSearch('');
    setQ('');
    setActorId('');
    setFromDay('');
    setToDay('');
  };

  if (isForbidden(loadError) || isForbidden(actionError)) return <AdminsOnly />;

  const toolbar = (
    <div className="qf-toolbar qf-deleted-folders__filters">
      <Search
        labelText="Search deleted folders"
        placeholder="Search by folder name or owner"
        size="md"
        value={search}
        maxLength={60}
        onChange={(e: { target: { value: string } }) => setSearch(e.target.value)}
      />
      <Select
        id="qf-deleted-by"
        labelText="Deleted by"
        size="md"
        value={actorId}
        onChange={(e: { target: { value: string } }) => setActorId(e.target.value)}
      >
        <SelectItem value="" text="Anyone" />
        {actors.map((a) => (
          <SelectItem key={a.id} value={a.id} text={a.name ?? a.id} />
        ))}
        {actorId && !actors.some((a) => a.id === actorId) && (
          <SelectItem value={actorId} text={actorId} />
        )}
      </Select>
      <DateField
        id="qf-deleted-from"
        label="Deleted from"
        value={fromDay}
        max={toDay || undefined}
        onChange={setFromDay}
      />
      <DateField
        id="qf-deleted-to"
        label="Deleted to"
        value={toDay}
        min={fromDay || undefined}
        invalidText={rangeBad ? 'Pick a day on or after “Deleted from”.' : undefined}
        onChange={setToDay}
      />
      <div className="qf-deleted-folders__filter-actions">
        <Button kind="ghost" size="md" disabled={!filtered && !search} onClick={clearFilters}>
          Clear filters
        </Button>
        <Button
          kind="tertiary"
          size="md"
          renderIcon={Download}
          disabled={exporting !== null || rangeBad || data === null || data.total === 0}
          onClick={() => void exportList()}
        >
          Export list
        </Button>
      </div>
    </div>
  );
  const zone = browserTimeZone();

  if (loadError)
    return (
      <>
        {toolbar}
        <ErrorNotice error={loadError} />
        <Button kind="tertiary" size="sm" onClick={() => setReload((n) => n + 1)}>
          Try again
        </Button>
      </>
    );

  if (rangeBad)
    return (
      <>
        {toolbar}
        <p className="qf-muted" role="status">
          “Deleted to” is before “Deleted from”, so nothing can match.
        </p>
      </>
    );

  if (data === null)
    return (
      <>
        {toolbar}
        <div aria-busy="true" aria-label="Loading deleted folders">
          <DataTableSkeleton columnCount={8} rowCount={4} showHeader={false} showToolbar={false} />
        </div>
      </>
    );

  if (data.total === 0 && data.deletions.length === 0 && !filtered && page === 1)
    return (
      <div className="qf-empty">
        <h2>No deleted folders</h2>
        <p>
          When someone deletes a folder, it is listed here. Folders deleted before migration 013 was
          applied were not recorded.
        </p>
      </div>
    );

  const first = data.deletions.length ? (page - 1) * pageSize + 1 : 0;
  const last = first ? first + data.deletions.length - 1 : 0;
  const summary = data.deletions.length
    ? `${first}–${last} of ${data.total} deleted ${data.total === 1 ? 'folder' : 'folders'}${filtered ? ' matching your filters' : ''}`
    : filtered
      ? 'No deleted folders match your filters'
      : 'No deleted folders on this page';

  return (
    <>
      {toolbar}
      <p className="qf-muted qf-deleted-folders__zone">
        Days are in your time zone ({zone}); “Deleted to” includes that whole day.
      </p>
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
                <TableCell colSpan={9}>
                  {filtered
                    ? 'No deleted folders match these filters.'
                    : 'No more deleted folders.'}
                </TableCell>
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
      <div className="qf-deleted-folders__pager">
        <Select
          id="qf-deleted-page-size"
          labelText="Deleted folders per page:"
          inline
          size="sm"
          value={String(pageSize)}
          onChange={(e: { target: { value: string } }) => setPageSize(Number(e.target.value))}
        >
          {DELETED_FOLDERS_PAGE_SIZES.map((n) => (
            <SelectItem key={n} value={String(n)} text={String(n)} />
          ))}
        </Select>
        <span className="qf-deleted-folders__summary">{summary}</span>
        <span className="qf-muted">Page {page}</span>
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={ChevronLeft}
          iconDescription="Previous page"
          tooltipPosition="top"
          disabled={page === 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
        />
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={ChevronRight}
          iconDescription="Next page"
          tooltipPosition="top"
          disabled={!data.next}
          onClick={() => {
            const next = data.next;
            if (next) setCursors([...cursors, next]);
          }}
        />
      </div>
      {viewing && <DeletedFolderAuditModal deletion={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
