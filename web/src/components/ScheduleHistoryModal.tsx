import {
  DataTableSkeleton,
  Modal,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Schedule, ScheduleDelivery } from '../api/types';
import { formatDateTime } from '../utils/format';
import { ErrorNotice } from './ErrorNotice';

interface Props {
  schedule: Schedule | null;
  onClose(): void;
}

/** Recent deliveries of one schedule: when, who triggered it, who got it and what went wrong. */
export function ScheduleHistoryModal({ schedule, onClose }: Props) {
  const [rows, setRows] = useState<ScheduleDelivery[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const id = schedule?.id;

  useEffect(() => {
    if (!id) return;
    let live = true;
    setRows(null);
    setError(null);
    api
      .scheduleDeliveries(id)
      .then((d) => live && setRows(d))
      .catch((e) => {
        if (!live) return;
        setError(e);
        setRows([]);
      });
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <Modal
      open={Boolean(schedule)}
      passiveModal
      size="lg"
      modalHeading="Delivery history"
      modalLabel={schedule?.reportName ?? 'Schedule'}
      onRequestClose={onClose}
    >
      <ErrorNotice error={error} />
      {rows === null ? (
        <DataTableSkeleton columnCount={4} rowCount={3} showToolbar={false} showHeader={false} />
      ) : rows.length === 0 ? (
        <p className="qf-muted">This schedule hasn&apos;t run yet.</p>
      ) : (
        <TableContainer>
          <Table aria-label="Delivery history" size="sm">
            <TableHead>
              <TableRow>
                <TableHeader>Started</TableHeader>
                <TableHeader>Result</TableHeader>
                <TableHeader>Sent to</TableHeader>
                <TableHeader>Details</TableHeader>
              </TableRow>
            </TableHead>
            <tbody>
              {rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    {formatDateTime(d.startedAt)}
                    <div className="qf-muted">
                      {d.trigger === 'MANUAL'
                        ? `Run now${d.requestedByName ? ` by ${d.requestedByName}` : ''}`
                        : 'On schedule'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Tag size="sm" type={d.status === 'SUCCEEDED' ? 'green' : 'red'}>
                      {d.status === 'SUCCEEDED' ? 'Delivered' : 'Failed'}
                    </Tag>
                    {d.rowCount !== null && <div className="qf-muted">{d.rowCount} row(s)</div>}
                  </TableCell>
                  <TableCell>{d.deliveredTo.length ? d.deliveredTo.join(', ') : '—'}</TableCell>
                  <TableCell>
                    {d.skipped.length > 0 && (
                      <div>Left out (no access): {d.skipped.join(', ')}</div>
                    )}
                    {d.status === 'FAILED' && d.error && (
                      <div className="qf-error-text">{d.error}</div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      )}
    </Modal>
  );
}
