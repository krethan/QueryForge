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
  Draggable,
  Edit,
  Folder as FolderIcon,
  FolderMoveTo,
  Play,
  Reset,
  Share as ShareIcon,
  Star,
  StarFilled,
  TrashCan,
  View,
} from '@carbon/icons-react';
import { ManageFoldersModal, MoveToFolderModal, UNFILED } from '../components/Folders';
import { ShareModal } from '../components/ShareModal';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Folder, Report } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { DashboardChart } from '../components/charts/DashboardChart';
import { encodeDrill } from '../utils/drill';
import {
  initialTileOrder,
  mergeSectionOrder,
  moveBefore,
  moveBy,
  sortByOrder,
} from '../utils/tileOrder';
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
  dragHandle,
  onDelete,
  onShare,
  onStar,
  onMove,
}: {
  r: Report;
  folderName?: string;
  /** The drag handle, when the dashboard is in "My order" and may be rearranged. */
  dragHandle?: React.ReactNode;
  onDelete(r: Report): void;
  onShare(r: Report): void;
  onStar(r: Report): void;
  onMove(r: Report): void;
}) {
  const nav = useNavigate();
  return (
    <Tile className="qf-tile" data-testid="report-tile">
      <div className="qf-tile__head">
        {dragHandle}
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

const REORDER_HELP_ID = 'qf-reorder-help';

/**
 * A grid of tiles that can be rearranged by dragging a tile (native HTML drag and drop) or,
 * from the keyboard, by focusing a tile's handle and pressing the arrow keys. Tiles move only
 * within their own section; the new order of the section is passed to `onReorder`.
 */
function SortableTiles({
  section,
  items,
  enabled,
  onReorder,
  render,
}: {
  section: string;
  items: Report[];
  enabled: boolean;
  onReorder(ids: string[], moved: Report): void;
  render(r: Report, dragHandle?: React.ReactNode): React.ReactNode;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const ids = items.map((r) => r.id);
  const end = () => {
    setDragId(null);
    setOver(null);
  };
  return (
    <div className="qf-tiles" data-section={section}>
      {items.map((r) => {
        const cls = ['qf-tile-slot'];
        if (enabled) cls.push('qf-tile-slot--sortable');
        if (dragId === r.id) cls.push('qf-tile-slot--dragging');
        if (over?.id === r.id && dragId && dragId !== r.id)
          cls.push(over.after ? 'qf-tile-slot--drop-after' : 'qf-tile-slot--drop-before');
        const handle = enabled ? (
          <Button
            size="sm"
            kind="ghost"
            hasIconOnly
            className="qf-drag-handle"
            iconDescription={`Reorder ${r.name}`}
            tooltipPosition="right"
            aria-describedby={REORDER_HELP_ID}
            renderIcon={Draggable}
            onKeyDown={(e: React.KeyboardEvent) => {
              const delta =
                e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                  ? -1
                  : e.key === 'ArrowRight' || e.key === 'ArrowDown'
                    ? 1
                    : e.key === 'Home'
                      ? -ids.length
                      : e.key === 'End'
                        ? ids.length
                        : 0;
              if (!delta) return;
              e.preventDefault();
              const next = moveBy(ids, r.id, delta);
              if (next !== ids) onReorder(next, r);
            }}
          />
        ) : undefined;
        return (
          <div
            key={r.id}
            className={cls.join(' ')}
            data-testid="tile-slot"
            data-report-id={r.id}
            draggable={enabled}
            onDragStart={(e) => {
              if (!enabled) return;
              setDragId(r.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', r.id);
            }}
            onDragOver={(e) => {
              if (!enabled || !dragId) return; // only tiles dragged from this section
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const box = e.currentTarget.getBoundingClientRect();
              const after = box.width > 0 && e.clientX > box.left + box.width / 2;
              if (over?.id !== r.id || over.after !== after) setOver({ id: r.id, after });
            }}
            onDrop={(e) => {
              if (!enabled || !dragId) return;
              e.preventDefault();
              const moved = items.find((x) => x.id === dragId);
              const next = moveBefore(ids, dragId, r.id, over?.id === r.id && over.after);
              end();
              if (moved && next !== ids) onReorder(next, moved);
            }}
            onDragEnd={end}
          >
            {render(r, handle)}
          </div>
        );
      })}
    </div>
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
  /** 'custom' is the user's own saved tile order ("My order"); without one it is name order. */
  const [sort, setSort] = useState('custom');
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
  /** Optimistic whole-dashboard tile order after a rearrange, until the next reload. */
  const [order, setOrder] = useState<string[] | null>(null);
  const [announce, setAnnounce] = useState('');
  const custom = sort === 'custom';
  // Saving a partial list would forget the position of every report hidden by the search.
  const canReorder = custom && !search.trim();
  useEffect(() => setOrder(null), [reports, shared]);
  const serverOrder = useMemo(
    () => initialTileOrder([...(reports ?? []), ...shared]),
    [reports, shared],
  );
  const tileOrder = order ?? serverOrder;
  const hasSavedOrder =
    order !== null || [...(reports ?? []), ...shared].some((r) => r.tilePos != null);
  const ordered = useCallback(
    (xs: Report[]) => (custom ? sortByOrder(xs, tileOrder) : xs),
    [custom, tileOrder],
  );
  const owned = useMemo(() => ordered((reports ?? []).map(apply)), [reports, apply, ordered]);
  const sharedR = useMemo(() => ordered(shared.map(apply)), [shared, apply, ordered]);
  const all = useMemo(() => ordered([...owned, ...sharedR]), [owned, sharedR, ordered]);
  /** Saves run one after another so the last rearrange always wins. */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const confirmed = useRef<string[] | null>(null);
  const reorder = (sectionIds: string[], moved: Report) => {
    const next = mergeSectionOrder(tileOrder, sectionIds);
    setOrder(next);
    setAnnounce(
      `${moved.name} moved to position ${sectionIds.indexOf(moved.id) + 1} of ${sectionIds.length}.`,
    );
    saving.current = saving.current.then(async () => {
      try {
        confirmed.current = await api.saveTileOrder(next);
      } catch (e) {
        setOrder(confirmed.current);
        setError(e);
      }
    });
  };
  const resetOrder = async () => {
    try {
      await saving.current;
      await api.resetTileOrder();
      confirmed.current = null;
      setAnnounce('Dashboard order reset.');
      await reload();
    } catch (e) {
      setError(e);
    }
  };
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
  const tile = (r: Report, showFolder = true, dragHandle?: React.ReactNode) => (
    <ReportTile
      key={r.id}
      r={r}
      dragHandle={dragHandle}
      folderName={showFolder ? (folderName.get(folderOf(r) ?? '') ?? undefined) : undefined}
      onDelete={setToDelete}
      onShare={setToShare}
      onStar={(x) => void star(x)}
      onMove={setToMove}
    />
  );
  const tiles = (id: string, items: Report[], showFolder = true) => (
    <SortableTiles
      section={id}
      items={items}
      enabled={canReorder && items.length > 1}
      onReorder={reorder}
      render={(r, handle) => tile(r, showFolder, handle)}
    />
  );
  const section = (id: string, title: string, items: Report[], showFolder = true) =>
    items.length > 0 && (
      <section key={id} className="qf-section" aria-labelledby={`${id}-heading`}>
        <h2 id={`${id}-heading`} className="qf-section__title">
          {title} <span className="qf-section__count">({items.length})</span>
        </h2>
        {tiles(id, items, showFolder)}
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
          <SelectItem value="custom" text="My order" />
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
      {custom && (
        <div className="qf-reorder-help">
          <p id={REORDER_HELP_ID}>
            {canReorder
              ? 'Drag a tile to rearrange your dashboard, or focus its handle and use the arrow keys. Your order is saved for you only.'
              : 'Clear the search to rearrange tiles.'}
          </p>
          {hasSavedOrder && (
            <Button kind="ghost" size="sm" renderIcon={Reset} onClick={() => void resetOrder()}>
              Reset order
            </Button>
          )}
        </div>
      )}
      <div className="cds--visually-hidden" aria-live="polite" data-testid="reorder-status">
        {announce}
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
              {tiles('mine', owned)}
            </>
          )}
          {!folderMode && sharedR.length > 0 && (
            <section className="qf-section" aria-labelledby="shared-heading">
              <h2 id="shared-heading" className="qf-section__title">
                Shared with me
              </h2>
              {tiles('shared', sharedR)}
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
