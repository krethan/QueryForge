import {
  Button,
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
import { Edit, Pause, Play, PlayOutline, RecentlyViewed, TrashCan } from '@carbon/icons-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Report, Schedule, ScheduleSettings } from '../api/types';
import { formatDateTime } from '../utils/format';
import { scheduleStatusTag } from '../utils/schedule';
import { ErrorNotice } from './ErrorNotice';
import { ScheduleEditorModal } from './ScheduleEditorModal';
import { ScheduleHistoryModal } from './ScheduleHistoryModal';

const NO_REPORTS: Report[] = [];

interface Props {
  /** Open this schedule's delivery history once it is listed (a link from a notification). */
  openHistoryFor?: string | null;
  schedules: Schedule[];
  settings: ScheduleSettings | null;
  /** Fixed report (report editor); otherwise schedules may belong to any of `reports`. */
  report?: Report | null;
  reports?: Report[];
  /** Show the report column (the Schedules page). */
  showReport?: boolean;
  /** Increment to open the editor for a new schedule. */
  newRequest?: number;
  emptyText: string;
  onChanged(): void | Promise<void>;
  /** Told when a dialog of this list opens or closes (so a parent dialog can step aside). */
  onDialogChange?(open: boolean): void;
}

/** Schedules table with run now, edit, pause/resume, history and delete. */
export function ScheduleList({
  schedules,
  settings,
  report,
  reports = NO_REPORTS,
  showReport = false,
  newRequest = 0,
  emptyText,
  onChanged,
  onDialogChange,
  openHistoryFor = null,
}: Props) {
  const [editing, setEditing] = useState<Schedule | null | undefined>(undefined);
  const [history, setHistory] = useState<Schedule | null>(null);
  const [toDelete, setToDelete] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const seen = useRef(newRequest);

  useEffect(() => {
    if (newRequest !== seen.current) {
      seen.current = newRequest;
      setEditing(null);
    }
  }, [newRequest]);

  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!openHistoryFor || opened.current === openHistoryFor) return;
    const s = schedules.find((x) => x.id === openHistoryFor);
    if (!s) return;
    opened.current = openHistoryFor;
    setHistory(s);
  }, [openHistoryFor, schedules]);

  const dialogOpen = editing !== undefined || Boolean(history) || Boolean(toDelete);
  useEffect(() => onDialogChange?.(dialogOpen), [dialogOpen, onDialogChange]);

  const act = async (s: Schedule, fn: () => Promise<unknown>) => {
    setBusy(s.id);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const runNow = (s: Schedule) =>
    act(s, async () => {
      const r = await api.runScheduleNow(s.id);
      const to = r.result.deliveredTo ?? s.recipients;
      setNotice(
        r.result.status === 'SUCCEEDED'
          ? {
              kind: 'success',
              text: `“${s.reportName}” was e-mailed to ${to.join(', ')}.${r.result.skipped?.length ? ` Left out (no access): ${r.result.skipped.join(', ')}.` : ''}`,
            }
          : {
              kind: 'error',
              text: `“${s.reportName}” failed: ${r.result.error ?? 'unknown error'}`,
            },
      );
    });

  const reportFor = (s: Schedule) => report ?? reports.find((r) => r.id === s.reportId) ?? null;

  return (
    <>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {notice && (
        <InlineNotification
          kind={notice.kind}
          lowContrast
          title={notice.text}
          onClose={() => setNotice(null)}
        />
      )}
      {schedules.length === 0 ? (
        <div className="qf-empty">
          <h2>No schedules yet</h2>
          <p>{emptyText}</p>
        </div>
      ) : (
        <TableContainer>
          <Table aria-label="Schedules" size="md">
            <TableHead>
              <TableRow>
                {showReport && <TableHeader>Report</TableHeader>}
                <TableHeader>When</TableHeader>
                <TableHeader>Recipients</TableHeader>
                <TableHeader>Next run</TableHeader>
                <TableHeader>Last run</TableHeader>
                <TableHeader>
                  <span className="cds--visually-hidden">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <tbody>
              {schedules.map((s) => (
                <TableRow key={s.id} data-testid="schedule-row">
                  {showReport && (
                    <TableCell>
                      <Link to={`/reports/${s.reportId}`}>{s.reportName}</Link>
                    </TableCell>
                  )}
                  <TableCell>
                    {s.description}
                    {!s.enabled && (
                      <Tag size="sm" type="warm-gray">
                        Paused
                      </Tag>
                    )}
                    <div className="qf-muted">{s.timezone}</div>
                  </TableCell>
                  <TableCell>{s.recipients.join(', ')}</TableCell>
                  <TableCell>{s.enabled ? formatDateTime(s.nextRunAt) : '—'}</TableCell>
                  <TableCell>
                    <Tag size="sm" type={scheduleStatusTag[s.lastStatus]}>
                      {s.lastStatus === 'NEVER' ? 'Not run yet' : s.lastStatus.toLowerCase()}
                    </Tag>
                    {s.lastRunAt && <div className="qf-muted">{formatDateTime(s.lastRunAt)}</div>}
                    {s.failureCount > 0 && (
                      <span className="qf-muted"> {s.failureCount} failure(s) in a row</span>
                    )}
                    {s.lastError && (
                      <div className={s.lastStatus === 'FAILED' ? 'qf-error-text' : 'qf-muted'}>
                        {s.lastError}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="qf-row-actions">
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={Play}
                      iconDescription="Run now"
                      disabled={busy === s.id || settings?.mailConfigured === false}
                      onClick={() => runNow(s)}
                    />
                    {s.enabled ? (
                      <Button
                        size="sm"
                        kind="ghost"
                        hasIconOnly
                        renderIcon={Pause}
                        iconDescription="Pause schedule"
                        disabled={busy === s.id}
                        onClick={() => act(s, () => api.pauseSchedule(s.id, s.version))}
                      />
                    ) : (
                      <Button
                        size="sm"
                        kind="ghost"
                        hasIconOnly
                        renderIcon={PlayOutline}
                        iconDescription="Resume schedule"
                        disabled={busy === s.id || settings?.mailConfigured === false}
                        onClick={() => act(s, () => api.resumeSchedule(s.id, s.version))}
                      />
                    )}
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
                      renderIcon={RecentlyViewed}
                      iconDescription="Delivery history"
                      onClick={() => setHistory(s)}
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
      {/* dialogs are portalled so they also work when this list sits inside another dialog */}
      {createPortal(
        <>
          <ScheduleEditorModal
            open={editing !== undefined}
            schedule={editing ?? null}
            report={editing ? reportFor(editing) : report}
            reports={reports}
            settings={settings}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              void onChanged();
            }}
          />
          <ScheduleHistoryModal schedule={history} onClose={() => setHistory(null)} />
          <Modal
            open={Boolean(toDelete)}
            danger
            modalHeading="Delete this schedule?"
            primaryButtonText="Delete"
            secondaryButtonText="Cancel"
            onRequestClose={() => setToDelete(null)}
            onRequestSubmit={async () => {
              const s = toDelete;
              setToDelete(null);
              if (s) await act(s, () => api.deleteSchedule(s.id));
            }}
          >
            <p>
              No more e-mails of “{toDelete?.reportName}” will be sent and its delivery history is
              removed. Past runs stay in the report&apos;s run history.
            </p>
          </Modal>
        </>,
        document.body,
      )}
    </>
  );
}
