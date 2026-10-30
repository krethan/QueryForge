import { Button, InlineLoading } from '@carbon/react';
import { ChartColumnFloating, Renew } from '@carbon/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Report } from '../../api/types';
import { newExecutionId } from '../../utils/format';
import { prepareChart, type PreparedChart } from '../../utils/chartData';
import { LazyChart } from './LazyChart';

type State =
  | { s: 'idle' }
  | { s: 'loading' }
  | { s: 'error'; message: string }
  | { s: 'ready'; prepared: PreparedChart; hasMore: boolean; at: Date };

/**
 * Opt-in live chart on a dashboard tile. Runs the report fresh through the normal
 * execute API (so sharing, row limits and parameter defaults apply exactly as for
 * "Run"); by default only when the user clicks "Load chart".
 */
export function DashboardChart({ report }: { report: Report }) {
  const def = report.chartDef!;
  const [st, setSt] = useState<State>({ s: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setSt({ s: 'loading' });
    try {
      const res = await api.executeReport(report.id, newExecutionId(), ctl.signal);
      // the tile only plots the first page; release any server cursor straight away
      if (res.cursor?.id) void api.closeCursor(res.cursor.id);
      const prepared = prepareChart(
        def,
        res.columns.map((c) => ({ name: c.name, label: c.label, kind: c.kind })),
        res.rows,
      );
      setSt({ s: 'ready', prepared, hasMore: !!res.hasMore, at: new Date() });
    } catch (e) {
      if (ctl.signal.aborted) return;
      const msg = (e as Error).message;
      setSt({
        s: 'error',
        message: /parameter/i.test(msg)
          ? 'This report needs parameter values. Open it to run with your own values.'
          : msg,
      });
    }
  }, [report.id, def]);
  useEffect(() => {
    if (def.dashboardAutoLoad) void load();
    return () => abort.current?.abort();
  }, [def.dashboardAutoLoad, load]);

  return (
    <div className="qf-tile__chart" data-testid="tile-chart">
      {st.s === 'idle' && (
        <Button
          size="sm"
          kind="tertiary"
          renderIcon={ChartColumnFloating}
          onClick={() => void load()}
        >
          Load chart
        </Button>
      )}
      {st.s === 'loading' && <InlineLoading description="Running report…" />}
      {st.s === 'error' && (
        <p className="qf-chart-note" role="alert">
          {st.message}{' '}
          <Button size="sm" kind="ghost" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}
      {st.s === 'ready' && !st.prepared.ok && (
        <p className="qf-chart-note" role="alert">
          {st.prepared.message}
        </p>
      )}
      {st.s === 'ready' && st.prepared.ok && (
        <>
          <LazyChart
            type={def.type}
            points={st.prepared.points}
            keys={st.prepared.keys}
            groups={st.prepared.groups}
            title={def.title}
            xLabel={def.x}
            yLabel={def.y.join(', ')}
            height="220px"
            compact
          />
          <div className="qf-tile__chart-meta">
            <span>
              Live · {st.at.toLocaleTimeString()}
              {st.hasMore ? ' · first page of rows only' : ''}
            </span>
            <Button
              size="sm"
              kind="ghost"
              hasIconOnly
              iconDescription="Refresh chart"
              renderIcon={Renew}
              onClick={() => void load()}
            />
          </div>
        </>
      )}
    </div>
  );
}
