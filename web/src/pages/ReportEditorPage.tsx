import { Button, InlineLoading, InlineNotification, Loading, Modal, Tag } from '@carbon/react';
import {
  DataTable as DataTableIcon,
  Erase,
  Play,
  Save,
  Share as ShareIcon,
  StopFilled,
  Time,
} from '@carbon/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type {
  Cell,
  DrillKeys,
  ParameterDef,
  ParameterValues,
  Report,
  RunResponse,
  ScheduleSettings,
} from '../api/types';
import { ParameterEditor } from '../components/ParameterEditor';
import { RunParamsModal } from '../components/RunParamsModal';
import { ScheduleEditorModal } from '../components/ScheduleEditorModal';
import { ShareModal } from '../components/ShareModal';
import { ErrorNotice } from '../components/ErrorNotice';
import { ExportButton } from '../components/ExportButton';
import { ResultsTable } from '../components/ResultsTable';
import { ChartPanel } from '../components/charts/ChartPanel';
import type { ChartDef, ChartView } from '../utils/chartData';
import { SaveReportModal, type SaveValues } from '../components/SaveReportModal';
import { SqlEditor } from '../components/SqlEditor';
import { newExecutionId } from '../utils/format';
import { DrillPanel } from '../components/DrillPanel';
import { DrillSettings } from '../components/DrillSettings';
import { decodeDrill, drillFields, keysForRow } from '../utils/drill';

export function ReportEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const autoRan = useRef(false);
  const nav = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState<string | null>(null);
  const runningRef = useRef(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [defs, setDefs] = useState<ParameterDef[]>([]);
  const [askParams, setAskParams] = useState(false);
  const [paramErrors, setParamErrors] = useState<Record<string, string> | null>(null);
  const [lastValues, setLastValues] = useState<ParameterValues | undefined>(undefined);
  const [shareOpen, setShareOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedSettings, setSchedSettings] = useState<ScheduleSettings | null>(null);
  const [chart, setChart] = useState<ChartDef | null>(null);
  const [view, setView] = useState<ChartView>('table');
  const [loadedRows, setLoadedRows] = useState<{ rows: Cell[][]; hasMore: boolean }>({
    rows: [],
    hasMore: false,
  });

  const [drill, setDrill] = useState<{ keys: DrillKeys; n: number } | null>(null);
  const openDrill = (keys: DrillKeys) => setDrill((d) => ({ keys, n: (d?.n ?? 0) + 1 }));
  const access = report?.access ?? 'OWNER';
  const canEdit = access !== 'VIEWER';
  const defsChanged = JSON.stringify(defs) !== JSON.stringify(report?.parameters ?? []);
  const dirty = canEdit && (report ? sql !== report.sql || defsChanged : sql.trim().length > 0);
  // drill runs the saved definition, so it is off while there are unsaved edits
  const fields = report && !dirty ? drillFields(report.drill) : null;

  useEffect(() => {
    if (!id) {
      setReport(null);
      setSql('');
      setDefs([]);
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getReport(id)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setSql(r.sql);
        setDefs(r.parameters ?? []);
        setChart(r.chartDef ?? null);
        setView(r.chartDef ? (r.chartDef.view ?? 'both') : 'table');
        setError(null);
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const runWith = useCallback(
    async (values?: ParameterValues) => {
      if (runningRef.current || !sql.trim()) return; // duplicate-click guard
      runningRef.current = true;
      setParamErrors(null);
      const execId = newExecutionId();
      setRunning(execId);
      setError(null);
      setNotice(null);
      try {
        // A clean saved report is re-executed from its stored definition; otherwise run the editor text.
        const r =
          report && !dirty
            ? await api.executeReport(report.id, execId, undefined, values)
            : await api.execute(sql, execId, undefined, { parameters: defs, values: values ?? {} });
        setResult(r);
        setAskParams(false);
        setLastValues(values);
        if (report && !dirty)
          setReport((p) =>
            p
              ? {
                  ...p,
                  lastExecutedAt: r.completedAt,
                  lastRowCount: r.rowCount,
                  lastStatus: 'SUCCEEDED',
                }
              : p,
          );
      } catch (e) {
        if (askParams && e instanceof ApiError && e.fields) {
          setParamErrors(e.fields);
          return;
        }
        setAskParams(false);
        setError(e);
        if (!(e instanceof ApiError && e.code === 'CANCELLED')) setResult(null);
      } finally {
        runningRef.current = false;
        setRunning(null);
      }
    },
    [sql, report, dirty, defs, askParams],
  );

  // Parameterized reports show the Carbon run form first.
  const run = useCallback(() => {
    if (defs.some((d) => !d.fixed)) setAskParams(true);
    else void runWith();
  }, [defs, runWith]);

  // Auto-run when opened from a dashboard "Run" action.
  useEffect(() => {
    const fromDash = report ? decodeDrill(params.get('drill')) : null;
    if (report && (params.get('run') === '1' || fromDash) && !autoRan.current) {
      autoRan.current = true;
      const allowed = new Set(drillFields(report.drill)?.map((f) => f.toUpperCase()) ?? []);
      const keys = Object.fromEntries(
        Object.entries(fromDash ?? {}).filter(([k]) => allowed.has(k.toUpperCase())),
      );
      if (Object.keys(keys).length) openDrill(keys);
      // Drop ?run=1 without a router navigation so a reload doesn't re-run it.
      window.history.replaceState(window.history.state, '', window.location.pathname);
      void run();
    }
  }, [report]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async () => {
    if (!running) return;
    try {
      await api.cancel(running);
    } catch (e) {
      setError(e);
    }
  };

  // Warn about unsaved changes on navigation and on tab close.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !saving && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = async (v: SaveValues) => {
    setSaving(true);
    setSaveError(null);
    try {
      const input = {
        name: v.name,
        description: v.description || null,
        category: v.category || null,
        sql,
        parameters: defs,
      };
      const saved = report
        ? await api.updateReport(report.id, { ...input, version: report.version })
        : await api.createReport(input);
      setReport(saved);
      // refresh the drill options for the saved definition
      void api
        .getReport(saved.id)
        .then((r) => setReport((p) => (p?.id === r.id ? { ...p, drill: r.drill } : p)))
        .catch(() => undefined);
      setSql(saved.sql);
      setDefs(saved.parameters ?? []);
      setSaveOpen(false);
      setNotice(`Saved "${saved.name}".`);
      if (!report) nav(`/reports/${saved.id}`, { replace: true });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // the export draws the chart the user is looking at (unsaved edits included)
  const chartSource = view !== 'table' && chart ? { chart: { ...chart, view } } : {};

  if (loading) return <Loading description="Loading report" withOverlay={false} />;
  if (id && !report && error) return <ErrorNotice error={error} />;

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1 id="editor-title">{report ? report.name : 'New Report'}</h1>
          <p>
            {report && access !== 'OWNER' && (
              <Tag size="sm" type="purple">
                Shared with you · {access === 'EDITOR' ? 'Editor' : 'Viewer'}
                {report.ownerName ? ` · owner ${report.ownerName}` : ''}
              </Tag>
            )}{' '}
            {report?.description ?? 'Write a single read-only SELECT, WITH or VALUES statement.'}
            {dirty && (
              <span className="qf-dirty">
                {' '}
                <Tag size="sm" type="warm-gray">
                  Unsaved changes
                </Tag>
              </span>
            )}
          </p>
        </div>
        {report?.builderDef && (
          <div>
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={DataTableIcon}
              disabled={report.builder?.valid === false}
              onClick={() => nav(`/report-builder?report=${encodeURIComponent(report.id)}`)}
            >
              Open in Report Builder
            </Button>
            {report.builder?.valid === false && (
              <div className="qf-error-text" role="alert">
                The saved builder definition no longer matches the catalog: {report.builder.error}
              </div>
            )}
          </div>
        )}
      </div>
      <SqlEditor
        labelId="editor-title"
        value={sql}
        onChange={setSql}
        onRun={run}
        readOnly={Boolean(running) || !canEdit}
      />
      {(canEdit || defs.length > 0) && (
        <details className="qf-params-panel" open={defs.length > 0}>
          <summary>Parameters{defs.length ? ` (${defs.length})` : ''}</summary>
          <ParameterEditor
            sql={sql}
            value={defs}
            onChange={setDefs}
            readOnly={!canEdit || Boolean(running)}
          />
        </details>
      )}
      {report && canEdit && (
        <details className="qf-params-panel" open={!!report.drillDef}>
          <summary>Drill-down{report.drillDef ? ' (target set)' : ''}</summary>
          <DrillSettings
            report={report}
            fields={[
              ...new Set([
                ...(report.drill?.builder?.fields ?? []),
                ...(result?.columns.map((c) => c.name) ?? []),
              ]),
            ]}
            onSaved={(r) =>
              setReport((p) => (p ? { ...p, drillDef: r.drillDef, drill: r.drill } : p))
            }
          />
        </details>
      )}
      <div className="qf-editor-actions">
        <Button renderIcon={Play} onClick={run} disabled={Boolean(running) || !sql.trim()}>
          Run
        </Button>
        {running && (
          <>
            <InlineLoading description="Running on IBM i…" style={{ width: 'auto' }} />
            <Button kind="danger--tertiary" renderIcon={StopFilled} onClick={cancel}>
              Cancel
            </Button>
          </>
        )}
        {canEdit && (
          <Button
            kind="secondary"
            renderIcon={Save}
            onClick={() => setSaveOpen(true)}
            disabled={!sql.trim() || Boolean(running)}
          >
            {report ? 'Save' : 'Save as report'}
          </Button>
        )}
        {report && access === 'OWNER' && (
          <Button kind="tertiary" renderIcon={ShareIcon} onClick={() => setShareOpen(true)}>
            Share
          </Button>
        )}
        {report && canEdit && (
          <Button
            kind="tertiary"
            renderIcon={Time}
            disabled={dirty}
            onClick={async () => {
              setSchedSettings(await api.scheduleSettings().catch(() => null));
              setSchedOpen(true);
            }}
          >
            Schedule
          </Button>
        )}
        <Button
          kind="ghost"
          renderIcon={Erase}
          disabled={Boolean(running) || !canEdit}
          onClick={() => {
            setSql('');
            setResult(null);
            setError(null);
          }}
        >
          Clear
        </Button>
        <span style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)' }}>
          Ctrl/⌘ + Enter to run
        </span>
      </div>
      {notice && (
        <InlineNotification
          kind="success"
          lowContrast
          title={notice}
          onClose={() => setNotice(null)}
        />
      )}
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {result && (
        <section className="qf-section" aria-label="Results">
          <ChartPanel
            columns={result.columns}
            rows={loadedRows.rows}
            hasMore={loadedRows.hasMore}
            def={chart}
            onChange={setChart}
            view={view}
            onViewChange={setView}
            saved={report?.chartDef ?? null}
            storedError={report?.chartError}
            drillFields={fields}
            onDrill={openDrill}
            onSave={
              report && canEdit
                ? async (def) => {
                    const r = await api.setReportChart(report.id, def);
                    setReport((p) =>
                      p ? { ...p, chartDef: r.chartDef ?? null, chartError: undefined } : p,
                    );
                    if (!def) setChart(null);
                  }
                : undefined
            }
            saveHint={
              report
                ? 'You have view access, so the chart is not saved.'
                : 'Save the report to keep this chart.'
            }
            table={
              <ResultsTable
                result={result}
                onRowsChange={(rows, hasMore) => setLoadedRows({ rows, hasMore })}
                onRowClick={
                  fields
                    ? (row) => {
                        const k = keysForRow(fields, result.columns, row);
                        if (k) openDrill(k);
                      }
                    : undefined
                }
                rowActionLabel={
                  report?.drill?.target
                    ? `Open ${report.drill.target.name} for this row`
                    : 'Show the detail rows behind this row'
                }
                toolbar={
                  <ExportButton
                    source={
                      report && !dirty
                        ? { reportId: report.id, values: lastValues, ...chartSource }
                        : {
                            ...chartSource,
                            sql,
                            name: report?.name ?? 'Query results',
                            ...(defs.length ? { parameters: defs, values: lastValues ?? {} } : {}),
                          }
                    }
                    disabled={Boolean(running)}
                    onError={(m) => setError(new ApiError(500, 'EXPORT_FAILED', m))}
                    onDone={(i) =>
                      setNotice(
                        `Exported ${i.rowCount.toLocaleString()} rows to ${i.filename}${i.truncated ? ' (limited)' : ''}.` +
                          (i.chart?.included ? ' The chart is on the Chart sheet.' : '') +
                          (i.chart?.note ? ` Chart not included: ${i.chart.note}` : ''),
                      )
                    }
                  />
                }
              />
            }
          />
        </section>
      )}
      {drill && report?.drill && (
        <DrillPanel
          key={drill.n}
          source={{ id: report.id, name: report.name }}
          info={report.drill}
          values={lastValues}
          keys={drill.keys}
          onClose={() => setDrill(null)}
        />
      )}
      <SaveReportModal
        open={saveOpen}
        title={report ? 'Save report' : 'Save as report'}
        initial={{
          name: report?.name ?? '',
          description: report?.description ?? '',
          category: report?.category ?? '',
        }}
        saving={saving}
        error={saveError}
        onClose={() => {
          setSaveOpen(false);
          setSaveError(null);
        }}
        onSave={save}
      />
      <RunParamsModal
        open={askParams}
        title={`Run ${report?.name ?? 'query'}`}
        parameters={defs}
        initial={lastValues}
        serverErrors={paramErrors}
        primaryText={running ? 'Running…' : 'Run'}
        onClose={() => setAskParams(false)}
        onSubmit={(v) => void runWith(v)}
      />
      {shareOpen && report && <ShareModal report={report} onClose={() => setShareOpen(false)} />}
      <ScheduleEditorModal
        open={schedOpen}
        schedule={null}
        report={report}
        settings={schedSettings}
        onClose={() => setSchedOpen(false)}
        onSaved={() => {
          setSchedOpen(false);
          setNotice('Schedule saved. Manage it on the Schedules page.');
        }}
      />
      <Modal
        open={blocker.state === 'blocked'}
        danger
        modalHeading="Discard unsaved changes?"
        primaryButtonText="Discard and leave"
        secondaryButtonText="Stay on this page"
        onRequestClose={() => blocker.reset?.()}
        onRequestSubmit={() => blocker.proceed?.()}
      >
        <p>Your SQL has changes that have not been saved to this report.</p>
      </Modal>
    </>
  );
}
