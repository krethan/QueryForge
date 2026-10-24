import {
  Button,
  InlineLoading,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
} from '@carbon/react';
import { Renew } from '@carbon/icons-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DataSourceInfo } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';

export function DataSourcePage() {
  const [info, setInfo] = useState<DataSourceInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  const load = async (check: boolean) => {
    setChecking(check);
    try {
      setInfo(await api.dataSource(check));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => void load(false), []);

  const rows: [string, string][] = info
    ? [
        ['Name', info.name],
        ['Mapepire server', `${info.host}:${info.port}`],
        [
          'TLS certificate verification',
          info.tlsVerification
            ? info.customCa
              ? 'On (custom CA)'
              : 'On'
            : 'Off — not recommended',
        ],
        ['Reporting user profile', info.reportingUser],
        ['Default schema', info.defaultSchema ?? '—'],
        ['Library list', info.libraries.join(', ') || '—'],
        ['Naming', info.naming.toUpperCase()],
        ['Application metadata schema', info.metadataSchema],
        ['Query timeout', `${(info.limits.queryTimeoutMs / 1000).toFixed(0)} s`],
        ['Max rows displayed', info.limits.maxResultRows.toLocaleString()],
        ['Max rows exported', info.limits.maxExportRows.toLocaleString()],
        [
          'Concurrent executions',
          `${info.activeExecutions} / ${info.limits.maxConcurrentExecutions}`,
        ],
      ]
    : [];

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Data Source</h1>
          <p>Connection settings are configured on the server. Credentials are never shown.</p>
        </div>
        {checking ? (
          <InlineLoading description="Testing connections…" style={{ width: 'auto' }} />
        ) : (
          <Button kind="tertiary" renderIcon={Renew} onClick={() => load(true)}>
            Test connection
          </Button>
        )}
      </div>
      <ErrorNotice error={error} />
      {info?.checks && (
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {Object.entries(info.checks).map(([k, c]) => (
            <Tag key={k} type={c.ok ? 'green' : 'red'} title={c.error}>
              {k === 'metadata' ? 'Metadata (Db2 for i)' : 'Reporting (Db2 for i)'}:{' '}
              {c.ok ? `OK · ${c.ms} ms` : `Failed${c.error ? ` — ${c.error}` : ''}`}
            </Tag>
          ))}
        </div>
      )}
      {info && (
        <StructuredListWrapper aria-label="Data source details">
          <StructuredListBody>
            {rows.map(([k, v]) => (
              <StructuredListRow key={k}>
                <StructuredListCell noWrap>{k}</StructuredListCell>
                <StructuredListCell>{v}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
    </>
  );
}
