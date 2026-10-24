import { Button, InlineLoading, InlineNotification, Loading, Modal, Tag } from '@carbon/react';
import { Erase, Play, Save, StopFilled } from '@carbon/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { Report, RunResponse } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { ExportButton } from '../components/ExportButton';
import { ResultsTable } from '../components/ResultsTable';
import { SaveReportModal, type SaveValues } from '../components/SaveReportModal';
import { SqlEditor } from '../components/SqlEditor';
import { newExecutionId } from '../utils/format';

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

  const dirty = report ? sql !== report.sql : sql.trim().length > 0;

  useEffect(() => {
    if (!id) {
      setReport(null);
      setSql('');
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
        setError(null);
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const run = useCallback(async () => {
    if (runningRef.current || !sql.trim()) return; // duplicate-click guard
    runningRef.current = true;
    const execId = newExecutionId();
    setRunning(execId);
    setError(null);
    setNotice(null);
    try {
      // A clean saved report is re-executed from its stored definition; otherwise run the editor text.
      const r =
        report && !dirty
          ? await api.executeReport(report.id, execId)
          : await api.execute(sql, execId);
      setResult(r);
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
      setError(e);
      if (!(e instanceof ApiError && e.code === 'CANCELLED')) setResult(null);
    } finally {
      runningRef.current = false;
      setRunning(null);
    }
  }, [sql, report, dirty]);

  // Auto-run when opened from a dashboard "Run" action.
  useEffect(() => {
    if (report && params.get('run') === '1' && !autoRan.current) {
      autoRan.current = true;
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
      };
      const saved = report
        ? await api.updateReport(report.id, { ...input, version: report.version })
        : await api.createReport(input);
      setReport(saved);
      setSql(saved.sql);
      setSaveOpen(false);
      setNotice(`Saved "${saved.name}".`);
      if (!report) nav(`/reports/${saved.id}`, { replace: true });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading description="Loading report" withOverlay={false} />;
  if (id && !report && error) return <ErrorNotice error={error} />;

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1 id="editor-title">{report ? report.name : 'New Report'}</h1>
          <p>
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
      </div>
      <SqlEditor
        labelId="editor-title"
        value={sql}
        onChange={setSql}
        onRun={run}
        readOnly={Boolean(running)}
      />
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
        <Button
          kind="secondary"
          renderIcon={Save}
          onClick={() => setSaveOpen(true)}
          disabled={!sql.trim() || Boolean(running)}
        >
          {report ? 'Save' : 'Save as report'}
        </Button>
        <Button
          kind="ghost"
          renderIcon={Erase}
          disabled={Boolean(running)}
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
          <ResultsTable
            result={result}
            toolbar={
              <ExportButton
                source={
                  report && !dirty
                    ? { reportId: report.id }
                    : { sql, name: report?.name ?? 'Query results' }
                }
                disabled={Boolean(running)}
                onError={(m) => setError(new ApiError(500, 'EXPORT_FAILED', m))}
                onDone={(i) =>
                  setNotice(
                    `Exported ${i.rowCount.toLocaleString()} rows to ${i.filename}${i.truncated ? ' (limited)' : ''}.`,
                  )
                }
              />
            }
          />
        </section>
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
