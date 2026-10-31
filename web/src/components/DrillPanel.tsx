import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  InlineLoading,
  InlineNotification,
  MultiSelect,
} from '@carbon/react';
import { ArrowLeft, Close, DocumentExport } from '@carbon/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type {
  DetailColumn,
  DrillInfo,
  DrillKeys,
  DrillMeta,
  DrillRequest,
  ParameterValues,
  RunResponse,
} from '../api/types';
import { drillFields, drillMode, keysForRow } from '../utils/drill';
import { newExecutionId } from '../utils/format';
import { ResultsTable } from './ResultsTable';

interface Step {
  sourceId: string;
  req: DrillRequest;
  result?: RunResponse;
  meta?: DrillMeta;
  error?: string;
}

export interface DrillPanelProps {
  /** The report the user started from. */
  source: { id: string; name: string };
  info: DrillInfo;
  /** The source report's parameter values from its last run. */
  values?: ParameterValues;
  /** The clicked chart element / row. */
  keys: DrillKeys;
  onClose(): void;
}

const fallbackLabel = (keys: DrillKeys) =>
  Object.values(keys)
    .map((v) => (v === null ? '(empty)' : String(v)))
    .join(' / ');
const colKey = (c: { table: string; column: string }) => `${c.table}.${c.column}`;

/**
 * Side panel with the detail rows behind a clicked chart element or grouped row.
 * Keeps a breadcrumb stack for nested drills (report -> target report -> its detail).
 */
export function DrillPanel({ source, info, values, keys, onClose }: DrillPanelProps) {
  const mode = drillMode(info);
  const [steps, setSteps] = useState<Step[]>(() => [
    { sourceId: source.id, req: { keys, mode: mode ?? undefined, values } },
  ]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [picked, setPicked] = useState<DetailColumn[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const current = steps[steps.length - 1];

  const run = useCallback(async (depth: number, step: Step) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setLoading(true);
    setPicked(null);
    try {
      const r = await api.drill(
        step.sourceId,
        { ...step.req, executionId: newExecutionId() },
        ctl.signal,
      );
      const { drill, ...result } = r;
      setSteps((s) => [...s.slice(0, depth), { ...step, result, meta: drill, error: undefined }]);
    } catch (e) {
      if (ctl.signal.aborted) return;
      setSteps((s) => [
        ...s.slice(0, depth),
        { ...step, result: undefined, meta: undefined, error: (e as Error).message },
      ]);
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, []);

  // first step runs on open
  useEffect(() => {
    void run(0, steps[0]);
    return () => abort.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const back = () => {
    if (steps.length <= 1) return onClose();
    abort.current?.abort();
    setLoading(false);
    setSteps((s) => s.slice(0, -1));
    setPicked(null);
  };
  const goTo = (n: number) => {
    abort.current?.abort();
    setLoading(false);
    setSteps((s) => s.slice(0, n));
    setPicked(null);
  };

  // nested drill: a target report that itself drills somewhere
  const meta = current.meta;
  const nextInfo = meta?.mode === 'target' ? meta.next : null;
  const nextFields = drillFields(nextInfo);
  const onRowClick =
    meta?.mode === 'target' && nextInfo && nextFields && current.result
      ? (row: Parameters<typeof keysForRow>[2]) => {
          const k = keysForRow(nextFields, current.result!.columns, row);
          if (!k) return;
          const step: Step = {
            sourceId: meta.target.id,
            req: { keys: k, mode: drillMode(nextInfo) ?? undefined, values: meta.values },
          };
          setSteps((s) => [...s, step]);
          void run(steps.length, step);
        }
      : undefined;

  const exportRows = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const i = await api.exportDrill(current.sourceId, { ...current.req, executionId: undefined });
      setNotice({
        kind: 'success',
        text: `Exported ${i.rowCount.toLocaleString()} rows to ${i.filename}${i.truncated ? ' (limited)' : ''}.`,
      });
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setExporting(false);
    }
  };

  const sourceNames = [
    source.name,
    ...steps.slice(1).map((s, i) => stepTargetName(steps[i]) ?? s.sourceId),
  ];
  const title =
    meta?.mode === 'target'
      ? `${meta.target.name}`
      : `${sourceNames[steps.length - 1]} · detail rows`;

  return (
    <aside
      className="qf-drill-panel"
      role="dialog"
      aria-label="Drill-down"
      data-testid="drill-panel"
    >
      <div className="qf-drill-panel__head">
        <Breadcrumb noTrailingSlash aria-label="Drill path">
          <BreadcrumbItem
            href="#"
            onClick={(e: React.MouseEvent) => (e.preventDefault(), onClose())}
          >
            {source.name}
          </BreadcrumbItem>
          {steps.map((s, i) => {
            const last = i === steps.length - 1;
            const label = s.meta?.label ?? fallbackLabel(s.req.keys);
            return (
              <BreadcrumbItem
                key={i}
                isCurrentPage={last}
                href={last ? undefined : '#'}
                onClick={
                  last ? undefined : (e: React.MouseEvent) => (e.preventDefault(), goTo(i + 1))
                }
              >
                {label}
              </BreadcrumbItem>
            );
          })}
        </Breadcrumb>
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          iconDescription="Close drill-down"
          renderIcon={Close}
          onClick={onClose}
        />
      </div>
      <h2 className="qf-drill-panel__title">{title}</h2>
      {meta && (
        <p className="qf-chart-note">
          {meta.applied
            .map((a) => `${a.field} = ${a.value === null ? '(empty)' : String(a.value)}`)
            .join(' · ')}
          {meta.mode === 'target' ? ` · drilled from ${meta.sourceName}` : ''}
        </p>
      )}
      <div className="qf-drill-panel__actions">
        <Button kind="secondary" size="sm" renderIcon={ArrowLeft} onClick={back}>
          Back
        </Button>
        {exporting ? (
          <InlineLoading description="Preparing Excel file…" style={{ width: 'auto' }} />
        ) : (
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={DocumentExport}
            disabled={!current.result || loading}
            onClick={() => void exportRows()}
          >
            Export to Excel
          </Button>
        )}
        {loading && <InlineLoading description="Loading detail rows…" style={{ width: 'auto' }} />}
      </div>
      {meta?.mode === 'builder' && (
        <div className="qf-drill-panel__columns">
          <MultiSelect
            id="qf-drill-columns"
            titleText="Detail columns"
            label={`${(picked ?? meta.columns).length} columns`}
            size="sm"
            items={meta.available}
            itemToString={(c: DetailColumn | null) => (c ? (c.label ?? colKey(c)) : '')}
            selectedItems={(picked ?? meta.columns)
              .map((c) => meta.available.find((a) => colKey(a) === colKey(c)))
              .filter(Boolean)}
            onChange={({ selectedItems }: { selectedItems: DetailColumn[] | null }) =>
              setPicked(selectedItems ?? [])
            }
          />
          <Button
            size="sm"
            kind="tertiary"
            disabled={!picked || picked.length === 0 || loading}
            onClick={() => {
              const step: Step = {
                ...current,
                req: {
                  ...current.req,
                  columns: picked!.map((c) => ({ table: c.table, column: c.column })),
                },
              };
              void run(steps.length - 1, step);
            }}
          >
            Apply columns
          </Button>
        </div>
      )}
      {notice && (
        <InlineNotification
          kind={notice.kind}
          lowContrast
          title={notice.text}
          onClose={() => setNotice(null)}
        />
      )}
      {current.error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Could not load the detail rows."
          subtitle={current.error}
        />
      )}
      {current.result && (
        <ResultsTable
          key={steps.length}
          result={current.result}
          onRowClick={onRowClick}
          rowActionLabel={nextInfo?.target ? `Drill to ${nextInfo.target.name}` : undefined}
        />
      )}
    </aside>
  );
}

function stepTargetName(prev: Step): string | undefined {
  return prev.meta?.mode === 'target' ? prev.meta.target.name : undefined;
}
