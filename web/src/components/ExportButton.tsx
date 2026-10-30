import { Button, InlineLoading } from '@carbon/react';
import { DocumentExport } from '@carbon/icons-react';
import { useState } from 'react';
import { api } from '../api/client';

interface Props {
  source: Parameters<typeof api.exportXlsx>[0];
  disabled?: boolean;
  onError(msg: string): void;
  onDone?(info: Awaited<ReturnType<typeof api.exportXlsx>>): void;
}

/** Requests a server-generated XLSX (the query is re-executed by the server). */
export function ExportButton({ source, disabled, onError, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  return busy ? (
    <InlineLoading
      description="Preparing Excel file…"
      style={{ width: 'auto', paddingInline: '1rem' }}
    />
  ) : (
    <Button
      kind="ghost"
      size="lg"
      renderIcon={DocumentExport}
      disabled={disabled}
      onClick={async () => {
        setBusy(true);
        try {
          onDone?.(await api.exportXlsx(source));
        } catch (e) {
          onError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Export to Excel
    </Button>
  );
}
