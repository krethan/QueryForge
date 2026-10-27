import { InlineLoading, Modal, Tag } from '@carbon/react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Report, ReportAccess, ShareAuditEvent } from '../api/types';
import { formatDateTime } from '../utils/format';
import { ErrorNotice } from './ErrorNotice';

const roleLabel = (r: string | null) =>
  r === 'EDITOR' ? 'Editor' : r === 'VIEWER' ? 'Viewer' : '';

export function describeEvent(e: ShareAuditEvent): string {
  const who =
    e.principalType === 'GROUP' ? `group ${e.principalId}` : (e.principalName ?? e.principalId);
  const actor = e.actorName ?? e.actorId;
  if (e.action === 'GRANT') return `${actor} granted ${roleLabel(e.newRole)} access to ${who}`;
  if (e.action === 'REVOKE') return `${actor} revoked ${roleLabel(e.oldRole)} access from ${who}`;
  return `${actor} changed ${who} from ${roleLabel(e.oldRole)} to ${roleLabel(e.newRole)}`;
}

/** Owner-only panel: who can open the report now, and the share grant / change / revoke trail. */
export function AccessAuditModal({ report, onClose }: { report: Report; onClose(): void }) {
  const [data, setData] = useState<ReportAccess | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api
      .getAccess(report.id)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [report.id]);

  return (
    <Modal
      open
      passiveModal
      size="md"
      modalHeading={`Access and audit · ${report.name}`}
      onRequestClose={onClose}
    >
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {!data && !error && <InlineLoading description="Loading access…" />}
      {data && (
        <>
          <h3 className="qf-modal-subheading">Current access</h3>
          <ul className="qf-audit-list" aria-label="Current access">
            <li>
              {data.owner.displayName}{' '}
              <Tag size="sm" type="blue">
                Owner
              </Tag>
            </li>
            {data.shares.map((s) => (
              <li key={`${s.type}:${s.id}`}>
                {s.type === 'GROUP' ? `Group ${s.id}` : (s.displayName ?? s.id)}{' '}
                <Tag size="sm" type={s.role === 'EDITOR' ? 'purple' : 'gray'}>
                  {roleLabel(s.role)}
                </Tag>
              </li>
            ))}
            {data.shares.length === 0 && <li>Not shared with anyone.</li>}
          </ul>
          <h3 className="qf-modal-subheading">Sharing history</h3>
          {data.events.length === 0 ? (
            <p>No sharing changes recorded.</p>
          ) : (
            <ol className="qf-audit-list" aria-label="Sharing history">
              {data.events.map((e) => (
                <li key={e.id}>
                  <Tag
                    size="sm"
                    type={e.action === 'GRANT' ? 'green' : e.action === 'REVOKE' ? 'red' : 'cyan'}
                  >
                    {e.action === 'GRANT'
                      ? 'Granted'
                      : e.action === 'REVOKE'
                        ? 'Revoked'
                        : 'Changed'}
                  </Tag>{' '}
                  {describeEvent(e)}
                  <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Modal>
  );
}
