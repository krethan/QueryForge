import type React from 'react';
import { Button, Select, SelectItem, SelectItemGroup, TextInput } from '@carbon/react';
import { Add, Close, Sigma } from '@carbon/icons-react';
import type { AggregateFn, HavingOp } from '../api/types';
import {
  AGG_LABELS,
  MAX_AGGREGATES,
  MAX_HAVING,
  aggName,
  isNumericKind,
  type AggRow,
  type HavingRow,
  type ValueKind,
} from '../utils/builderState';
import { newExecutionId } from '../utils/format';
import type { ColumnChoice } from './BuilderFilters';

export interface GroupRow {
  key: string;
  pick: string;
}

interface Props {
  groupBy: GroupRow[];
  aggregates: AggRow[];
  having: HavingRow[];
  columns: ColumnChoice[];
  kindOf(pick: string): ValueKind;
  columnName(pick: string): string | null;
  /** Selected (non-total) columns that the server will add to GROUP BY. */
  autoGrouped: string[];
  onGroupBy(rows: GroupRow[]): void;
  onAggregates(rows: AggRow[]): void;
  onHaving(rows: HavingRow[]): void;
}

const HAVING_LABELS: Record<HavingOp, string> = {
  '=': 'equals',
  '<>': 'does not equal',
  '<': 'less than',
  '<=': 'at most',
  '>': 'greater than',
  '>=': 'at least',
  BETWEEN: 'between',
};

function ColumnSelect({
  id,
  label,
  value,
  columns,
  allow,
  first,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  columns: ColumnChoice[];
  allow?: (pick: string) => boolean;
  first?: { value: string; text: string };
  onChange(v: string): void;
}) {
  const groups = columns
    .map((g) => ({ ...g, items: g.items.filter((c) => !allow || allow(c.value)) }))
    .filter((g) => g.items.length);
  return (
    <Select
      id={id}
      labelText={label}
      size="sm"
      value={value}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
    >
      {first && <SelectItem value={first.value} text={first.text} />}
      {groups.length === 1
        ? groups[0].items.map((c) => <SelectItem key={c.value} value={c.value} text={c.text} />)
        : groups.map((g) => (
            <SelectItemGroup key={g.label} label={g.label}>
              {g.items.map((c) => (
                <SelectItem key={c.value} value={c.value} text={c.text} />
              ))}
            </SelectItemGroup>
          ))}
    </Select>
  );
}

/** "Group & totals": GROUP BY columns, COUNT/SUM/AVG/MIN/MAX totals and total filters (HAVING). */
export function BuilderGrouping(p: Props) {
  const firstPick = p.columns[0]?.items[0]?.value ?? '';
  const names = p.aggregates.map((a) => aggName(a, p.columnName));
  const dup = names.find(
    (n, i) => names.findIndex((m) => m.toUpperCase() === n.toUpperCase()) !== i,
  );
  const setAgg = (key: string, patch: Partial<AggRow>) =>
    p.onAggregates(p.aggregates.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const setHaving = (key: string, patch: Partial<HavingRow>) =>
    p.onHaving(p.having.map((h) => (h.key === key ? { ...h, ...patch } : h)));
  const numeric = (pick: string) => isNumericKind(p.kindOf(pick));
  const totalable = (pick: string) => p.kindOf(pick) !== 'none';

  return (
    <section className="qf-builder__grouping" aria-label="Group and totals">
      <h3 className="qf-builder__h3">
        <Sigma size={16} /> Group &amp; totals
      </h3>
      <p className="qf-muted">
        Group rows by one or more columns and add totals. Selected columns that are not totals are
        grouped automatically.
      </p>

      <h4 className="qf-builder__h4">Group by</h4>
      {p.groupBy.map((g, i) => (
        <div className="qf-builder__sort-row" key={g.key}>
          <ColumnSelect
            id={`qf-gb-${g.key}`}
            label={`Group by ${i + 1}`}
            value={g.pick}
            columns={p.columns}
            onChange={(v) =>
              p.onGroupBy(p.groupBy.map((x) => (x.key === g.key ? { ...x, pick: v } : x)))
            }
          />
          <Button
            kind="ghost"
            size="sm"
            hasIconOnly
            renderIcon={Close}
            iconDescription={`Remove group by ${i + 1}`}
            onClick={() => p.onGroupBy(p.groupBy.filter((x) => x.key !== g.key))}
          />
        </div>
      ))}
      {p.autoGrouped.length > 0 && (
        <p className="qf-muted">Also grouped (selected columns): {p.autoGrouped.join(', ')}</p>
      )}
      <Button
        kind="ghost"
        size="sm"
        renderIcon={Add}
        disabled={!firstPick || p.groupBy.length >= 100}
        onClick={() => p.onGroupBy([...p.groupBy, { key: newExecutionId(), pick: firstPick }])}
      >
        Add group by
      </Button>

      <h4 className="qf-builder__h4">Totals</h4>
      {p.aggregates.map((a, i) => (
        <div className="qf-builder__agg-row" key={a.key} role="group" aria-label={`Total ${i + 1}`}>
          <Select
            id={`qf-agg-fn-${a.key}`}
            labelText="Function"
            size="sm"
            value={a.fn}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              const fn = e.target.value as AggregateFn;
              let pick = a.pick;
              if (fn !== 'COUNT' && !pick) pick = firstPick;
              if ((fn === 'SUM' || fn === 'AVG') && pick && !numeric(pick))
                pick = p.columns.flatMap((g) => g.items).find((c) => numeric(c.value))?.value ?? '';
              setAgg(a.key, { fn, pick });
            }}
          >
            {(Object.keys(AGG_LABELS) as AggregateFn[]).map((f) => (
              <SelectItem key={f} value={f} text={AGG_LABELS[f]} />
            ))}
          </Select>
          <ColumnSelect
            id={`qf-agg-col-${a.key}`}
            label="Of"
            value={a.pick}
            columns={p.columns}
            allow={a.fn === 'SUM' || a.fn === 'AVG' ? numeric : totalable}
            first={a.fn === 'COUNT' ? { value: '', text: 'All rows (*)' } : undefined}
            onChange={(v) => setAgg(a.key, { pick: v })}
          />
          <TextInput
            id={`qf-agg-name-${a.key}`}
            labelText="Column name"
            size="sm"
            maxLength={64}
            placeholder={aggName({ ...a, name: '' }, p.columnName)}
            value={a.name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setAgg(a.key, { name: e.target.value })
            }
          />
          <Button
            kind="ghost"
            size="sm"
            hasIconOnly
            renderIcon={Close}
            iconDescription={`Remove total ${i + 1}`}
            onClick={() => {
              p.onAggregates(p.aggregates.filter((x) => x.key !== a.key));
              p.onHaving(p.having.filter((h) => h.aggregate !== a.key));
            }}
          />
        </div>
      ))}
      {dup && <p className="qf-error-text">Two totals are named “{dup}”; rename one.</p>}
      <Button
        kind="ghost"
        size="sm"
        renderIcon={Add}
        disabled={p.aggregates.length >= MAX_AGGREGATES}
        onClick={() =>
          p.onAggregates([
            ...p.aggregates,
            { key: newExecutionId(), fn: 'COUNT', pick: '', name: '' },
          ])
        }
      >
        Add total
      </Button>

      {p.aggregates.length > 0 && (
        <>
          <h4 className="qf-builder__h4">Only groups where (HAVING)</h4>
          {p.having.map((h, i) => (
            <div
              className="qf-builder__agg-row"
              key={h.key}
              role="group"
              aria-label={`Total filter ${i + 1}`}
            >
              <Select
                id={`qf-hv-agg-${h.key}`}
                labelText="Total"
                size="sm"
                value={h.aggregate}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  setHaving(h.key, { aggregate: e.target.value })
                }
              >
                {p.aggregates.map((a, j) => (
                  <SelectItem key={a.key} value={a.key} text={names[j]} />
                ))}
              </Select>
              <Select
                id={`qf-hv-op-${h.key}`}
                labelText="Condition"
                size="sm"
                value={h.op}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  setHaving(h.key, { op: e.target.value as HavingOp })
                }
              >
                {(Object.keys(HAVING_LABELS) as HavingOp[]).map((o) => (
                  <SelectItem key={o} value={o} text={HAVING_LABELS[o]} />
                ))}
              </Select>
              <TextInput
                id={`qf-hv-v-${h.key}`}
                labelText={h.op === 'BETWEEN' ? 'From' : 'Value'}
                size="sm"
                inputMode="decimal"
                value={h.value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setHaving(h.key, { value: e.target.value })
                }
              />
              {h.op === 'BETWEEN' && (
                <TextInput
                  id={`qf-hv-v2-${h.key}`}
                  labelText="To"
                  size="sm"
                  inputMode="decimal"
                  value={h.value2}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setHaving(h.key, { value2: e.target.value })
                  }
                />
              )}
              <Button
                kind="ghost"
                size="sm"
                hasIconOnly
                renderIcon={Close}
                iconDescription={`Remove total filter ${i + 1}`}
                onClick={() => p.onHaving(p.having.filter((x) => x.key !== h.key))}
              />
            </div>
          ))}
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Add}
            disabled={p.having.length >= MAX_HAVING}
            onClick={() =>
              p.onHaving([
                ...p.having,
                {
                  key: newExecutionId(),
                  aggregate: p.aggregates[0].key,
                  op: '>',
                  value: '',
                  value2: '',
                },
              ])
            }
          >
            Add total filter
          </Button>
        </>
      )}
    </section>
  );
}
