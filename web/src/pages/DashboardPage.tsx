import type React from 'react';
import {
  Button,
  Modal,
  Search,
  Select,
  SelectItem,
  SkeletonPlaceholder,
  Tag,
  Tile,
  Toggle,
} from '@carbon/react';
import {
  Add,
  Edit,
  Folder as FolderIcon,
  FolderMoveTo,
  Play,
  Share as ShareIcon,
  Star,
  StarFilled,
  TrashCan,
  View,
} from '@carbon/icons-react';
import { ManageFoldersModal, MoveToFolderModal, UNFILED } from '../components/Folders';
import { ShareModal } from '../components/ShareModal';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Folder, Report } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { DashboardChart } from '../components/charts/DashboardChart';
import { encodeDrill } from '../utils/drill';
import { formatDateTime, formatDuration, statusLabel, statusTagType } from '../utils/format';

/** Grouped builder reports and reports with a drill target can be drilled from a tile. */
const mayDrill = (r: Report) =>
  !!r.drillDef || !!(r.builderDef?.spec.groupBy?.length || r.builderDef?.spec.aggregates?.length);

export function useReports(search: string, sort: string) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [shared, setShared] = useState<Report[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setError(null);
      const r = await api.listAllReports({ search, sort });
      setReports(r.owned);
      setShared(r.shared);
    } catch (e) {
      setError(e);
      setReports([]);
      setShared([]);
    }
  }, [search, sort]);
  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);
  return { reports, shared, error, reload: load, setError };
}

export function DeleteReportModal({
  report,
  onClose,
  onDeleted,
}: {
  report: Report | null;
  onClose(): void;
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      open={Boolean(report)}
      danger
      modalHeading={`Delete "${report?.name ?? ''}"?`}
      primaryButtonText={busy ? 'Deleting…' : 'Delete'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy}
      onRequestClose={() => {
        setError(null);
        onClose();
      }}
      onRequestSubmit={async () => {
        if (!report) return;
        setBusy(true);
        try {
          await api.deleteReport(report.id);
          setError(null);
          onDeleted();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorNotice error={error} />
      <p>
        This permanently deletes the saved report definition. Execution history is kept. This cannot
        be undone.
      </p>
    </Modal>
  );
}

function ReportTile({
  r,
  folderName,
  onDelete,
  onShare,
  onStar,
  onMove,
}: {
  r: Report;
  folderName?: string;
  onDelete(r: Report): void;
  onShare(r: Report): void;
  onStar(r: Report): void;
  onMove(r: Report): void;
}) {
  const nav = useNavigate();
  return (
    <Tile className="qf-tile" data-testid="report-tile">
      <div className="qf-tile__head">
        <h3>{r.name}</h3>
        <Button
          size="sm"
          kind="ghost"
          hasIconOnly
          className={r.favorite ? 'qf-star qf-star--on' : 'qf-star'}
          iconDescription={r.favorite ? `Unstar ${r.name}` : `Star ${r.name}`}
          aria-pressed={!!r.favorite}
          renderIcon={r.favorite ? StarFilled : Star}
          onClick={() => onStar(r)}
        />
      </div>
      {folderName && (
        <div className="qf-tile__folder">
          <FolderIcon size={12} aria-hidden="true" /> {folderName}
        </div>
      )}
      {r.access && r.access !== 'OWNER' && (
        <div className="qf-tile__owner">
          Shared by {r.ownerName ?? 'another user'} ·{' '}
          <Tag size="sm" type="purple">
            {r.access === 'ADMIN' ? 'Admin' : r.access === 'EDITOR' ? 'Editor' : 'Viewer'}
          </Tag>
        </div>
      )}
      {r.category && (
        <div>
          <Tag size="sm" type="cool-gray">
            {r.category}
          </Tag>
        </div>
      )}
      <p className="qf-tile__desc">{r.description ?? 'No description'}</p>
      {r.chartDef?.showOnDashboard && (
        <DashboardChart
          report={r}
          onDrill={
            mayDrill(r)
              ? (keys) => nav(`/reports/${r.id}?drill=${encodeURIComponent(encodeDrill(keys))}`)
              : undefined
          }
        />
      )}
      <div className="qf-tile__meta">
        <div>
          Last run: {formatDateTime(r.lastExecutedAt)}{' '}
          <Tag size="sm" type={statusTagType(r.lastStatus) as 'gray'}>
            {statusLabel[r.lastStatus]}
          </Tag>
        </div>
        {r.lastRowCount !== null && (
          <div>
            {r.lastRowCount.toLocaleString()} rows · {formatDuration(r.lastDurationMs)}
          </div>
        )}
      </div>
      <div className="qf-tile__actions">
        <Button size="sm" renderIcon={Play} onClick={() => nav(`/reports/${r.id}?run=1`)}>
          Run
        </Button>
        <Button
          size="sm"
          kind="ghost"
          renderIcon={r.access === 'VIEWER' ? View : Edit}
          onClick={() => nav(`/reports/${r.id}`)}
        >
          {r.access === 'VIEWER' ? 'Open' : 'Edit'}
        </Button>
        <Button
          size="sm"
          kind="ghost"
          hasIconOnly
          iconDescription={`Move ${r.name} to a folder`}
          renderIcon={FolderMoveTo}
          onClick={() => onMove(r)}
        />
        {(!r.access || r.access === 'OWNER') && (
          <>
            <Button
              size="sm"
              kind="ghost"
              hasIconOnly
              iconDescription={`Share ${r.name}`}
              renderIcon={ShareIcon}
              onClick={() => onShare(r)}
            />
            <Button
              size="sm"
              kind="ghost"
              hasIconOnly
              iconDescription={`Delete ${r.name}`}
              renderIcon={TrashCan}
              onClick={() => onDelete(r)}
            />
          </>
        )}
      </div>
    </Tile>
  );
}

export function useFolders() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setFolders(await api.listFolders());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return { folders, error, reload: load };
}

const ALL = '__all__';

export function DashboardPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const { reports, shared, error, reload, setError } = useReports(search, sort);
  const { folders, error: folderError, reload: reloadFolders } = useFolders();
  const [toDelete, setToDelete] = useState<Report | null>(null);
  const [toShare, setToShare] = useState<Report | null>(null);
  const [toMove, setToMove] = useState<Report | null>(null);
  const [manage, setManage] = useState(false);
  const [folderFilter, setFolderFilter] = useState(ALL);
  const [grouped, setGrouped] = useState(false);
  /** Optimistic local changes to stars / folders until the next reload. */
  const [local, setLocal] = useState<Record<string, Partial<Report>>>({});

  const apply = useCallback((r: Report): Report => ({ ...r, ...local[r.id] }), [local]);
  const owned = useMemo(() => (reports ?? []).map(apply), [reports, apply]);
  const sharedR = useMemo(() => shared.map(apply), [shared, apply]);
  const all = useMemo(() => [...owned, ...sharedR], [owned, sharedR]);
  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  // A report filed in a folder that no longer exists counts as Unfiled.
  const folderOf = (r: Report) => (r.folderId && folderName.has(r.folderId) ? r.folderId : null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) if (r.folderId) m.set(r.folderId, (m.get(r.folderId) ?? 0) + 1);
    return m;
  }, [all]);
  const favorites = all.filter((r) => r.favorite);
  const effectiveFilter =
    folderFilter === ALL || folderFilter === UNFILED || folderName.has(folderFilter)
      ? folderFilter
      : ALL;
  const inFilter = (r: Report) =>
    effectiveFilter === ALL ||
    (effectiveFilter === UNFILED ? folderOf(r) === null : folderOf(r) === effectiveFilter);

  const star = async (r: Report) => {
    const favorite = !r.favorite;
    setLocal((l) => ({ ...l, [r.id]: { ...l[r.id], favorite } }));
    try {
      await api.setReportPrefs(r.id, { favorite });
    } catch (e) {
      setLocal((l) => ({ ...l, [r.id]: { ...l[r.id], favorite: !favorite } }));
      setError(e);
    }
  };
  const tile = (r: Report, showFolder = true) => (
    <ReportTile
      key={r.id}
      r={r}
      folderName={showFolder ? (folderName.get(folderOf(r) ?? '') ?? undefined) : undefined}
      onDelete={setToDelete}
      onShare={setToShare}
      onStar={(x) => void star(x)}
      onMove={setToMove}
    />
  );
  const section = (id: string, title: string, items: Report[], showFolder = true) =>
    items.length > 0 && (
      <section key={id} className="qf-section" aria-labelledby={`${id}-heading`}>
        <h2 id={`${id}-heading`} className="qf-section__title">
          {title} <span className="qf-section__count">({items.length})</span>
        </h2>
        <div className="qf-tiles">{items.map((r) => tile(r, showFolder))}</div>
      </section>
    );
  const folderMode = grouped || effectiveFilter !== ALL;
  const visible = all.filter(inFilter);
  const groups: { id: string; title: string; items: Report[] }[] = grouped
    ? [
        ...folders.map((f) => ({
          id: `folder-${f.id}`,
          title: f.name,
          items: visible.filter((r) => folderOf(r) === f.id),
        })),
        { id: 'unfiled', title: 'Unfiled', items: visible.filter((r) => folderOf(r) === null) },
      ]
    : [
        {
          id: 'filtered',
          title: effectiveFilter === UNFILED ? 'Unfiled' : (folderName.get(effectiveFilter) ?? ''),
          items: visible,
        },
      ];

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Your saved Db2 for i reports. Results are always fetched live from IBM i.</p>
        </div>
        <Button renderIcon={Add} onClick={() => nav('/reports/new')}>
          New Report
        </Button>
      </div>
      <div className="qf-toolbar">
        <Search
          labelText="Search reports"
          placeholder="Search by report name"
          value={search}
          onChange={(e: { target: { value: string } }) => setSearch(e.target.value)}
          size="lg"
        />
        <Select
          id="sort"
          labelText="Sort by"
          value={sort}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            setSort(e.target.value as typeof sort)
          }
          inline={false}
          style={{ minWidth: '12rem' }}
        >
          <SelectItem value="name" text="Name" />
          <SelectItem value="lastRun" text="Last run" />
          <SelectItem value="updated" text="Last modified" />
          <SelectItem value="created" text="Newest" />
        </Select>
        <Select
          id="folder-filter"
          labelText="Folder"
          value={effectiveFilter}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFolderFilter(e.target.value)}
          inline={false}
          style={{ minWidth: '12rem' }}
        >
          <SelectItem value={ALL} text="All folders" />
          <SelectItem value={UNFILED} text="Unfiled" />
          {folders.map((f) => (
            <SelectItem key={f.id} value={f.id} text={f.name} />
          ))}
        </Select>
        <Toggle
          id="group-by-folder"
          labelText="Group by folder"
          size="sm"
          toggled={grouped}
          onToggle={(v: boolean) => setGrouped(v)}
        />
        <Button kind="tertiary" size="lg" renderIcon={FolderIcon} onClick={() => setManage(true)}>
          Manage folders
        </Button>
      </div>
      <ErrorNotice error={error ?? folderError} onClose={() => setError(null)} />
      {reports === null ? (
        <div className="qf-tiles" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: '100%', height: '12rem' }}>
              <SkeletonPlaceholder className="qf-skeleton" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {section('favorites', 'Favorites', favorites)}
          {folderMode ? (
            <>
              {groups.map((g) => section(g.id, g.title, g.items, false))}
              {visible.length === 0 && (
                <div className="qf-empty">
                  <h2>No reports here</h2>
                  <p>Use the folder button on a report to move it into this folder.</p>
                </div>
              )}
            </>
          ) : owned.length === 0 ? (
            <div className="qf-empty">
              <h2>{search ? 'No matching reports' : 'No saved reports yet'}</h2>
              <p>
                {search
                  ? `Nothing matches "${search}".`
                  : 'Write a SELECT statement, run it, and save it as a report.'}
              </p>
              {!search && (
                <Button renderIcon={Add} onClick={() => nav('/reports/new')}>
                  Create your first report
                </Button>
              )}
            </div>
          ) : (
            <>
              {favorites.length > 0 && (
                <h2 className="qf-section__title" id="mine-heading">
                  My reports
                </h2>
              )}
              <div className="qf-tiles">{owned.map((r) => tile(r))}</div>
            </>
          )}
          {!folderMode && sharedR.length > 0 && (
            <section className="qf-section" aria-labelledby="shared-heading">
              <h2 id="shared-heading" className="qf-section__title">
                Shared with me
              </h2>
              <div className="qf-tiles">{sharedR.map((r) => tile(r))}</div>
            </section>
          )}
        </>
      )}
      {toShare && <ShareModal report={toShare} onClose={() => setToShare(null)} />}
      <ManageFoldersModal
        open={manage}
        folders={folders}
        counts={counts}
        onClose={() => setManage(false)}
        onChanged={async () => {
          await reloadFolders();
          setLocal({});
          await reload();
        }}
      />
      {toMove && (
        <MoveToFolderModal
          report={toMove}
          folders={folders}
          onClose={() => setToMove(null)}
          onMoved={(folderId) => {
            const id = toMove!.id;
            setLocal((l) => ({ ...l, [id]: { ...l[id], folderId } }));
            setToMove(null);
          }}
        />
      )}
      <DeleteReportModal
        report={toDelete}
        onClose={() => setToDelete(null)}
        onDeleted={() => {
          setToDelete(null);
          void reload();
        }}
      />
    </>
  );
}
