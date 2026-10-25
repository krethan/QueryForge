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
} from '@carbon/react';
import { Add, Edit, Play, Share as ShareIcon, TrashCan, View } from '@carbon/icons-react';
import { ShareModal } from '../components/ShareModal';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Report } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { formatDateTime, formatDuration, statusLabel, statusTagType } from '../utils/format';

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
  onDelete,
  onShare,
}: {
  r: Report;
  onDelete(r: Report): void;
  onShare(r: Report): void;
}) {
  const nav = useNavigate();
  return (
    <Tile className="qf-tile" data-testid="report-tile">
      <h3>{r.name}</h3>
      {r.access && r.access !== 'OWNER' && (
        <p className="qf-tile__owner">
          Shared by {r.ownerName ?? 'another user'} ·{' '}
          <Tag size="sm" type="purple">
            {r.access === 'EDITOR' ? 'Editor' : 'Viewer'}
          </Tag>
        </p>
      )}
      {r.category && (
        <div>
          <Tag size="sm" type="cool-gray">
            {r.category}
          </Tag>
        </div>
      )}
      <p className="qf-tile__desc">{r.description ?? 'No description'}</p>
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

export function DashboardPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const { reports, shared, error, reload, setError } = useReports(search, sort);
  const [toDelete, setToDelete] = useState<Report | null>(null);
  const [toShare, setToShare] = useState<Report | null>(null);

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
      </div>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {reports === null ? (
        <div className="qf-tiles" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: '100%', height: '12rem' }}>
              <SkeletonPlaceholder className="qf-skeleton" />
            </div>
          ))}
        </div>
      ) : reports.length === 0 ? (
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
        <div className="qf-tiles">
          {reports.map((r) => (
            <ReportTile key={r.id} r={r} onDelete={setToDelete} onShare={setToShare} />
          ))}
        </div>
      )}
      {shared.length > 0 && (
        <section className="qf-section" aria-labelledby="shared-heading">
          <h2 id="shared-heading" className="qf-section__title">
            Shared with me
          </h2>
          <div className="qf-tiles">
            {shared.map((r) => (
              <ReportTile key={r.id} r={r} onDelete={setToDelete} onShare={setToShare} />
            ))}
          </div>
        </section>
      )}
      {toShare && <ShareModal report={toShare} onClose={() => setToShare(null)} />}
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
