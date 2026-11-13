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
import { TrashCan } from '@carbon/icons-react';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { RetentionRun, RetentionSetting, RetentionState } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorNotice } from '../components/ErrorNotice';
import { formatDateTime } from '../utils/format';

const isForbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

/** "365 days", "1 day" or "Forever". */
export function keptFor(days: number): string {
  if (!(days > 0)) return 'Forever';
  return days === 1 ? '1 day' : `${days} days`;
}

function AdminsOnly() {
  return (
    <div className="qf-empty" role="status">
      <h2>Admins only</h2>
      <p>Only an Uncle Bob administrator can manage data retention.</p>
    </div>
  );
}

/**
 * Admin screen: how long each history table is kept (server settings QF_RETAIN_*, read-only
 * here), what the last prune deleted, and "Run now". The server enforces admin-only (403).
 */
export function RetentionPage() {
  const { user } = useAuth();
  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Data retention</h1>
          <p>
            Old history is deleted automatically so it does not grow for ever. Reports, shares,
            schedules and folders are never deleted here.
          </p>
        </div>
      </div>
      {user?.role === 'ADMIN' ? <RetentionPanel /> : <AdminsOnly />}
    </>
  );
}

function lastDeleted(run: RetentionRun | null, s: RetentionSetting) {
  const t = run?.tables.find((x) => x.key === s.key);
  if (!run || !t) return '—';
  if (t.error) return 'Failed';
  if (!t.cutoff) return 'Kept';
  return `${t.deleted.toLocaleString()}${t.complete ? '' : ' (more left)'}`;
}

export function RetentionPanel() {
  const [state, setState] = useState<RetentionState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<RetentionRun | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getRetention()
      .then((s) => {
        if (live) setState(s);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e);
      });
    return () => {
      live = false;
    };
  }, []);

  const runNow = async () => {
    setConfirming(false);
    setRunning(true);
    setRunError(null);
    setDone(null);
    try {
      const res = await api.runRetention();
      setState(res);
      setDone(res.run);
    } catch (e) {
      setRunError(e);
    } finally {
      setRunning(false);
    }
  };

  if (isForbidden(loadError) || isForbidden(runError)) return <AdminsOnly />;
  if (loadError) return <ErrorNotice error={loadError} />;
  if (!state)
    return (
      <div aria-busy="true" aria-label="Loading data retention">
        <DataTableSkeleton columnCount={4} rowCount={6} showHeader={false} showToolbar={false} />
      </div>
    );

  const last = state.lastRun;
  const failed = last?.tables.filter((t) => t.error) ?? [];
  const nothing = state.settings.every((s) => !(s.days > 0));
  return (
    <div className="qf-retention">
      <ErrorNotice error={runError} onClose={() => setRunError(null)} />
      {done && (
        <InlineNotification
          kind={done.tables.some((t) => t.error) ? 'warning' : 'success'}
          lowContrast
          title="Retention run finished"
          subtitle={`Deleted ${done.deleted.toLocaleString()} old row(s).`}
          onCloseButtonClick={() => setDone(null)}
        />
      )}
      <TableContainer>
        <Table aria-label="Retention settings">
          <TableHead>
            <TableRow>
              <TableHeader>History</TableHeader>
              <TableHeader>Table</TableHeader>
              <TableHeader>Kept for</TableHeader>
              <TableHeader>Deleted last run</TableHeader>
            </TableRow>
          </TableHead>
          <tbody>
            {state.settings.map((s) => (
              <TableRow key={s.key}>
                <TableCell>
                  {s.label}
                  {s.group === 'audit' && (
                    <Tag size="sm" type="purple" className="qf-retention__tag">
                      Audit
                    </Tag>
                  )}
                </TableCell>
                <TableCell>
                  <code>{s.table}</code>
                </TableCell>
                <TableCell>{keptFor(s.days)}</TableCell>
                <TableCell>{lastDeleted(last, s)}</TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </TableContainer>
      <p className="qf-muted qf-retention__note">
        Set on the server with QF_RETAIN_DELIVERY_DAYS, QF_RETAIN_REMINDER_DAYS,
        QF_RETAIN_EXECUTION_DAYS and QF_RETAIN_AUDIT_DAYS (0 keeps rows for ever). Rows are deleted{' '}
        {state.batchSize.toLocaleString()} at a time, up to {state.maxBatches.toLocaleString()}{' '}
        batches per table per run.
      </p>
      <p className="qf-retention__status" role="status" aria-label="Retention status">
        {state.automatic
          ? 'Runs automatically about once a day on the scheduler.'
          : 'Automatic runs are off on this server (its scheduler is not running). Use Run now.'}{' '}
        {last
          ? `Last run ${formatDateTime(last.finishedAt)} (${last.trigger === 'MANUAL' ? `run now${last.requestedBy ? ` by ${last.requestedBy}` : ''}` : 'automatic'}): ${last.deleted.toLocaleString()} row(s) deleted.`
          : 'No run since the server started.'}
      </p>
      {failed.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Some tables could not be pruned"
          subtitle={failed.map((t) => `${t.table}: ${t.error}`).join(' ')}
        />
      )}
      <Button
        kind="danger--tertiary"
        size="md"
        renderIcon={TrashCan}
        disabled={running || state.running || nothing}
        onClick={() => setConfirming(true)}
      >
        {running ? 'Running…' : 'Run now'}
      </Button>
      <Modal
        open={confirming}
        danger
        modalHeading="Delete old history now?"
        primaryButtonText="Delete old history"
        secondaryButtonText="Cancel"
        onRequestClose={() => setConfirming(false)}
        onRequestSubmit={() => void runNow()}
      >
        <p>
          Rows older than the periods above are deleted for good. Tables kept for ever are not
          touched.
        </p>
      </Modal>
    </div>
  );
}
