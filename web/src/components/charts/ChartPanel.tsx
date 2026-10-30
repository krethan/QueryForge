import {
  Button,
  Checkbox,
  ContentSwitcher,
  InlineNotification,
  MultiSelect,
  Select,
  SelectItem,
  Switch,
  TextInput,
} from '@carbon/react';
import { ChartColumnFloating, Save } from '@carbon/icons-react';
import { useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
type SelEv = ChangeEvent<HTMLSelectElement>;
type InEv = ChangeEvent<HTMLInputElement>;
import type { Cell, ResultColumn } from '../../api/types';
import {
  CHART_SORTS,
  CHART_SORT_LABELS,
  CHART_TYPES,
  CHART_TYPE_LABELS,
  MAX_CHART_ROWS,
  MAX_TOP_N,
  MAX_VALUE_FIELDS,
  NUMERIC_CHART_KINDS,
  chartProblem,
  cleanChartDef,
  isPie,
  prepareChart,
  suggestChart,
  type ChartDef,
  type ChartView,
} from '../../utils/chartData';
import { LazyChart } from './LazyChart';

export interface ChartPanelProps {
  columns: ResultColumn[];
  rows: Cell[][];
  hasMore: boolean;
  /** Current (possibly unsaved) chart settings; null = none chosen yet. */
  def: ChartDef | null;
  onChange(def: ChartDef | null): void;
  view: ChartView;
  onViewChange(v: ChartView): void;
  /** The results table; kept mounted (hidden) in Chart view so loaded rows survive. */
  table: ReactNode;
  /** Settings stored on the report, to show "unsaved" and enable Save. */
  saved?: ChartDef | null;
  /** Saves the chart to the report; omitted when the chart cannot be saved here. */
  onSave?(def: ChartDef | null): Promise<void>;
  saveHint?: string;
  /** Show the dashboard checkboxes even without onSave (saved together with the report). */
  dashboardOptions?: boolean;
  /** Problem with the stored chart (from the server). */
  storedError?: string;
}

const VIEWS: ChartView[] = ['table', 'chart', 'both'];
const colLabel = (c: ResultColumn) =>
  c.label && c.label !== c.name ? `${c.label} (${c.name})` : c.name;

/**
 * Chart settings and preview for a result set. Plots the rows loaded so far
 * (first page + "Load next"), never re-runs the query.
 */
export function ChartPanel(p: ChartPanelProps) {
  const { columns, rows } = p;
  const suggestion = useMemo(() => suggestChart(columns), [columns]);
  const def = p.def ?? suggestion;
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const showChart = p.view !== 'table';
  const numeric = columns.filter((c) => NUMERIC_CHART_KINDS.has(c.kind));
  const problem = def ? chartProblem(def) : null;
  const prepared = useMemo(
    () =>
      def && !problem
        ? prepareChart(
            def,
            columns.map((c) => ({ name: c.name, label: c.label, kind: c.kind })),
            rows,
          )
        : null,
    [def, problem, columns, rows],
  );
  const changeView = (v: ChartView) => {
    if (v !== 'table' && !p.def && suggestion) p.onChange(suggestion);
    p.onViewChange(v);
  };
  const set = (patch: Partial<ChartDef>) => {
    if (!def) return;
    const next = { ...def, ...patch };
    if (isPie(next.type)) {
      next.y = next.y.slice(0, 1);
      next.series = null;
    }
    if (!next.showOnDashboard) next.dashboardAutoLoad = false;
    setSaveMsg(null);
    p.onChange(next);
  };
  const clean = def ? JSON.stringify(cleanChartDef(def)) : 'null';
  const dirty = clean !== JSON.stringify(p.saved ? cleanChartDef(p.saved) : null);

  const save = async (value: ChartDef | null) => {
    if (!p.onSave) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await p.onSave(value ? cleanChartDef(value) : null);
      setSaveMsg({
        kind: 'success',
        text: value ? 'Chart saved with the report.' : 'Chart removed.',
      });
    } catch (e) {
      setSaveMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const yName = prepared?.ok
    ? def!.y.map((y) => columns.find((c) => c.name === y)?.label ?? y).join(', ')
    : '';
  const xCol = def ? columns.find((c) => c.name === def.x) : undefined;
  const notes: string[] = [];
  if (prepared?.ok) {
    const plotted = Math.min(rows.length, MAX_CHART_ROWS);
    if (p.hasMore)
      notes.push(
        `Plotting the ${plotted.toLocaleString()} rows loaded so far; more rows exist. Use “Load next” in the table to include them.`,
      );
    else if (rows.length > MAX_CHART_ROWS)
      notes.push(`Plotting the first ${MAX_CHART_ROWS.toLocaleString()} rows.`);
    if (prepared.categoriesDropped)
      notes.push(
        `Showing the top ${def!.topN} of ${(prepared.keys.length + prepared.categoriesDropped).toLocaleString()} categories.`,
      );
    if (prepared.precisionLoss)
      notes.push(
        'Some exact decimal values have more than 15 significant digits; the chart rounds them (the table and Excel keep every digit).',
      );
  }

  return (
    <div className="qf-chart-panel">
      <div className="qf-chart-bar">
        <ContentSwitcher
          size="sm"
          selectedIndex={VIEWS.indexOf(p.view)}
          onChange={({ name }: { name?: string | number }) => changeView(name as ChartView)}
          aria-label="Show results as"
          className="qf-view-switch"
        >
          <Switch name="table" text="Table" />
          <Switch name="chart" text="Chart" />
          <Switch name="both" text="Both" />
        </ContentSwitcher>
        {p.view === 'table' && suggestion && !p.def && (
          <span className="qf-chart-hint">
            <ChartColumnFloating aria-hidden /> Suggested:{' '}
            {CHART_TYPE_LABELS[suggestion.type].toLowerCase()} chart of {suggestion.y[0]} by{' '}
            {suggestion.x}.{' '}
            <Button kind="ghost" size="sm" onClick={() => changeView('both')}>
              Show chart
            </Button>
          </span>
        )}
      </div>
      {p.storedError && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Saved chart disabled"
          subtitle={p.storedError}
        />
      )}
      {showChart && !def && (
        <p className="qf-chart-note">
          {numeric.length === 0
            ? 'These results have no numeric column to chart.'
            : 'Choose fields to chart.'}
        </p>
      )}
      {showChart && def && (
        <div className="qf-chart-layout">
          <div className="qf-chart-controls" aria-label="Chart settings" role="group">
            <Select
              id="qf-chart-type"
              labelText="Chart type"
              size="sm"
              value={def.type}
              onChange={(e: SelEv) => set({ type: e.target.value as ChartDef['type'] })}
            >
              {CHART_TYPES.map((t) => (
                <SelectItem key={t} value={t} text={CHART_TYPE_LABELS[t]} />
              ))}
            </Select>
            <Select
              id="qf-chart-x"
              labelText={isPie(def.type) ? 'Slices (category)' : 'X axis'}
              size="sm"
              value={def.x}
              onChange={(e: SelEv) =>
                set({ x: e.target.value, y: def.y.filter((y) => y !== e.target.value) })
              }
            >
              {columns.map((c) => (
                <SelectItem key={c.name} value={c.name} text={colLabel(c)} />
              ))}
            </Select>
            {isPie(def.type) ? (
              <Select
                id="qf-chart-y1"
                labelText="Value"
                size="sm"
                value={def.y[0] ?? ''}
                onChange={(e: SelEv) => set({ y: [e.target.value] })}
              >
                {numeric
                  .filter((c) => c.name !== def.x)
                  .map((c) => (
                    <SelectItem key={c.name} value={c.name} text={colLabel(c)} />
                  ))}
              </Select>
            ) : (
              <MultiSelect
                id="qf-chart-y"
                titleText={`Values (up to ${MAX_VALUE_FIELDS})`}
                label={def.y.length ? def.y.join(', ') : 'Choose numeric fields'}
                size="sm"
                items={numeric.filter((c) => c.name !== def.x).map((c) => c.name)}
                itemToString={(n: string | null) => {
                  const c = columns.find((x) => x.name === n);
                  return c ? colLabel(c) : (n ?? '');
                }}
                selectedItems={def.y}
                onChange={({ selectedItems }: { selectedItems: string[] | null }) =>
                  set({
                    y: (selectedItems ?? []).slice(0, MAX_VALUE_FIELDS),
                    ...((selectedItems ?? []).length > 1 ? { series: null } : {}),
                  })
                }
              />
            )}
            {!isPie(def.type) && (
              <Select
                id="qf-chart-series"
                labelText="Series (optional)"
                size="sm"
                value={def.series ?? ''}
                disabled={def.y.length > 1}
                helperText={def.y.length > 1 ? 'One series per value field.' : undefined}
                onChange={(e: SelEv) => set({ series: e.target.value || null })}
              >
                <SelectItem value="" text="None" />
                {columns
                  .filter((c) => c.name !== def.x && !def.y.includes(c.name))
                  .map((c) => (
                    <SelectItem key={c.name} value={c.name} text={colLabel(c)} />
                  ))}
              </Select>
            )}
            <TextInput
              id="qf-chart-title"
              labelText="Title"
              size="sm"
              maxLength={120}
              value={def.title ?? ''}
              onChange={(e: InEv) => set({ title: e.target.value })}
            />
            <Select
              id="qf-chart-sort"
              labelText="Sort"
              size="sm"
              value={def.sort ?? (def.topN ? 'valueDesc' : 'none')}
              onChange={(e: SelEv) => set({ sort: e.target.value as ChartDef['sort'] })}
            >
              {CHART_SORTS.map((s) => (
                <SelectItem key={s} value={s} text={CHART_SORT_LABELS[s]} />
              ))}
            </Select>
            <TextInput
              id="qf-chart-topn"
              labelText={`Top N (1–${MAX_TOP_N}, optional)`}
              size="sm"
              inputMode="numeric"
              value={def.topN ? String(def.topN) : ''}
              invalid={!!problem && /Top N/.test(problem)}
              invalidText={problem ?? undefined}
              onChange={(e: InEv) => {
                const v = e.target.value.trim();
                set({ topN: v === '' ? null : Number(v) });
              }}
            />
            {(p.onSave || p.dashboardOptions) && (
              <>
                <Checkbox
                  id="qf-chart-dash"
                  labelText="Show chart on dashboard"
                  checked={!!def.showOnDashboard}
                  onChange={(_: unknown, { checked }: { checked: boolean }) =>
                    set({ showOnDashboard: checked })
                  }
                />
                <Checkbox
                  id="qf-chart-autoload"
                  labelText="Run automatically when the dashboard opens"
                  helperText="Otherwise the tile shows a Load chart button."
                  disabled={!def.showOnDashboard}
                  checked={!!def.dashboardAutoLoad}
                  onChange={(_: unknown, { checked }: { checked: boolean }) =>
                    set({ dashboardAutoLoad: checked })
                  }
                />
                {p.onSave && (
                  <div className="qf-chart-actions">
                    <Button
                      size="sm"
                      renderIcon={Save}
                      disabled={saving || !dirty || !!problem}
                      onClick={() => void save(def)}
                    >
                      {saving ? 'Saving…' : 'Save chart'}
                    </Button>
                    {p.saved && (
                      <Button
                        size="sm"
                        kind="ghost"
                        disabled={saving}
                        onClick={() => void save(null)}
                      >
                        Remove saved chart
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
            {!p.onSave && p.saveHint && <p className="qf-chart-note">{p.saveHint}</p>}
            {saveMsg && (
              <InlineNotification
                kind={saveMsg.kind}
                lowContrast
                title={saveMsg.text}
                onClose={() => setSaveMsg(null)}
              />
            )}
          </div>
          <div className="qf-chart-area">
            {problem && (
              <p className="qf-chart-note" role="alert">
                {problem}
              </p>
            )}
            {prepared && !prepared.ok && (
              <p className="qf-chart-note" role="alert">
                {prepared.message}
              </p>
            )}
            {prepared?.ok && prepared.points.length === 0 && (
              <p className="qf-chart-note">No numeric values to plot in the loaded rows.</p>
            )}
            {prepared?.ok && prepared.points.length > 0 && (
              <LazyChart
                key={`${def.type}:${def.x}:${def.y.join(',')}:${def.series ?? ''}`}
                type={def.type}
                points={prepared.points}
                keys={prepared.keys}
                groups={prepared.groups}
                title={def.title}
                xLabel={xCol?.label ?? def.x}
                yLabel={yName}
              />
            )}
            {notes.map((n) => (
              <p key={n} className="qf-chart-note" data-testid="qf-chart-note">
                {n}
              </p>
            ))}
          </div>
        </div>
      )}
      <div hidden={p.view === 'chart'}>{p.table}</div>
    </div>
  );
}
