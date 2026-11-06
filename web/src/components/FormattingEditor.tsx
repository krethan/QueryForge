import { Button, Dropdown, Modal, Select, SelectItem, TextInput } from '@carbon/react';
import { ColorPalette } from '@carbon/icons-react';
import { useState } from 'react';
import type React from 'react';
import { ApiError, api } from '../api/client';
import { FORMAT_COLORS, type FormatColor, type FormatRule, type Formatting } from '../api/types';

const ops: FormatRule['op'][] = ['>', '>=', '<', '<=', '=', '<>', 'between', 'contains', 'is null'];
export function FormattingEditor({
  reportId,
  columns,
  formatting,
  onSaved,
  onError,
}: {
  reportId: string;
  columns: string[];
  formatting?: Formatting | null;
  onSaved(f: Formatting | null): void;
  onError(s: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<FormatRule[]>(formatting?.rules ?? []);
  const [busy, setBusy] = useState(false);
  const blank = (): FormatRule => ({
    column: columns[0] ?? '',
    op: '>',
    value: '',
    color: 'blue',
    scope: 'cell',
  });
  const patch = (i: number, v: Partial<FormatRule>) =>
    setRules((old) => old.map((r, j) => (j === i ? { ...r, ...v } : r)));
  return (
    <>
      <Button
        kind="ghost"
        size="sm"
        renderIcon={ColorPalette}
        onClick={() => {
          setRules(formatting?.rules ?? []);
          setOpen(true);
        }}
      >
        Conditional formatting
      </Button>
      <Modal
        open={open}
        modalHeading="Conditional formatting"
        modalLabel="Per report · stored with chart settings"
        primaryButtonText={busy ? 'Saving…' : 'Save rules'}
        secondaryButtonText="Cancel"
        preventCloseOnClickOutside
        onRequestClose={() => setOpen(false)}
        primaryButtonDisabled={busy}
        onRequestSubmit={async () => {
          setBusy(true);
          try {
            const f = rules.length ? { version: 1 as const, rules } : null;
            await api.setReportFormatting(reportId, f);
            onSaved(f);
            setOpen(false);
          } catch (e) {
            onError(e instanceof ApiError ? e.message : 'Could not save formatting');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Highlight a cell or an entire row. Works on normal, grouped, pivot and calculated results.
          Excel receives static fills and fonts, not formulas.
        </p>
        {rules.map((r, i) => (
          <div
            key={i}
            className="qf-format-rule"
            style={{ display: 'flex', gap: '.75rem', marginBlock: '1rem', alignItems: 'center' }}
          >
            <Dropdown
              id={`format-column-${i}`}
              titleText="Column"
              label="Select a column"
              items={columns}
              selectedItem={r.column}
              itemToString={(x) => x || ''}
              onChange={({ selectedItem }) => patch(i, { column: selectedItem! })}
            />
            <Dropdown
              id={`format-op-${i}`}
              titleText="Operator"
              label="Select an operator"
              items={ops}
              selectedItem={r.op}
              itemToString={(x) => x || ''}
              onChange={({ selectedItem }) => patch(i, { op: selectedItem! })}
            />
            {r.op !== 'is null' && (
              <TextInput
                id={`format-value-${i}`}
                labelText="Value"
                value={String(r.value ?? '')}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
                  patch(i, { value: e.target.value })
                }
              />
            )}
            {r.op === 'between' && (
              <TextInput
                id={`format-value2-${i}`}
                labelText="And"
                value={String(r.value2 ?? '')}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
                  patch(i, { value2: e.target.value })
                }
              />
            )}
            <Select
              id={`format-scope-${i}`}
              labelText="Highlight"
              value={r.scope}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
                patch(i, { scope: e.target.value as FormatRule['scope'] })
              }
            >
              <SelectItem value="cell" text="This cell" />
              <SelectItem value="row" text="Whole row" />
            </Select>
            <div>
              <label className="cds--label" htmlFor={`format-color-${i}`}>
                Colour
              </label>
              <select
                id={`format-color-${i}`}
                aria-label={`Colour ${i + 1}`}
                value={r.color}
                style={{
                  display: 'block',
                  height: '2.5rem',
                  marginTop: '.5rem',
                  background: FORMAT_COLORS.find((c) => c.id === r.color)?.bg,
                }}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
                  patch(i, { color: e.target.value as FormatColor })
                }
              >
                {FORMAT_COLORS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </div>
            <Button
              kind="ghost"
              hasIconOnly
              iconDescription="Remove rule"
              renderIcon={undefined}
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          kind="tertiary"
          size="sm"
          disabled={!columns.length || rules.length >= 20}
          onClick={() => setRules([...rules, blank()])}
        >
          + Add rule
        </Button>
      </Modal>
    </>
  );
}
