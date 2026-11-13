import { InlineLoading, Modal, Tag } from '@carbon/react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Report, ReportAccess, ShareAuditEvent } from '../api/types';
import { formatDateTime } from '../utils/format';
import { ErrorNotice } from './ErrorNotice';
import { describeExpiryChange, formatLastDay, isExpired, untilText } from '../utils/expiry';

const roleLabel = (r: string | null) =>
  r === 'EDITOR' ? 'Editor' : r === 'VIEWER' ? 'Viewer' : '';

export function describeEvent(e: ShareAuditEvent): string {
  const who =
    e.principalType === 'GROUP' ? `group ${e.principalId}` : (e.principalName ?? e.principalId);
  const actor = e.actorName ?? e.actorId;
  if (e.action === 'EXPIRY')
    return describeExpiryChange(who, actor, e.oldExpiresAt, e.newExpiresAt);
  const until = e.newExpiresAt ? ` until ${formatLastDay(e.newExpiresAt)}` : '';
  if (e.action === 'GRANT')
    return `${actor} granted ${roleLabel(e.newRole)} access to ${who}${until}`;
  if (e.action === 'REVOKE') return `${actor} revoked ${roleLabel(e.oldRole)} access from ${who}`;
  return `${actor} changed ${who} from ${roleLabel(e.oldRole)} to ${roleLabel(e.newRole)}${until}`;
}

/** Audit action tag text and colour (EXPIRY: an end date set, changed or removed). */
export const auditActionTag = (action: ShareAuditEvent['action']) =>
  action === 'GRANT'
    ? { type: 'green' as const, text: 'Granted' }
    : action === 'REVOKE'
      ? { type: 'red' as const, text: 'Revoked' }
      : action === 'EXPIRY'
        ? { type: 'magenta' as const, text: 'End date' }
        : { type: 'cyan' as const, text: 'Changed' };

/** A current share's end date: an Expired tag, "until …", or nothing. */
export function ShareUntil({ expiresAt }: { expiresAt?: string | null }) {
  if (isExpired(expiresAt))
    return (
      <>
        {' '}
        <Tag size="sm" type="red">
          Expired
        </Tag>
      </>
    );
  const text = untilText(expiresAt);
  return text ? <span className="qf-muted"> {text}</span> : null;
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
                <ShareUntil expiresAt={s.expiresAt} />
              </li>
            ))}
            {(data.folderGrants ?? []).map((g) => (
              <li key={`folder:${g.folderId}:${g.type}:${g.id}`}>
                {g.type === 'GROUP' ? `Group ${g.id}` : (g.displayName ?? g.id)}{' '}
                <Tag size="sm" type={g.role === 'EDITOR' ? 'purple' : 'gray'}>
                  {roleLabel(g.role)}
                </Tag>{' '}
                <span className="qf-muted">through folder {g.folderName}</span>
              </li>
            ))}
            {data.shares.length === 0 && !data.folderGrants?.length && (
              <li>Not shared with anyone.</li>
            )}
          </ul>
          <h3 className="qf-modal-subheading">Sharing history</h3>
          {data.events.length === 0 ? (
            <p>No sharing changes recorded.</p>
          ) : (
            <ol className="qf-audit-list" aria-label="Sharing history">
              {data.events.map((e) => (
                <li key={e.id}>
                  <Tag size="sm" type={auditActionTag(e.action).type}>
                    {auditActionTag(e.action).text}
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
