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
  SelectItemGroup,
  Tag,
  TextInput,
} from '@carbon/react';
import {
  Add,
  ArrowDown,
  ArrowUp,
  Close,
  Connect,
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
  JoinSuggestion,
  JoinType,
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

/** The base table is always `BASE`; joined tables get a generated key. */
const BASE = 'base';
export const MAX_JOINS = 8;
const ALIAS_RE = /^[A-Z][A-Z0-9_]{0,9}$/;

/** A column of one of the report's tables, by table *key* (aliases can be renamed). */
interface ColPick {
  src: string;
  column: string;
}

interface SortRow extends ColPick {
  /** Stable key so React keeps the right <Select> when rows are added or removed. */
  key: string;
  direction: SortDirection;
}

interface CondRow {
  key: string;
  /** `${srcKey}|${column}` of a table added earlier ('' until chosen). */
  left: string;
  right: string;
}

interface JoinedTable {
  key: string;
  table: SchemaTable;
  /** User-chosen alias; '' means the positional default (T2, T3, …). */
  alias: string;
  type: JoinType;
  on: CondRow[];
  columns: SchemaColumn[] | null;
  error: unknown;
  suggestions: JoinSuggestion[] | null;
  /** Label of the suggestion currently applied, if the user has not edited it. */
  applied: string | null;
}

export const JOIN_TYPE_LABELS: Record<JoinType, string> = {
  INNER: 'Inner join',
  LEFT: 'Left outer join',
  RIGHT: 'Right outer join',
  FULL: 'Full outer join',
};

const pickKey = (p: ColPick) => `${p.src}|${p.column}`;
const splitKey = (k: string): ColPick => {
  const i = k.indexOf('|');
  return { src: k.slice(0, i), column: k.slice(i + 1) };
};

const DEFAULT_LIMIT = 100;

/** Short human sentence describing the current selection, used for hints and the saved name. */
export function describeSelection(spec: ReportSpec): string {
  const cols = spec.columns.length;
  const sorts = spec.sort?.length ?? 0;
  const tables = (spec.joins?.length ?? 0) + 1;
  return `${cols} column${cols === 1 ? '' : 's'}${tables > 1 ? ` from ${tables} tables` : ''}${sorts ? `, ${sorts} sort key${sorts === 1 ? '' : 's'}` : ''}`;
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

  const [joins, setJoins] = useState<JoinedTable[]>([]);
  const [picked, setPicked] = useState<ColPick[]>([]);
  const [sort, setSort] = useState<SortRow[]>([]);
  const [joinChoice, setJoinChoice] = useState('');
  const [joinType, setJoinType] = useState<JoinType>('INNER');

  const [sql, setSql] = useState<string>('');
  const [suggestedName, setSuggestedName] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

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
    setJoins([]);
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

  /** Alias per table key: T1 for the base, the chosen or positional alias for joins. */
  const aliasOf = useCallback(
    (key: string) => {
      if (key === BASE) return 'T1';
      const i = joins.findIndex((j) => j.key === key);
      return i < 0 ? '?' : joins[i].alias || `T${i + 2}`;
    },
    [joins],
  );

  const spec = useMemo<ReportSpec>(() => {
    if (!selected) return { schema: '', table: '', columns: [] };
    const sorts = sort.filter((s) => s.column);
    if (joins.length === 0)
      // Single table: the original, unqualified spec (and SQL).
      return {
        schema: selected.schema,
        table: selected.name,
        columns: picked.map((p) => p.column),
        sort: sorts.map((s) => ({ column: s.column, direction: s.direction })),
      };
    return {
      schema: selected.schema,
      table: selected.name,
      joins: joins.map((j) => ({
        schema: j.table.schema,
        table: j.table.name,
        ...(j.alias ? { alias: j.alias } : {}),
        type: j.type,
        on: j.on
          .filter((c) => c.left && c.right)
          .map((c) => {
            const l = splitKey(c.left);
            return {
              left: { table: aliasOf(l.src), column: l.column },
              right: { column: c.right },
            };
          }),
      })),
      columns: picked.map((p) => ({ table: aliasOf(p.src), column: p.column })),
      sort: sorts.map((s) => ({ table: aliasOf(s.src), column: s.column, direction: s.direction })),
    };
  }, [selected, picked, sort, joins, aliasOf]);

  // ---- live preview: the server builds the SQL for the current selection ----
  useEffect(() => {
    if (!selected || picked.length === 0) {
      setSql('');
      setSuggestedName('');
      setPreviewing(false);
      setPreviewError(null);
      setWarnings([]);
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
          setPreviewError(null);
          setWarnings(p.warnings ?? []);
        })
        .catch((e) => {
          if (cancelled || (e as Error).name === 'AbortError') return;
          setSql('');
          setPreviewError(e instanceof Error ? e.message : String(e));
          setWarnings([]);
        })
        .finally(() => !cancelled && setPreviewing(false));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
      controller.abort();
    };
  }, [selected, spec, picked.length]);

  /** Every table of the report with its loaded columns, base first. */
  const sources = useMemo(
    () =>
      selected
        ? [
            { key: BASE, table: selected, columns: columns ?? [] },
            ...joins.map((j) => ({ key: j.key, table: j.table, columns: j.columns ?? [] })),
          ]
        : [],
    [selected, columns, joins],
  );
  const joined = joins.length > 0;
  /** Display name of a picked column: plain for one table, alias-qualified with joins. */
  const label = (p: ColPick) => (joined ? `${aliasOf(p.src)}.${p.column}` : p.column);
  const isPicked = (src: string, column: string) =>
    picked.some((p) => p.src === src && p.column === column);

  const toggleColumn = (src: string, name: string, on: boolean) => {
    setPicked((prev) =>
      on
        ? prev.some((p) => p.src === src && p.column === name)
          ? prev
          : [...prev, { src, column: name }]
        : prev.filter((p) => !(p.src === src && p.column === name)),
    );
    if (!on) setSort((rows) => rows.filter((r) => !(r.src === src && r.column === name)));
    setResult(null);
  };

  const toggleAll = (src: string, names: string[], on: boolean) => {
    setPicked((prev) => {
      const rest = prev.filter((p) => p.src !== src);
      return on
        ? [
            ...prev.filter((p) => p.src === src),
            ...rest,
            ...names
              .filter((n) => !prev.some((p) => p.src === src && p.column === n))
              .map((column) => ({ src, column })),
          ]
        : rest;
    });
    if (!on) setSort((rows) => rows.filter((r) => r.src !== src));
    setResult(null);
  };

  const move = (p: ColPick, delta: number) => {
    setPicked((prev) => {
      const i = prev.findIndex((x) => x.src === p.src && x.column === p.column);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const addSort = () => {
    const used = new Set(sort.map(pickKey));
    const first = picked.find((p) => !used.has(pickKey(p))) ?? picked[0];
    if (!first) return;
    setSort((rows) => [...rows, { key: newExecutionId(), ...first, direction: 'ASC' }]);
    setResult(null);
  };

  // ---- joins ----
  const updateJoin = (key: string, patch: Partial<JoinedTable>) =>
    setJoins((list) => list.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  const toRows = (s: JoinSuggestion, aliasToKey: Map<string, string>): CondRow[] =>
    s.on.map((c) => ({
      key: newExecutionId(),
      left: `${aliasToKey.get(c.left.table) ?? ''}|${c.left.column}`,
      right: c.right.column,
    }));

  const addJoin = async () => {
    if (!selected || joins.length >= MAX_JOINS) return;
    const table = (tables ?? []).find((t) => `${t.schema}.${t.name}` === joinChoice);
    if (!table) return;
    const key = newExecutionId();
    const existing = [
      { key: BASE, alias: 'T1', table: selected },
      ...joins.map((j, i) => ({ key: j.key, alias: j.alias || `T${i + 2}`, table: j.table })),
    ];
    const aliasToKey = new Map(existing.map((e) => [e.alias, e.key]));
    setJoins((list) => [
      ...list,
      {
        key,
        table,
        alias: '',
        type: joinType,
        on: [],
        columns: null,
        error: null,
        suggestions: null,
        applied: null,
      },
    ]);
    setJoinChoice('');
    setResult(null);
    try {
      const cols = await api.schemaColumns(table.schema, table.name);
      updateJoin(key, { columns: cols.columns });
    } catch (e) {
      updateJoin(key, { error: e, columns: [] });
      return;
    }
    try {
      const r = await api.joinSuggestions(
        existing.map((e) => ({ alias: e.alias, schema: e.table.schema, table: e.table.name })),
        table.schema,
        table.name,
      );
      setJoins((list) =>
        list.map((j) => {
          if (j.key !== key) return j;
          const best = r.suggestions[0];
          const keep = j.on.length > 0 || !best;
          return {
            ...j,
            suggestions: r.suggestions.map((s) => ({
              ...s,
              // remember which table key each alias meant when the suggestion was made
              on: s.on.map((c) => ({
                ...c,
                left: { ...c.left, table: aliasToKey.get(c.left.table) ?? '' },
              })),
            })),
            on: keep ? j.on : toRows(best, aliasToKey),
            applied: keep ? j.applied : best.label,
          };
        }),
      );
    } catch {
      updateJoin(key, { suggestions: [] });
    }
  };

  const applySuggestion = (j: JoinedTable, s: JoinSuggestion) => {
    updateJoin(j.key, {
      on: s.on.map((c) => ({
        key: newExecutionId(),
        left: `${c.left.table}|${c.left.column}`,
        right: c.right.column,
      })),
      applied: s.label,
    });
    setResult(null);
  };

  const removeJoin = (key: string) => {
    setJoins((list) =>
      list
        .filter((j) => j.key !== key)
        .map((j) => ({ ...j, on: j.on.filter((c) => !c.left.startsWith(`${key}|`)) })),
    );
    setPicked((prev) => prev.filter((p) => p.src !== key));
    setSort((rows) => rows.filter((r) => r.src !== key));
    setResult(null);
  };

  const setCond = (j: JoinedTable, row: string, patch: Partial<CondRow>) =>
    updateJoin(j.key, {
      on: j.on.map((c) => (c.key === row ? { ...c, ...patch } : c)),
      applied: null,
    });

  const joinProblems = joins.flatMap((j, i) => {
    const a = j.alias || `T${i + 2}`;
    const out: string[] = [];
    if (j.alias && !ALIAS_RE.test(j.alias))
      out.push(`${j.alias}: aliases start with a letter and use A-Z, 0-9 or _ (max 10).`);
    if (!j.on.some((c) => c.left && c.right) && j.columns)
      out.push(`${a} (${j.table.name}) needs at least one ON condition.`);
    return out;
  });
  const aliasClash = new Set(sources.map((s) => aliasOf(s.key))).size !== sources.length;

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
        // The saved report stores the generated SQL; the builder definition is not
        // persisted (see docs/report-builder.md, "Joins").
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

  const typeOf = (src: string, column: string) =>
    sources.find((s) => s.key === src)?.columns.find((c) => c.name === column)?.displayType ?? '';

  const joinPanel = selected && (
    <section className="qf-builder__joins" aria-label="Joined tables">
      <h3 className="qf-builder__h3">
        <Connect size={16} /> Joined tables
      </h3>
      <ol className="qf-builder__diagram" aria-label="Join diagram">
        <li>
          <Tag size="sm" type="blue">
            T1
          </Tag>
          <span className="qf-builder__mono">
            {selected.schema}.{selected.name}
          </span>
        </li>
        {joins.map((j, i) => (
          <li key={j.key}>
            <span className="qf-builder__join-type">{JOIN_TYPE_LABELS[j.type]}</span>
            <Tag size="sm" type="teal">
              {j.alias || `T${i + 2}`}
            </Tag>
            <span className="qf-builder__mono">
              {j.table.schema}.{j.table.name}
            </span>
            <span className="qf-muted qf-builder__mono">
              {j.on.filter((c) => c.left && c.right).length === 0
                ? ' — no ON condition yet'
                : ` ON ${j.on
                    .filter((c) => c.left && c.right)
                    .map((c) => {
                      const l = splitKey(c.left);
                      return `${aliasOf(l.src)}.${l.column} = ${j.alias || `T${i + 2}`}.${c.right}`;
                    })
                    .join(' AND ')}`}
            </span>
          </li>
        ))}
      </ol>

      {joins.map((j, i) => {
        const alias = j.alias || `T${i + 2}`;
        const earlier = sources.slice(0, i + 1);
        return (
          <div className="qf-builder__join" key={j.key} aria-label={`Join ${alias}`} role="group">
            <div className="qf-builder__join-head">
              <Select
                id={`qb-join-type-${j.key}`}
                labelText={`Join type for ${alias}`}
                size="sm"
                value={j.type}
                onChange={(e: { target: { value: string } }) =>
                  updateJoin(j.key, { type: e.target.value as JoinType })
                }
              >
                {(Object.keys(JOIN_TYPE_LABELS) as JoinType[]).map((t) => (
                  <SelectItem key={t} value={t} text={JOIN_TYPE_LABELS[t]} />
                ))}
              </Select>
              <TextInput
                id={`qb-join-alias-${j.key}`}
                labelText={`Alias for ${j.table.name}`}
                size="sm"
                placeholder={`T${i + 2}`}
                value={j.alias}
                maxLength={10}
                invalid={Boolean(j.alias) && !ALIAS_RE.test(j.alias)}
                invalidText="Letter first, then A-Z, 0-9 or _ (max 10)"
                onChange={(e: { target: { value: string } }) =>
                  updateJoin(j.key, { alias: e.target.value.toUpperCase() })
                }
              />
              <Button kind="ghost" size="sm" renderIcon={Close} onClick={() => removeJoin(j.key)}>
                Remove {alias}
              </Button>
            </div>
            {j.applied && (
              <div className="qf-muted">
                <Tag size="sm" type="green">
                  Suggested
                </Tag>{' '}
                {j.applied}
              </div>
            )}
            {j.on.map((c, n) => (
              <div className="qf-builder__cond" key={c.key}>
                <Select
                  id={`qb-on-left-${c.key}`}
                  labelText={`${alias} condition ${n + 1} left column`}
                  hideLabel={n > 0}
                  size="sm"
                  value={c.left}
                  onChange={(e: { target: { value: string } }) =>
                    setCond(j, c.key, { left: e.target.value })
                  }
                >
                  <SelectItem value="" text="Choose column" />
                  {earlier.map((src) => (
                    <SelectItemGroup
                      key={src.key}
                      label={`${aliasOf(src.key)} · ${src.table.name}`}
                    >
                      {src.columns.map((col) => (
                        <SelectItem
                          key={col.name}
                          value={`${src.key}|${col.name}`}
                          text={`${aliasOf(src.key)}.${col.name}`}
                        />
                      ))}
                    </SelectItemGroup>
                  ))}
                </Select>
                <span className="qf-builder__eq" aria-hidden>
                  =
                </span>
                <Select
                  id={`qb-on-right-${c.key}`}
                  labelText={`${alias} condition ${n + 1} right column`}
                  hideLabel={n > 0}
                  size="sm"
                  value={c.right}
                  onChange={(e: { target: { value: string } }) =>
                    setCond(j, c.key, { right: e.target.value })
                  }
                >
                  <SelectItem value="" text="Choose column" />
                  {(j.columns ?? []).map((col) => (
                    <SelectItem
                      key={col.name}
                      value={col.name}
                      text={`${alias}.${col.name} (${col.displayType})`}
                    />
                  ))}
                </Select>
                <Button
                  kind="ghost"
                  size="sm"
                  hasIconOnly
                  renderIcon={Close}
                  iconDescription={`Remove ${alias} condition ${n + 1}`}
                  onClick={() =>
                    updateJoin(j.key, { on: j.on.filter((x) => x.key !== c.key), applied: null })
                  }
                />
                {c.left && c.right && (
                  <span className="qf-muted qf-builder__cond-types">
                    {typeOf(splitKey(c.left).src, splitKey(c.left).column)} ={' '}
                    {typeOf(j.key, c.right)}
                  </span>
                )}
              </div>
            ))}
            <div className="qf-builder__join-actions">
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Add}
                disabled={j.on.length >= 16}
                onClick={() =>
                  updateJoin(j.key, {
                    on: [...j.on, { key: newExecutionId(), left: '', right: '' }],
                    applied: null,
                  })
                }
              >
                Add condition
              </Button>
              {j.suggestions === null && j.columns !== null && !j.error && (
                <InlineLoading description="Looking for join keys…" style={{ width: 'auto' }} />
              )}
              {(j.suggestions ?? [])
                .filter((s) => s.label !== j.applied)
                .map((s) => (
                  <Button
                    key={s.label}
                    kind="tertiary"
                    size="sm"
                    onClick={() => applySuggestion(j, s)}
                  >
                    Use {s.label}
                  </Button>
                ))}
              {j.suggestions?.length === 0 && (
                <span className="qf-muted">
                  No foreign key or same-name column found — choose the columns yourself.
                </span>
              )}
            </div>
          </div>
        );
      })}

      <div className="qf-builder__add-join">
        <Select
          id="qb-join-table"
          labelText="Table to join"
          size="sm"
          value={joinChoice}
          disabled={joins.length >= MAX_JOINS}
          onChange={(e: { target: { value: string } }) => setJoinChoice(e.target.value)}
        >
          <SelectItem value="" text="Choose a table" />
          {(tables ?? []).map((t) => (
            <SelectItem
              key={`${t.schema}.${t.name}`}
              value={`${t.schema}.${t.name}`}
              text={`${t.schema}.${t.name}`}
            />
          ))}
        </Select>
        <Select
          id="qb-join-new-type"
          labelText="Join type"
          size="sm"
          value={joinType}
          onChange={(e: { target: { value: string } }) => setJoinType(e.target.value as JoinType)}
        >
          {(Object.keys(JOIN_TYPE_LABELS) as JoinType[]).map((t) => (
            <SelectItem key={t} value={t} text={JOIN_TYPE_LABELS[t]} />
          ))}
        </Select>
        <Button
          kind="secondary"
          size="sm"
          renderIcon={Add}
          disabled={!joinChoice || joins.length >= MAX_JOINS}
          onClick={() => void addJoin()}
        >
          Add table
        </Button>
      </div>
      <p className="qf-muted">
        {joins.length >= MAX_JOINS
          ? `A report can join at most ${MAX_JOINS} tables.`
          : 'Join another table (including this one again under a new alias). The list follows the table search.'}
      </p>
      {joined && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Joins can multiply rows."
          subtitle="Each match in a joined table produces its own result row, so totals can repeat. Results are still fetched a page at a time."
        />
      )}
      {(joinProblems.length > 0 || aliasClash) && (
        <ul className="qf-builder__problems" aria-label="Join problems">
          {aliasClash && <li>Every table needs a different alias.</li>}
          {joinProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );

  const canRun =
    Boolean(selected) && picked.length > 0 && !running && joinProblems.length === 0 && !aliasClash;
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
            Uncle Bob builds the read-only SELECT for you.
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
                <>
                  {joinPanel}
                  <div className="qf-two-col">
                    <div>
                      {sources.map((src) => {
                        const names = src.columns.map((c) => c.name);
                        const count = picked.filter((p) => p.src === src.key).length;
                        const all = names.length > 0 && count === names.length;
                        const base = src.key === BASE;
                        const alias = aliasOf(src.key);
                        const j = joins.find((x) => x.key === src.key);
                        return (
                          <fieldset className="qf-fieldset" key={src.key}>
                            <legend>
                              {joined ? (
                                <>
                                  <span className="qf-builder__mono">{alias}</span> ·{' '}
                                  {src.table.name} columns ({count} of {names.length})
                                </>
                              ) : (
                                <>
                                  Columns ({count} of {names.length})
                                </>
                              )}
                            </legend>
                            {j && j.columns === null && (
                              <Loading small withOverlay={false} description="Loading columns" />
                            )}
                            {j && <ErrorNotice error={j.error} />}
                            <Checkbox
                              id={`qb-select-all-${src.key}`}
                              labelText={base ? 'Select all' : `Select all ${alias}`}
                              checked={all}
                              indeterminate={count > 0 && !all}
                              onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                                toggleAll(src.key, names, checked)
                              }
                            />
                            <div className="qf-builder__columns">
                              {src.columns.map((c) => (
                                <Checkbox
                                  key={c.name}
                                  id={`qb-col-${src.key}-${c.name}`}
                                  labelText={
                                    <span className="qf-builder__col-label">
                                      <span className="qf-builder__mono">
                                        {base ? '' : `${alias}.`}
                                        {c.name}
                                      </span>{' '}
                                      <span className="qf-muted">
                                        {c.displayType}
                                        {c.nullable ? '' : ' · not null'}
                                      </span>
                                      {c.text && <span className="qf-builder__text">{c.text}</span>}
                                    </span>
                                  }
                                  checked={isPicked(src.key, c.name)}
                                  onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                                    toggleColumn(src.key, c.name, checked)
                                  }
                                />
                              ))}
                            </div>
                          </fieldset>
                        );
                      })}
                    </div>

                    <div>
                      <h3 className="qf-builder__h3">Field order</h3>
                      {picked.length === 0 ? (
                        <p className="qf-muted">Selected columns appear here in SELECT order.</p>
                      ) : (
                        <ol className="qf-builder__order">
                          {picked.map((p, i) => {
                            const name = label(p);
                            return (
                              <li key={pickKey(p)}>
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
                                    onClick={() => move(p, -1)}
                                  />
                                  <Button
                                    kind="ghost"
                                    size="sm"
                                    hasIconOnly
                                    renderIcon={ArrowDown}
                                    iconDescription={`Move ${name} down`}
                                    disabled={i === picked.length - 1}
                                    onClick={() => move(p, 1)}
                                  />
                                  <Button
                                    kind="ghost"
                                    size="sm"
                                    hasIconOnly
                                    renderIcon={Close}
                                    iconDescription={`Remove ${name}`}
                                    onClick={() => toggleColumn(p.src, p.column, false)}
                                  />
                                </span>
                              </li>
                            );
                          })}
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
                              value={pickKey(row)}
                              onChange={(e: { target: { value: string } }) =>
                                setSort((rows) =>
                                  rows.map((r) =>
                                    r.key === row.key ? { ...r, ...splitKey(e.target.value) } : r,
                                  ),
                                )
                              }
                            >
                              {joined
                                ? sources.map((src) => (
                                    <SelectItemGroup
                                      key={src.key}
                                      label={`${aliasOf(src.key)} · ${src.table.name}`}
                                    >
                                      {src.columns.map((c) => (
                                        <SelectItem
                                          key={c.name}
                                          value={`${src.key}|${c.name}`}
                                          text={`${aliasOf(src.key)}.${c.name}`}
                                        />
                                      ))}
                                    </SelectItemGroup>
                                  ))
                                : (columns ?? []).map((c) => (
                                    <SelectItem
                                      key={c.name}
                                      value={`${BASE}|${c.name}`}
                                      text={c.name}
                                    />
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
                              onClick={() =>
                                setSort((rows) => rows.filter((r) => r.key !== row.key))
                              }
                            />
                          </div>
                        ))}
                      </div>
                      <Button
                        kind="ghost"
                        size="sm"
                        renderIcon={Add}
                        disabled={picked.length === 0 || sort.length >= 16}
                        onClick={addSort}
                      >
                        Add sort column
                      </Button>
                    </div>
                  </div>
                </>
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
          {!sql && previewError && picked.length > 0 && (
            <p className="qf-error-text" role="alert">
              {previewError}
            </p>
          )}
          {warnings.map((w) => (
            <InlineNotification
              key={w}
              kind="info"
              lowContrast
              hideCloseButton
              title="Check this join"
              subtitle={w}
            />
          ))}
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
