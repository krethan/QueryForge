import {
  Button,
  Checkbox,
  CodeSnippet,
  ContainedList,
  ContainedListItem,
  InlineLoading,
  InlineNotification,
  Loading,
  Search,
  Select,
  SelectItem,
  Tag,
} from '@carbon/react';
import {
  Add,
  ArrowDown,
  ArrowUp,
  Close,
  Play,
  Save,
  SortAscending,
  SortDescending,
  TableSplit,
} from '@carbon/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type {
  ReportSpec,
  RunResponse,
  SchemaColumn,
  SchemaTable,
  SortDirection,
} from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { ExportButton } from '../components/ExportButton';
import { ResultsTable } from '../components/ResultsTable';
import { SaveReportModal, type SaveValues } from '../components/SaveReportModal';
import { newExecutionId } from '../utils/format';

interface SortRow {
  /** Stable key so React keeps the right <Select> when rows are added or removed. */
  key: string;
  column: string;
  direction: SortDirection;
}

const DEFAULT_LIMIT = 100;

/** Short human sentence describing the current selection, used for hints and the saved name. */
export function describeSelection(spec: ReportSpec): string {
  const cols = spec.columns.length;
  const sorts = spec.sort?.length ?? 0;
  return `${cols} column${cols === 1 ? '' : 's'}${sorts ? `, ${sorts} sort key${sorts === 1 ? '' : 's'}` : ''}`;
}

/**
 * Report Builder: pick a table from the Db2 for i catalog, tick the columns,
 * choose the sort order, and let the *server* build the SELECT. The browser never
 * sends SQL — only names, which the server validates against its cached catalog.
 */
export function ReportBuilderPage() {
  const nav = useNavigate();

  const [search, setSearch] = useState('');
  const [tables, setTables] = useState<SchemaTable[] | null>(null);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [tablesTruncated, setTablesTruncated] = useState(false);
  const [tablesError, setTablesError] = useState<unknown>(null);

  const [selected, setSelected] = useState<SchemaTable | null>(null);
  const [columns, setColumns] = useState<SchemaColumn[] | null>(null);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError] = useState<unknown>(null);

  const [picked, setPicked] = useState<string[]>([]);
  const [sort, setSort] = useState<SortRow[]>([]);

  const [sql, setSql] = useState<string>('');
  const [suggestedName, setSuggestedName] = useState('');
  const [previewing, setPreviewing] = useState(false);

  const [result, setResult] = useState<RunResponse | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const runningRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- table list (searchable, bounded and cached server-side) ----
  useEffect(() => {
    let cancelled = false;
    setTablesLoading(true);
    const t = setTimeout(() => {
      api
        .schemaTables(search, DEFAULT_LIMIT)
        .then((r) => {
          if (cancelled) return;
          setTables(r.tables);
          setTablesTruncated(r.truncated);
          setTablesError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setTables([]);
          setTablesError(e);
        })
        .finally(() => !cancelled && setTablesLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  // ---- columns for the chosen table ----
  useEffect(() => {
    if (!selected) {
      setColumns(null);
      return;
    }
    let cancelled = false;
    setColumnsLoading(true);
    setColumnsError(null);
    setColumns(null);
    setPicked([]);
    setSort([]);
    setResult(null);
    setSql('');
    setError(null);
    setNotice(null);
    api
      .schemaColumns(selected.schema, selected.name)
      .then((r) => {
        if (cancelled) return;
        setColumns(r.columns);
      })
      .catch((e) => !cancelled && setColumnsError(e))
      .finally(() => !cancelled && setColumnsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const spec = useMemo<ReportSpec>(
    () =>
      selected
        ? {
            schema: selected.schema,
            table: selected.name,
            columns: picked,
            sort: sort
              .filter((s) => s.column)
              .map((s) => ({ column: s.column, direction: s.direction })),
          }
        : { schema: '', table: '', columns: [] },
    [selected, picked, sort],
  );

  // ---- live preview: the server builds the SQL for the current selection ----
  useEffect(() => {
    if (!selected || picked.length === 0) {
      setSql('');
      setSuggestedName('');
      setPreviewing(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setPreviewing(true);
    const t = setTimeout(() => {
      api
        .previewReportSql(spec, controller.signal)
        .then((p) => {
          if (cancelled) return;
          setSql(p.sql);
          setSuggestedName(p.name);
        })
        .catch((e) => {
          if (cancelled || (e as Error).name === 'AbortError') return;
          setSql('');
        })
        .finally(() => !cancelled && setPreviewing(false));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
      controller.abort();
    };
  }, [selected, spec, picked.length]);

  const columnNames = useMemo(() => (columns ?? []).map((c) => c.name), [columns]);
  const allSelected = columnNames.length > 0 && picked.length === columnNames.length;

  const toggleColumn = (name: string, on: boolean) => {
    setPicked((prev) => {
      const next = on
        ? prev.includes(name)
          ? prev
          : [...prev, name]
        : prev.filter((c) => c !== name);
      if (!on) setSort((rows) => rows.filter((r) => r.column !== name));
      return next;
    });
    setResult(null);
  };

  const toggleAll = (on: boolean) => {
    setPicked(on ? columnNames : []);
    if (!on) setSort([]);
    setResult(null);
  };

  const move = (name: string, delta: number) => {
    setPicked((prev) => {
      const i = prev.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const addSort = () => {
    const used = new Set(sort.map((s) => s.column));
    const column = picked.find((c) => !used.has(c)) ?? picked[0];
    if (!column) return;
    setSort((rows) => [...rows, { key: newExecutionId(), column, direction: 'ASC' }]);
    setResult(null);
  };

  const run = useCallback(async () => {
    if (runningRef.current || !selected || picked.length === 0) return;
    runningRef.current = true;
    const execId = newExecutionId();
    setRunning(execId);
    setError(null);
    setNotice(null);
    try {
      const r = await api.runReportBuilder(spec, execId);
      setResult(r);
      if (r.builder?.sql) setSql(r.builder.sql);
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      runningRef.current = false;
      setRunning(null);
    }
  }, [selected, picked.length, spec]);

  const cancel = async () => {
    if (!running) return;
    try {
      await api.cancel(running);
    } catch (e) {
      setError(e);
    }
  };

  const save = async (v: SaveValues) => {
    setSaving(true);
    setSaveError(null);
    try {
      const report = await api.createReport({
        name: v.name,
        description: v.description || null,
        category: v.category || null,
        sql,
        parameters: [],
      });
      setSaveOpen(false);
      nav(`/reports/${report.id}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const canRun = Boolean(selected) && picked.length > 0 && !running;
  const pickerHint = !selected
    ? 'Pick a table to see its columns.'
    : columnsLoading
      ? 'Reading columns…'
      : picked.length === 0
        ? 'Tick at least one column.'
        : describeSelection(spec);

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Report Builder</h1>
          <p>
            Choose a table the reporting profile can read, pick the fields, set the sort order, and
            QueryForge builds the read-only SELECT for you.
          </p>
        </div>
        <Tag size="sm" type="gray" renderIcon={TableSplit}>
          From QSYS2 catalog
        </Tag>
      </div>

      <div className="qf-builder">
        <section className="qf-builder__tables" aria-label="Tables">
          <Search
            size="md"
            labelText="Search tables"
            placeholder="Search schema or table"
            value={search}
            onChange={(e: { target: { value: string } }) => setSearch(e.target.value)}
          />
          {tablesLoading && tables === null && <Loading small description="Loading tables" />}
          <ErrorNotice error={tablesError} />
          {tables && (
            <>
              {tablesLoading && (
                <InlineLoading description="Searching catalog…" style={{ width: 'auto' }} />
              )}
              {tables.length === 0 && !tablesError ? (
                <p className="qf-muted">
                  No tables the reporting profile can read match {JSON.stringify(search)}.
                </p>
              ) : (
                <ContainedList
                  label={`${tables.length}${tablesTruncated ? '+' : ''} table${tables.length === 1 ? '' : 's'}${search.trim() ? ' matching' : ''}`}
                  size="sm"
                  className="qf-builder__list"
                >
                  {tables.map((t) => {
                    const active = selected?.schema === t.schema && selected?.name === t.name;
                    return (
                      <ContainedListItem
                        key={`${t.schema}.${t.name}`}
                        onClick={() => setSelected(t)}
                        className={active ? 'qf-builder__item--on' : undefined}
                        renderIcon={TableSplit}
                        action={
                          <Tag size="sm" type={t.type === 'V' ? 'purple' : 'gray'}>
                            {t.typeLabel}
                          </Tag>
                        }
                      >
                        <span className="qf-builder__name">
                          {t.schema}.{t.name}
                        </span>
                        {t.text && <span className="qf-builder__text">{t.text}</span>}
                      </ContainedListItem>
                    );
                  })}
                </ContainedList>
              )}
              {tablesTruncated && (
                <p className="qf-muted">
                  Showing the first {tables.length} matches. Refine the search to narrow the list.
                </p>
              )}
            </>
          )}
        </section>

        <section className="qf-builder__fields" aria-label="Fields and sorting">
          {!selected && <p className="qf-empty">{pickerHint}</p>}
          {selected && (
            <>
              <h2 className="qf-section__title" style={{ marginTop: 0 }}>
                {selected.schema}.{selected.name}{' '}
                <Tag size="sm" type={selected.type === 'V' ? 'purple' : 'gray'}>
                  {selected.typeLabel}
                </Tag>
              </h2>
              {selected.text && <p className="qf-muted">{selected.text}</p>}
              <ErrorNotice error={columnsError} />
              {columnsLoading && <Loading small description="Loading columns" />}
              {columns && (
                <div className="qf-two-col">
                  <fieldset className="qf-fieldset">
                    <legend>
                      Columns ({picked.length} of {columns.length})
                    </legend>
                    <Checkbox
                      id="qb-select-all"
                      labelText="Select all"
                      checked={allSelected}
                      indeterminate={picked.length > 0 && !allSelected}
                      onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                        toggleAll(checked)
                      }
                    />
                    <div className="qf-builder__columns">
                      {columns.map((c) => (
                        <Checkbox
                          key={c.name}
                          id={`qb-col-${c.name}`}
                          labelText={
                            <span className="qf-builder__col-label">
                              <span className="qf-builder__mono">{c.name}</span>{' '}
                              <span className="qf-muted">
                                {c.displayType}
                                {c.nullable ? '' : ' · not null'}
                              </span>
                              {c.text && <span className="qf-builder__text">{c.text}</span>}
                            </span>
                          }
                          checked={picked.includes(c.name)}
                          onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                            toggleColumn(c.name, checked)
                          }
                        />
                      ))}
                    </div>
                  </fieldset>

                  <div>
                    <h3 className="qf-builder__h3">Field order</h3>
                    {picked.length === 0 ? (
                      <p className="qf-muted">Selected columns appear here in SELECT order.</p>
                    ) : (
                      <ol className="qf-builder__order">
                        {picked.map((name, i) => (
                          <li key={name}>
                            <span className="qf-builder__mono">
                              {i + 1}. {name}
                            </span>
                            <span className="qf-builder__row-actions">
                              <Button
                                kind="ghost"
                                size="sm"
                                hasIconOnly
                                renderIcon={ArrowUp}
                                iconDescription={`Move ${name} up`}
                                disabled={i === 0}
                                onClick={() => move(name, -1)}
                              />
                              <Button
                                kind="ghost"
                                size="sm"
                                hasIconOnly
                                renderIcon={ArrowDown}
                                iconDescription={`Move ${name} down`}
                                disabled={i === picked.length - 1}
                                onClick={() => move(name, 1)}
                              />
                              <Button
                                kind="ghost"
                                size="sm"
                                hasIconOnly
                                renderIcon={Close}
                                iconDescription={`Remove ${name}`}
                                onClick={() => toggleColumn(name, false)}
                              />
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}

                    <h3 className="qf-builder__h3">
                      <SortAscending size={16} /> Sort order
                    </h3>
                    {sort.length === 0 && (
                      <p className="qf-muted">
                        No sort order: rows come back in the table&apos;s own order.
                      </p>
                    )}
                    <div className="qf-builder__sorts">
                      {sort.map((row, i) => (
                        <div className="qf-builder__sort-row" key={row.key}>
                          <Select
                            id={`qb-sort-col-${row.key}`}
                            labelText={`Sort ${i + 1} column`}
                            size="sm"
                            value={row.column}
                            onChange={(e: { target: { value: string } }) =>
                              setSort((rows) =>
                                rows.map((r) =>
                                  r.key === row.key ? { ...r, column: e.target.value } : r,
                                ),
                              )
                            }
                          >
                            {picked.map((c) => (
                              <SelectItem key={c} value={c} text={c} />
                            ))}
                          </Select>
                          <Select
                            id={`qb-sort-dir-${row.key}`}
                            labelText="Direction"
                            size="sm"
                            value={row.direction}
                            onChange={(e: { target: { value: string } }) =>
                              setSort((rows) =>
                                rows.map((r) =>
                                  r.key === row.key
                                    ? { ...r, direction: e.target.value as SortDirection }
                                    : r,
                                ),
                              )
                            }
                          >
                            <SelectItem value="ASC" text="Ascending" />
                            <SelectItem value="DESC" text="Descending" />
                          </Select>
                          <Button
                            kind="ghost"
                            size="sm"
                            hasIconOnly
                            renderIcon={Close}
                            iconDescription={`Remove sort ${i + 1}`}
                            onClick={() => setSort((rows) => rows.filter((r) => r.key !== row.key))}
                          />
                        </div>
                      ))}
                    </div>
                    <Button
                      kind="ghost"
                      size="sm"
                      renderIcon={Add}
                      disabled={picked.length === 0 || sort.length >= picked.length}
                      onClick={addSort}
                    >
                      Add sort column
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {selected && (
        <section className="qf-section" aria-label="SQL preview">
          <h2>
            SQL preview{' '}
            {previewing && <InlineLoading description="Building SQL" style={{ width: 'auto' }} />}
          </h2>
          {sql ? (
            <CodeSnippet type="multi" wrapText feedback="Copied" aria-label="Built SQL">
              {sql}
            </CodeSnippet>
          ) : (
            <p className="qf-muted">
              {picked.length === 0
                ? 'Choose at least one column to see the SELECT statement.'
                : 'The server could not build a statement for this selection.'}
            </p>
          )}
          {sql && (
            <p className="qf-muted">
              <SortDescending size={16} /> Built and validated on the server from the catalog;
              identifiers are double-quoted and schema-qualified.
            </p>
          )}
        </section>
      )}

      <div className="qf-editor-actions">
        <Button renderIcon={Play} onClick={run} disabled={!canRun || !sql} aria-label="Run report">
          Run
        </Button>
        {running && (
          <>
            <InlineLoading description="Running on IBM i…" style={{ width: 'auto' }} />
            <Button kind="danger--tertiary" onClick={cancel}>
              Cancel
            </Button>
          </>
        )}
        <Button
          kind="secondary"
          renderIcon={Save}
          disabled={!sql || Boolean(running) || previewing}
          onClick={() => {
            setSaveError(null);
            setSaveOpen(true);
          }}
        >
          Save as report
        </Button>
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
                source={{ sql, name: suggestedName || selected?.name || 'Report' }}
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
        title="Save as report"
        initial={{
          name: suggestedName || (selected ? selected.name : ''),
          description: selected
            ? `Built with Report Builder from ${selected.schema}.${selected.name}.`
            : '',
          category: '',
        }}
        saving={saving}
        error={saveError}
        onClose={() => {
          setSaveOpen(false);
          setSaveError(null);
        }}
        onSave={save}
      />
    </>
  );
}
