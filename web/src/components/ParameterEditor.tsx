import type React from 'react';
import { Button, Checkbox, Select, SelectItem, TextInput } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import type { ParameterDef, ParameterType } from '../api/types';

const TYPES: { value: ParameterType; text: string }[] = [
  { value: 'string', text: 'Text' },
  { value: 'integer', text: 'Integer' },
  { value: 'decimal', text: 'Decimal' },
  { value: 'date', text: 'Date (YYYY-MM-DD)' },
  { value: 'list', text: 'List of values' },
];

/** Count `?` markers outside string literals, delimited identifiers and comments (mirrors the server lexer). */
export function countMarkers(sql: string): number {
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < sql.length && !(sql[i] === q && sql[i + 1] !== q)) i += sql[i] === q ? 2 : 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '?') n++;
  }
  return n;
}

interface Props {
  sql: string;
  value: ParameterDef[];
  onChange(next: ParameterDef[]): void;
  readOnly?: boolean;
}

/** Define one typed parameter per `?` marker, in order. Values are bound by Mapepire, never spliced into SQL. */
export function ParameterEditor({ sql, value, onChange, readOnly }: Props) {
  const markers = countMarkers(sql);
  const set = (i: number, patch: Partial<ParameterDef>) =>
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const add = () =>
    onChange([
      ...value,
      {
        name: `p${value.length + 1}`,
        label: `Parameter ${value.length + 1}`,
        type: 'string',
        required: true,
        defaultValue: null,
      },
    ]);
  const mismatch = markers !== value.length;
  return (
    <div className="qf-params" aria-label="Report parameters">
      <p className={mismatch ? 'qf-params__hint qf-params__hint--warn' : 'qf-params__hint'}>
        {markers === 0 && value.length === 0
          ? 'Use ? in the SQL for each value users should supply when running (for example WHERE REGION = ?).'
          : `The SQL has ${markers} marker${markers === 1 ? '' : 's'} (?) and ${value.length} parameter${value.length === 1 ? '' : 's'} defined${mismatch ? ' — define exactly one per marker, in order.' : '.'}`}
      </p>
      {value.map((p, i) => (
        <div className="qf-param-row" key={i} data-testid="param-row">
          <span className="qf-param-row__index" aria-hidden>
            ?{i + 1}
          </span>
          <TextInput
            id={`pname-${i}`}
            labelText="Name"
            size="sm"
            value={p.name}
            readOnly={readOnly}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(i, { name: e.target.value })}
          />
          <TextInput
            id={`plabel-${i}`}
            labelText="Label"
            size="sm"
            value={p.label}
            readOnly={readOnly}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(i, { label: e.target.value })}
          />
          <Select
            id={`ptype-${i}`}
            labelText="Type"
            size="sm"
            value={p.type}
            disabled={readOnly}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              set(i, {
                type: e.target.value as ParameterType,
                options: e.target.value === 'list' ? (p.options ?? []) : undefined,
              })
            }
          >
            {TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value} text={t.text} />
            ))}
          </Select>
          <TextInput
            id={`pdefault-${i}`}
            labelText="Default"
            size="sm"
            placeholder={p.type === 'date' ? 'YYYY-MM-DD' : ''}
            value={p.defaultValue ?? ''}
            readOnly={readOnly}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              set(i, { defaultValue: e.target.value === '' ? null : e.target.value })
            }
          />
          {p.type === 'list' && (
            <TextInput
              id={`poptions-${i}`}
              labelText="List values (comma-separated)"
              size="sm"
              value={(p.options ?? []).map((o) => o.value).join(', ')}
              readOnly={readOnly}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                set(i, {
                  options: e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                    .map((v) => ({ value: v })),
                })
              }
            />
          )}
          <Checkbox
            id={`preq-${i}`}
            labelText="Required"
            checked={p.required}
            disabled={readOnly}
            onChange={(_: unknown, { checked }: { checked: boolean }) =>
              set(i, { required: checked })
            }
          />
          {!readOnly && (
            <Button
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={TrashCan}
              iconDescription={`Remove ${p.label}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <Button kind="tertiary" size="sm" renderIcon={Add} onClick={add}>
          Add parameter
        </Button>
      )}
    </div>
  );
}
