import {
  Button,
  DataTableSkeleton,
  InlineNotification,
  Modal,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Add, Edit, Play, TrashCan } from '@carbon/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Report, Schedule, ScheduleSettings } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { ScheduleEditorModal } from '../components/ScheduleEditorModal';
import { formatDateTime } from '../utils/format';

const statusTag: Record<Schedule['lastStatus'], 'gray' | 'blue' | 'green' | 'red'> = {
  NEVER: 'gray',
  RUNNING: 'blue',
  SUCCEEDED: 'green',
  FAILED: 'red',
};

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [settings, setSettings] = useState<ScheduleSettings | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | null | undefined>(undefined);
  const [toDelete, setToDelete] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.listSchedules(), api.listAllReports()]);
      setSchedules(s.schedules);
      setSettings(s.settings);
      setReports([...r.owned, ...r.shared.filter((x) => x.access === 'EDITOR')]);
    } catch (e) {
      setError(e);
      setSchedules([]);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const runNow = async (s: Schedule) => {
    setBusy(s.id);
    setNotice(null);
    try {
      const r = await api.runScheduleNow(s.id);
      setNotice(
        r.result.status === 'SUCCEEDED'
          ? `"${s.reportName}" ran and was e-mailed to ${s.recipients.length} recipient(s).`
          : `"${s.reportName}" failed: ${r.result.error ?? 'unknown error'}`,
      );
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Schedules</h1>
          <p>Reports that run automatically and are e-mailed as Excel files.</p>
        </div>
        <Button renderIcon={Add} onClick={() => setEditing(null)} disabled={!reports.length}>
          New schedule
        </Button>
      </div>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {notice && (
        <InlineNotification
          kind="info"
          lowContrast
          title={notice}
          onClose={() => setNotice(null)}
        />
      )}
      {schedules === null ? (
        <DataTableSkeleton columnCount={6} rowCount={3} showToolbar={false} />
      ) : schedules.length === 0 ? (
        <div className="qf-empty">
          <h2>No schedules yet</h2>
          <p>Open a report you own or can edit and choose “Schedule”, or create one here.</p>
        </div>
      ) : (
        <TableContainer>
          <Table aria-label="Schedules" size="md">
            <TableHead>
              <TableRow>
                <TableHeader>Report</TableHeader>
                <TableHeader>When</TableHeader>
                <TableHeader>Recipients</TableHeader>
                <TableHeader>Next run</TableHeader>
                <TableHeader>Last result</TableHeader>
                <TableHeader>
                  <span className="cds--visually-hidden">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <tbody>
              {schedules.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link to={`/reports/${s.reportId}`}>{s.reportName}</Link>
                    {!s.enabled && (
                      <Tag size="sm" type="warm-gray">
                        Paused
                      </Tag>
                    )}
                  </TableCell>
                  <TableCell>
                    <code>{s.cron}</code>
                    <div className="qf-muted">{s.timezone}</div>
                  </TableCell>
                  <TableCell>{s.recipients.join(', ')}</TableCell>
                  <TableCell>{s.enabled ? formatDateTime(s.nextRunAt) : '—'}</TableCell>
                  <TableCell>
                    <Tag size="sm" type={statusTag[s.lastStatus]}>
                      {s.lastStatus === 'NEVER' ? 'Not run yet' : s.lastStatus.toLowerCase()}
                    </Tag>
                    {s.failureCount > 0 && (
                      <span className="qf-muted"> {s.failureCount} failure(s)</span>
                    )}
                    {s.lastError && <div className="qf-error-text">{s.lastError}</div>}
                  </TableCell>
                  <TableCell className="qf-row-actions">
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={Play}
                      iconDescription="Run now"
                      disabled={busy === s.id}
                      onClick={() => runNow(s)}
                    />
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={Edit}
                      iconDescription="Edit schedule"
                      onClick={() => setEditing(s)}
                    />
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={TrashCan}
                      iconDescription="Delete schedule"
                      onClick={() => setToDelete(s)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      )}
      <ScheduleEditorModal
        open={editing !== undefined}
        schedule={editing ?? null}
        report={editing ? (reports.find((r) => r.id === editing.reportId) ?? null) : undefined}
        reports={reports}
        settings={settings}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          void load();
        }}
      />
      <Modal
        open={Boolean(toDelete)}
        danger
        modalHeading="Delete this schedule?"
        primaryButtonText="Delete"
        secondaryButtonText="Cancel"
        onRequestClose={() => setToDelete(null)}
        onRequestSubmit={async () => {
          if (!toDelete) return;
          try {
            await api.deleteSchedule(toDelete.id);
          } catch (e) {
            setError(e);
          }
          setToDelete(null);
          void load();
        }}
      >
        <p>Future runs of “{toDelete?.reportName}” will stop. Past history is kept.</p>
      </Modal>
    </>
  );
}
