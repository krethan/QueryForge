import type React from 'react';
import { Button, Select, SelectItem, Toggle } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import type { PivotFn } from '../api/types';
import { isNumericKind, type ValueKind } from '../utils/builderState';
import type { ColumnChoice } from './BuilderFilters';
import { ColumnSelect } from './BuilderGrouping';

/** Builder state for a pivot; column picks use the same keys as the other builder rows. */
export interface PivotState {
  enabled: boolean;
  rows: string[];
  column: string;
  fn: PivotFn;
  /** '' = count rows (COUNT only). */
  value: string;
}
export const MAX_PIVOT_ROWS = 5;
export const PIVOT_FN_LABELS: Record<PivotFn, string> = {
  SUM: 'Sum',
  COUNT: 'Count',
  AVG: 'Average',
  MIN: 'Minimum',
  MAX: 'Maximum',
};
export const emptyPivot = (): PivotState => ({
  enabled: false,
  rows: [],
  column: '',
  fn: 'SUM',
  value: '',
});

/** What is missing before the pivot can run, or null when it is complete. */
export function pivotProblem(p: PivotState): string | null {
  if (!p.rows.filter(Boolean).length) return 'Choose at least one row field.';
  if (!p.column) return 'Choose a column field.';
  if (p.rows.includes(p.column)) return 'The column field cannot also be a row field.';
  if (!p.value && p.fn !== 'COUNT') return `Choose a value field to ${p.fn.toLowerCase()}.`;
  return null;
}

interface Props {
  pivot: PivotState;
  columns: ColumnChoice[];
  kindOf(pick: string): ValueKind;
  onChange(p: PivotState): void;
}

/** "Pivot": rows x one column field x one aggregated value, pivoted on the server. */
export function BuilderPivot({ pivot, columns, kindOf, onChange }: Props) {
  const set = (patch: Partial<PivotState>) => onChange({ ...pivot, ...patch });
  const firstPick = columns[0]?.items[0]?.value ?? '';
  const groupable = (pick: string) => kindOf(pick) !== 'none';
  const needsNumber = pivot.fn === 'SUM' || pivot.fn === 'AVG';
  const problem = pivot.enabled ? pivotProblem(pivot) : null;
  return (
    <section className="qf-builder__grouping" aria-label="Pivot" data-testid="builder-pivot">
      <h3 className="qf-builder__h3">Pivot</h3>
      <Toggle
        id="qf-pivot-toggle"
        size="sm"
        labelText="Show as a pivot (crosstab)"
        labelA="Off"
        labelB="On"
        toggled={pivot.enabled}
        onToggle={(on: boolean) =>
          set(
            on && !pivot.rows.length
              ? { enabled: true, rows: [firstPick], column: '' }
              : { enabled: on },
          )
        }
      />
      {pivot.enabled && (
        <>
          <p className="qf-muted">
            Rows down the side, one column per distinct value of the column field (at most 50; add a
            filter if there are more), with row, column and grand totals. Columns, grouping, totals
            and sorting are set by the pivot.
          </p>
          {pivot.rows.map((r, i) => (
            <div key={i} className="qf-builder__sort-row">
              <ColumnSelect
                id={`qf-pivot-row-${i}`}
                label={i === 0 ? 'Row field' : `Row field ${i + 1}`}
                value={r}
                columns={columns}
                allow={groupable}
                onChange={(v) => set({ rows: pivot.rows.map((x, k) => (k === i ? v : x)) })}
              />
              {pivot.rows.length > 1 && (
                <Button
                  kind="ghost"
                  size="sm"
                  hasIconOnly
                  renderIcon={Close}
                  iconDescription={`Remove row field ${i + 1}`}
                  onClick={() => set({ rows: pivot.rows.filter((_, k) => k !== i) })}
                />
              )}
            </div>
          ))}
          {pivot.rows.length < MAX_PIVOT_ROWS && (
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Add}
              onClick={() => set({ rows: [...pivot.rows, firstPick] })}
            >
              Add row field
            </Button>
          )}
          <div className="qf-builder__sort-row">
            <ColumnSelect
              id="qf-pivot-column"
              label="Column field"
              value={pivot.column}
              columns={columns}
              allow={(c) => groupable(c) && !pivot.rows.includes(c)}
              first={{ value: '', text: 'Choose a column field' }}
              onChange={(v) => set({ column: v })}
            />
          </div>
          <div className="qf-builder__sort-row">
            <Select
              id="qf-pivot-fn"
              labelText="Value"
              size="sm"
              value={pivot.fn}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                const fn = e.target.value as PivotFn;
                const keep =
                  !pivot.value ||
                  !(fn === 'SUM' || fn === 'AVG') ||
                  isNumericKind(kindOf(pivot.value));
                set({ fn, value: keep ? pivot.value : '' });
              }}
            >
              {(Object.keys(PIVOT_FN_LABELS) as PivotFn[]).map((f) => (
                <SelectItem key={f} value={f} text={PIVOT_FN_LABELS[f]} />
              ))}
            </Select>
            <ColumnSelect
              id="qf-pivot-value"
              label="of"
              value={pivot.value}
              columns={columns}
              allow={(c) => groupable(c) && (!needsNumber || isNumericKind(kindOf(c)))}
              first={
                pivot.fn === 'COUNT'
                  ? { value: '', text: 'rows' }
                  : { value: '', text: 'Choose a value field' }
              }
              onChange={(v) => set({ value: v })}
            />
          </div>
          {problem && (
            <p className="qf-muted" role="status">
              {problem}
            </p>
          )}
        </>
      )}
    </section>
  );
}
