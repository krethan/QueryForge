import { InlineNotification } from '@carbon/react';
import { ApiError } from '../api/client';

export function describeError(e: unknown): { title: string; subtitle: string } {
  if (e instanceof ApiError) {
    const titles: Record<string, string> = {
      CONNECTION_ERROR: 'Cannot connect to IBM i.',
      TIMEOUT: 'Query timed out.',
      CANCELLED: 'Query cancelled.',
      NOT_AUTHORIZED: 'Not authorized.',
      RATE_LIMITED: 'Too many requests.',
      NETWORK_ERROR: 'Network error.',
    };
    const db = [e.sqlState && `SQLSTATE ${e.sqlState}`, e.sqlCode && `SQLCODE ${e.sqlCode}`]
      .filter(Boolean)
      .join(' · ');
    return {
      title: titles[e.code] ?? (e.status === 400 ? 'Query error.' : 'Request failed.'),
      subtitle: db ? `${e.message} (${db})` : e.message,
    };
  }
  return { title: 'Unexpected error.', subtitle: (e as Error)?.message ?? String(e) };
}

export function ErrorNotice({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  const { title, subtitle } = describeError(error);
  const kind = error instanceof ApiError && error.code === 'CANCELLED' ? 'info' : 'error';
  return (
    <InlineNotification
      kind={kind}
      lowContrast
      title={title}
      subtitle={subtitle}
      hideCloseButton={!onClose}
      onClose={() => {
        onClose?.();
        return false;
      }}
      role="alert"
    />
  );
}
