import { useEffect, useRef } from 'react';
import {
  Button,
  Checkbox,
  InlineLoading,
  Select,
  SelectItem,
  SelectItemGroup,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, Calculation, Close } from '@carbon/icons-react';
import type { CalcType, CalcValidation } from '../api/types';
import { newExecutionId } from '../utils/format';

/** Editing state of one calculated field (validation results come from the server). */
export interface CalcRow {
  key: string;
  id: string;
  name: string;
  expression: string;
  status: 'idle' | 'checking' | 'ok' | 'error';
  type?: CalcType;
  hint?: string;
  error?: string;
  /** 0-based character position of the error, when known. */
  position?: number | null;
}

export const MAX_CALCULATED = 20;
export const MAX_EXPRESSION_LENGTH = 1000;
export const CALC_MARKER = 'ƒ';
export const FUNCTION_NAMES = [
  'COALESCE',
  'NULLIF',
  'ROUND',
  'ABS',
  'UPPER',
  'LOWER',
  'TRIM',
  'SUBSTR',
  'LENGTH',
  'YEAR',
  'MONTH',
  'DAY',
];
const NAME_RE = /^[A-Za-z0-9_ .#$@-]{1,64}$/;

/** A fresh field with a unique id and name. */
export function newCalcRow(existing: CalcRow[]): CalcRow {
  const ids = new Set(existing.map((r) => r.id.toUpperCase()));
  const names = new Set(existing.map((r) => r.name.toUpperCase()));
  let n = existing.length + 1;
  while (ids.has(`CALC${n}`) || names.has(`CALCULATED ${n}`)) n++;
  return {
    key: newExecutionId(),
    id: `CALC${n}`,
    name: `Calculated ${n}`,
    expression: '',
    status: 'idle',
  };
}

export const calcNameProblem = (row: CalcRow, all: CalcRow[]): string | null => {
  const name = row.name.trim();
  if (!name) return 'Enter a name.';
  if (!NAME_RE.test(name)) return 'Use letters, digits, spaces and _ . # $ @ - (up to 64).';
  if (all.some((r) => r.key !== row.key && r.name.trim().toUpperCase() === name.toUpperCase()))
    return 'Another calculated field has this name.';
  return null;
};

export interface FieldOption {
  group: string;
  /** Text inserted into the expression, e.g. QTY or O.REGION. */
  insert: string;
  text: string;
}

interface Props {
  rows: CalcRow[];
  fields: FieldOption[];
  validate(expression: string, signal: AbortSignal): Promise<CalcValidation>;
  isPicked(id: string): boolean;
  onToggleOutput(id: string, on: boolean): void;
  /** Functional update, so concurrent checks of several fields never overwrite each other. */
  onChange(update: (rows: CalcRow[]) => CalcRow[]): void;
  onRemove(id: string): void;
  /** Bumped when the report's tables change, so every field is re-checked. */
  context: string;
}

/** The "Calculated fields" panel of the Report Builder. */
export function CalculatedFields({
  rows,
  fields,
  validate,
  isPicked,
  onToggleOutput,
  onChange,
  onRemove,
  context,
}: Props) {
  const patch = (key: string, p: Partial<CalcRow>) =>
    onChange((list) => list.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <section className="qf-builder__section qf-calc" aria-label="Calculated fields">
      <h3 className="qf-builder__h3">
        <Calculation size={16} /> Calculated fields
      </h3>
      <p className="qf-muted">
        Build a value from other columns, e.g. <code>UNIT_PRICE * QTY</code> or{' '}
        <code>CASE WHEN QTY &gt;= 10 THEN &apos;Bulk&apos; ELSE &apos;Each&apos; END</code>. The
        server checks it against the catalog and writes the SQL; division by zero gives an empty
        value. Use calculated fields as columns, sorts, filters, groups and totals ({CALC_MARKER}{' '}
        marks them in the lists).
      </p>
      {rows.map((row) => (
        <CalcEditor
          key={row.key}
          row={row}
          all={rows}
          fields={fields}
          groups={groups}
          validate={validate}
          context={context}
          picked={isPicked(row.id)}
          onToggleOutput={(on) => onToggleOutput(row.id, on)}
          onPatch={(p) => patch(row.key, p)}
          onRemove={() => onRemove(row.id)}
        />
      ))}
      <Button
        kind="ghost"
        size="sm"
        renderIcon={Add}
        disabled={rows.length >= MAX_CALCULATED}
        onClick={() => onChange((list) => [...list, newCalcRow(list)])}
      >
        Add calculated field
      </Button>
    </section>
  );
}

interface EditorProps {
  row: CalcRow;
  all: CalcRow[];
  fields: FieldOption[];
  groups: string[];
  validate: Props['validate'];
  context: string;
  picked: boolean;
  onToggleOutput(on: boolean): void;
  onPatch(p: Partial<CalcRow>): void;
  onRemove(): void;
}

function CalcEditor({
  row,
  all,
  fields,
  groups,
  validate,
  context,
  picked,
  onToggleOutput,
  onPatch,
  onRemove,
}: EditorProps) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;
  const validateRef = useRef(validate);
  validateRef.current = validate;

  // Debounced server check of the expression (types, columns, syntax).
  useEffect(() => {
    const expr = row.expression;
    if (!expr.trim()) {
      patchRef.current({ status: 'idle', type: undefined, error: undefined, position: null });
      return;
    }
    const controller = new AbortController();
    patchRef.current({ status: 'checking' });
    const t = setTimeout(() => {
      validateRef
        .current(expr, controller.signal)
        .then((v) =>
          patchRef.current(
            v.ok
              ? { status: 'ok', type: v.type, hint: v.hint, error: undefined, position: null }
              : {
                  status: 'error',
                  type: undefined,
                  error: v.error.message,
                  position: v.error.position,
                },
          ),
        )
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError') return;
          patchRef.current({
            status: 'error',
            type: undefined,
            error: e instanceof Error ? e.message : String(e),
            position: null,
          });
        });
    }, 350);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [row.expression, context]);

  const insert = (text: string) => {
    const el = area.current;
    const v = row.expression;
    const start = el?.selectionStart ?? v.length;
    const end = el?.selectionEnd ?? v.length;
    const before = v.slice(0, start);
    const pad = before && !/[\s(,]$/.test(before) ? ' ' : '';
    const next = `${before}${pad}${text}${v.slice(end)}`.slice(0, MAX_EXPRESSION_LENGTH);
    onPatch({ expression: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const at = before.length + pad.length + text.length;
      el.setSelectionRange(at, at);
    });
  };

  const nameProblem = calcNameProblem(row, all);
  const where =
    row.status === 'error' && typeof row.position === 'number' && row.expression
      ? markAt(row.expression, row.position)
      : null;
  return (
    <fieldset className="qf-fieldset qf-calc__row" data-testid={`calc-${row.id}`}>
      <legend>
        {CALC_MARKER} {row.name.trim() || row.id}
      </legend>
      <div className="qf-calc__head">
        <TextInput
          id={`qb-calc-name-${row.key}`}
          labelText="Name"
          size="sm"
          value={row.name}
          maxLength={64}
          invalid={Boolean(nameProblem)}
          invalidText={nameProblem ?? undefined}
          onChange={(e: { target: { value: string } }) => onPatch({ name: e.target.value })}
        />
        <Select
          id={`qb-calc-field-${row.key}`}
          labelText="Insert field"
          size="sm"
          value=""
          onChange={(e: { target: { value: string } }) => {
            if (e.target.value) insert(e.target.value);
          }}
        >
          <SelectItem value="" text="Choose a column…" />
          {groups.map((g) => (
            <SelectItemGroup key={g} label={g}>
              {fields
                .filter((f) => f.group === g)
                .map((f) => (
                  <SelectItem key={f.insert} value={f.insert} text={f.text} />
                ))}
            </SelectItemGroup>
          ))}
          <SelectItemGroup label="Functions">
            {FUNCTION_NAMES.map((fn) => (
              <SelectItem key={fn} value={`${fn}(`} text={`${fn}( … )`} />
            ))}
          </SelectItemGroup>
        </Select>
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={Close}
          iconDescription={`Remove ${row.name || row.id}`}
          onClick={onRemove}
        />
      </div>
      <TextArea
        id={`qb-calc-expr-${row.key}`}
        labelText="Expression"
        rows={2}
        maxCount={MAX_EXPRESSION_LENGTH}
        enableCounter
        ref={area}
        className="qf-builder__mono"
        value={row.expression}
        invalid={row.status === 'error'}
        invalidText={row.error}
        placeholder="e.g. ROUND(UNIT_PRICE * QTY, 2)"
        onChange={(e: { target: { value: string } }) => onPatch({ expression: e.target.value })}
      />
      {where && (
        <pre className="qf-calc__where" aria-label="Error position">
          {where}
        </pre>
      )}
      <div className="qf-calc__status">
        {row.status === 'checking' && <InlineLoading description="Checking…" />}
        {row.status === 'ok' && row.type && (
          <Tag size="sm" type="green" title={`Result type: ${row.type}`}>
            Result: {row.hint ?? row.type}
            {row.type === 'integer' ? ' (whole)' : row.type === 'decimal' ? ' (decimal)' : ''}
          </Tag>
        )}
        <Checkbox
          id={`qb-calc-out-${row.key}`}
          labelText="Show as a column"
          checked={picked}
          disabled={row.status !== 'ok' && !picked}
          onChange={(_e: unknown, { checked }: { checked: boolean }) => onToggleOutput(checked)}
        />
      </div>
    </fieldset>
  );
}

/** The expression with a caret under the error position (long lines are windowed). */
function markAt(expr: string, pos: number) {
  const line = expr.replace(/\s/g, ' ');
  const from = Math.max(0, pos - 40);
  const shown = line.slice(from, from + 80);
  return `${from ? '…' : ''}${shown}\n${' '.repeat(pos - from + (from ? 1 : 0))}^`;
}
