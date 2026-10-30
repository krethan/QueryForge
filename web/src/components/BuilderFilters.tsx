import type React from 'react';
import {
  Button,
  Checkbox,
  Select,
  SelectItem,
  SelectItemGroup,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, Close, Filter } from '@carbon/icons-react';
import type { FilterLogic, FilterOp } from '../api/types';
import {
  MAX_FILTERS,
  MAX_GROUPS,
  MAX_IN_VALUES,
  OP_LABELS,
  canAsk,
  filterProblems,
  opsFor,
  splitValues,
  suggestParamName,
  takesValue,
  type FilterNode,
  type FilterRow,
  type ValueKind,
} from '../utils/builderState';
import { newExecutionId } from '../utils/format';

export interface ColumnChoice {
  label: string;
  items: { value: string; text: string }[];
}

interface Props {
  nodes: FilterNode[];
  logic: FilterLogic;
  columns: ColumnChoice[];
  kindOf(pick: string): ValueKind;
  nameOf(pick: string): string;
  onChange(nodes: FilterNode[]): void;
  onLogic(logic: FilterLogic): void;
}

const KIND_HINT: Record<ValueKind, string> = {
  integer: 'Whole number',
  decimal: 'Number',
  date: 'YYYY-MM-DD',
  time: 'HH:MM:SS',
  timestamp: 'YYYY-MM-DD HH:MM:SS',
  text: 'Text',
  none: '',
};

export function newFilterRow(pick = ''): FilterRow {
  return {
    key: newExecutionId(),
    pick,
    op: '=',
    value: '',
    value2: '',
    values: '',
    ask: false,
    askName: '',
    askLabel: '',
  };
}

const countRows = (nodes: FilterNode[]) =>
  nodes.reduce((n, x) => n + (x.kind === 'row' ? 1 : x.rows.length), 0);

/** Filter rows ("WHERE"): every value is sent to the server and bound to a `?` marker. */
export function BuilderFilters({
  nodes,
  logic,
  columns,
  kindOf,
  nameOf,
  onChange,
  onLogic,
}: Props) {
  const total = countRows(nodes);
  const groups = nodes.filter((n) => n.kind === 'group').length;
  const firstPick = columns[0]?.items[0]?.value ?? '';
  const usedNames = () =>
    new Set(
      nodes
        .flatMap((n) => (n.kind === 'row' ? [n] : n.rows))
        .filter((r) => r.ask)
        .map((r) => r.askName.toUpperCase()),
    );

  const patchRow = (key: string, patch: Partial<FilterRow>) =>
    onChange(
      nodes.map((n) =>
        n.kind === 'row'
          ? n.key === key
            ? { ...n, ...patch }
            : n
          : { ...n, rows: n.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) },
      ),
    );
  const removeRow = (key: string) =>
    onChange(
      nodes
        .filter((n) => !(n.kind === 'row' && n.key === key))
        .map((n) => (n.kind === 'group' ? { ...n, rows: n.rows.filter((r) => r.key !== key) } : n))
        .filter((n) => n.kind === 'row' || n.rows.length > 0),
    );

  const renderRow = (row: FilterRow, n: number, scope: string) => {
    const kind = kindOf(row.pick);
    const ops = row.pick ? opsFor(kind) : opsFor('text');
    const problem = row.pick ? filterProblems(row, kind) : null;
    const name = row.pick ? nameOf(row.pick) : `filter ${n}`;
    const inputType = kind === 'date' ? 'date' : 'text';
    const inputMode = kind === 'integer' ? 'numeric' : kind === 'decimal' ? 'decimal' : undefined;
    const valueLabel = row.ask ? 'Default (optional)' : 'Value';
    const set =
      (field: keyof FilterRow) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        patchRow(row.key, { [field]: e.target.value });
    return (
      <div
        className={`qf-filter-row${row.ask ? ' qf-filter-row--ask' : ''}`}
        key={row.key}
        role="group"
        aria-label={`${scope} filter ${n}`}
      >
        <Select
          id={`qf-f-col-${row.key}`}
          labelText="Column"
          size="sm"
          value={row.pick}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            const pick = e.target.value;
            const k = kindOf(pick);
            const op = opsFor(k).includes(row.op) ? row.op : opsFor(k)[0];
            patchRow(row.key, { pick, op, ask: row.ask && canAsk(op) });
          }}
        >
          <SelectItem value="" text="Choose column" />
          {columns.length === 1
            ? columns[0].items.map((c) => (
                <SelectItem key={c.value} value={c.value} text={c.text} />
              ))
            : columns.map((g) => (
                <SelectItemGroup key={g.label} label={g.label}>
                  {g.items.map((c) => (
                    <SelectItem key={c.value} value={c.value} text={c.text} />
                  ))}
                </SelectItemGroup>
              ))}
        </Select>
        <Select
          id={`qf-f-op-${row.key}`}
          labelText="Condition"
          size="sm"
          value={row.op}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            const op = e.target.value as FilterOp;
            patchRow(row.key, { op, ask: row.ask && canAsk(op) });
          }}
        >
          {ops.map((o) => (
            <SelectItem key={o} value={o} text={OP_LABELS[o]} />
          ))}
        </Select>
        {takesValue(row.op) && row.op === 'IN' && (
          <TextArea
            id={`qf-f-in-${row.key}`}
            labelText={`Values (one per line, max ${MAX_IN_VALUES})`}
            rows={2}
            value={row.values}
            helperText={`${splitValues(row.values).length} value(s) · ${KIND_HINT[kind]}`}
            onChange={set('values')}
          />
        )}
        {takesValue(row.op) && row.op !== 'IN' && (
          <TextInput
            id={`qf-f-v-${row.key}`}
            labelText={row.op === 'BETWEEN' ? `${valueLabel}: from` : valueLabel}
            size="sm"
            type={inputType}
            inputMode={inputMode}
            placeholder={KIND_HINT[kind]}
            value={row.value}
            onChange={set('value')}
          />
        )}
        {row.op === 'BETWEEN' && (
          <TextInput
            id={`qf-f-v2-${row.key}`}
            labelText={row.ask ? 'Default: to' : 'to'}
            size="sm"
            type={inputType}
            inputMode={inputMode}
            placeholder={KIND_HINT[kind]}
            value={row.value2}
            onChange={set('value2')}
          />
        )}
        {canAsk(row.op) && row.pick && (
          <Checkbox
            id={`qf-f-ask-${row.key}`}
            labelText="Ask when run"
            checked={row.ask}
            onChange={(_e: unknown, { checked }: { checked: boolean }) => {
              const col = nameOf(row.pick).split('.').pop() ?? 'VALUE';
              patchRow(row.key, {
                ask: checked,
                askName: checked && !row.askName ? suggestParamName(col, usedNames()) : row.askName,
                askLabel: checked && !row.askLabel ? col.replace(/_/g, ' ') : row.askLabel,
              });
            }}
          />
        )}
        {row.ask && (
          <>
            <TextInput
              id={`qf-f-pname-${row.key}`}
              labelText="Parameter name"
              size="sm"
              maxLength={30}
              value={row.askName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patchRow(row.key, { askName: e.target.value.toUpperCase() })
              }
            />
            <TextInput
              id={`qf-f-plabel-${row.key}`}
              labelText="Prompt"
              size="sm"
              maxLength={80}
              value={row.askLabel}
              onChange={set('askLabel')}
            />
          </>
        )}
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={Close}
          iconDescription={`Remove ${scope.toLowerCase()} filter ${n} (${name})`}
          onClick={() => removeRow(row.key)}
        />
        {problem && (
          <div className="qf-error-text qf-filter-row__problem" role="status">
            {problem}
          </div>
        )}
        {row.ask && !problem && (
          <div className="qf-muted qf-filter-row__problem">
            {row.op === 'BETWEEN'
              ? `Prompts for ${row.askName}_FROM and ${row.askName}_TO when the report runs.`
              : `Prompts for ${row.askName} when the report runs.`}
          </div>
        )}
      </div>
    );
  };

  let n = 0;
  return (
    <section className="qf-builder__filters" aria-label="Filters">
      <h3 className="qf-builder__h3">
        <Filter size={16} /> Filters
      </h3>
      {nodes.length === 0 ? (
        <p className="qf-muted">No filters: every row is returned.</p>
      ) : (
        <Select
          id="qf-f-logic"
          labelText="Rows must match"
          size="sm"
          inline
          value={logic}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            onLogic(e.target.value as FilterLogic)
          }
        >
          <SelectItem value="AND" text="all of these (AND)" />
          <SelectItem value="OR" text="any of these (OR)" />
        </Select>
      )}
      {nodes.map((node) => {
        if (node.kind === 'row') return renderRow(node, ++n, 'Top-level');
        const g = node;
        return (
          <fieldset className="qf-filter-group" key={g.key}>
            <legend>
              <Select
                id={`qf-g-logic-${g.key}`}
                labelText="Group matches"
                size="sm"
                inline
                value={g.logic}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  onChange(
                    nodes.map((x) =>
                      x.key === g.key ? { ...g, logic: e.target.value as FilterLogic } : x,
                    ),
                  )
                }
              >
                <SelectItem value="AND" text="all (AND)" />
                <SelectItem value="OR" text="any (OR)" />
              </Select>
            </legend>
            {g.rows.map((r) => renderRow(r, ++n, 'Group'))}
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Add}
              disabled={total >= MAX_FILTERS}
              onClick={() =>
                onChange(
                  nodes.map((x) =>
                    x.key === g.key ? { ...g, rows: [...g.rows, newFilterRow(firstPick)] } : x,
                  ),
                )
              }
            >
              Add to group
            </Button>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Close}
              onClick={() => onChange(nodes.filter((x) => x.key !== g.key))}
            >
              Remove group
            </Button>
          </fieldset>
        );
      })}
      <div className="qf-builder__join-actions">
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          disabled={total >= MAX_FILTERS || !firstPick}
          onClick={() => onChange([...nodes, { kind: 'row', ...newFilterRow(firstPick) }])}
        >
          Add filter
        </Button>
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          disabled={total >= MAX_FILTERS || groups >= MAX_GROUPS || !firstPick}
          onClick={() =>
            onChange([
              ...nodes,
              {
                kind: 'group',
                key: newExecutionId(),
                logic: logic === 'AND' ? 'OR' : 'AND',
                rows: [newFilterRow(firstPick), newFilterRow(firstPick)],
              },
            ])
          }
        >
          Add group
        </Button>
      </div>
    </section>
  );
}
