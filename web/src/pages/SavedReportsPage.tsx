import {
  Button,
  DataTableSkeleton,
  OverflowMenu,
  OverflowMenuItem,
  Search,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ExecutionRecord, Report } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { formatDateTime, formatDuration, statusLabel, statusTagType } from '../utils/format';
import { DeleteReportModal, useReports } from './DashboardPage';

export function SavedReportsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const { reports, error, reload, setError } = useReports(search, 'name');
  const [toDelete, setToDelete] = useState<Report | null>(null);
  const [history, setHistory] = useState<ExecutionRecord[] | null>(null);

  useEffect(() => {
    api
      .history()
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [reports]);
  const nameOf = (id: string | null) =>
    id ? (reports?.find((r) => r.id === id)?.name ?? 'Deleted report') : 'Ad-hoc query';

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Saved Reports</h1>
          <p>Manage report definitions and review recent executions.</p>
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
        />
      </div>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {reports === null ? (
        <DataTableSkeleton columnCount={5} rowCount={4} showHeader={false} showToolbar={false} />
      ) : (
        <TableContainer>
          <Table aria-label="Saved reports">
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Category</TableHeader>
                <TableHeader>Last run</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Modified</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <tbody aria-live="polite">
              {reports.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    {search ? 'No matching reports.' : 'No saved reports yet.'}
                  </TableCell>
                </TableRow>
              )}
              {reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <a
                      href={`/reports/${r.id}`}
                      onClick={(e) => (e.preventDefault(), nav(`/reports/${r.id}`))}
                    >
                      {r.name}
                    </a>
                  </TableCell>
                  <TableCell>{r.category ?? '—'}</TableCell>
                  <TableCell>{formatDateTime(r.lastExecutedAt)}</TableCell>
                  <TableCell>
                    <Tag size="sm" type={statusTagType(r.lastStatus) as 'gray'}>
                      {statusLabel[r.lastStatus]}
                    </Tag>
                  </TableCell>
                  <TableCell>{formatDateTime(r.updatedAt)}</TableCell>
                  <TableCell>
                    <OverflowMenu aria-label={`Actions for ${r.name}`} flipped size="sm">
                      <OverflowMenuItem
                        itemText="Run"
                        onClick={() => nav(`/reports/${r.id}?run=1`)}
                      />
                      <OverflowMenuItem itemText="Edit" onClick={() => nav(`/reports/${r.id}`)} />
                      <OverflowMenuItem
                        itemText="Delete"
                        isDelete
                        hasDivider
                        onClick={() => setToDelete(r)}
                      />
                    </OverflowMenu>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      )}

      <section className="qf-section">
        <h2>Recent executions</h2>
        {history === null ? (
          <DataTableSkeleton columnCount={6} rowCount={3} showHeader={false} showToolbar={false} />
        ) : (
          <TableContainer>
            <Table size="sm" aria-label="Execution history">
              <TableHead>
                <TableRow>
                  <TableHeader>Started</TableHeader>
                  <TableHeader>Report</TableHeader>
                  <TableHeader>Type</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Rows</TableHeader>
                  <TableHeader>Duration</TableHeader>
                  <TableHeader>Error</TableHeader>
                </TableRow>
              </TableHead>
              <tbody aria-live="polite">
                {history.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7}>No executions yet.</TableCell>
                  </TableRow>
                )}
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{formatDateTime(h.startedAt)}</TableCell>
                    <TableCell>{nameOf(h.reportId)}</TableCell>
                    <TableCell>{h.kind === 'EXPORT' ? 'Excel export' : 'Run'}</TableCell>
                    <TableCell>
                      <Tag size="sm" type={statusTagType(h.status) as 'gray'}>
                        {statusLabel[h.status]}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      {h.rowCount ?? '—'}
                      {h.truncated ? ' (limited)' : ''}
                    </TableCell>
                    <TableCell>{formatDuration(h.elapsedMs)}</TableCell>
                    <TableCell>
                      {h.errorMessage
                        ? `${h.sqlState ? `[${h.sqlState}] ` : ''}${h.errorMessage}`
                        : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </TableContainer>
        )}
      </section>
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
