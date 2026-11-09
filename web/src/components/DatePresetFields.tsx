import type React from 'react';
import { Select, SelectItem, TextInput } from '@carbon/react';
import { DATE_PRESET_CHOICES } from '../api/types';

import type { DatePresetType } from '../api/types';
export { encodePresetChoice } from './datePresetState';
export interface DatePresetChoice {
  choice: '' | DatePresetType;
  n?: number;
}

interface Props {
  id: string;
  label?: string;
  value: DatePresetChoice;
  onChange(value: DatePresetChoice): void;
  /** Dates supplied by the server instead of the browser when enabled. */
  rolling?: boolean;
}

/** Rolling date selection shared by parameter prompts, filter rows and schedules. */
export function DatePresetSelect({ id, label = 'Date range', value, onChange }: Props) {
  return (
    <>
      <Select
        id={id}
        labelText={label}
        size="sm"
        value={value.choice}
        onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
          onChange({
            choice: e.target.value as DatePresetChoice['choice'],
            ...(e.target.value === 'LAST_N_DAYS' ? { n: value.n ?? 30 } : {}),
          })
        }
      >
        {DATE_PRESET_CHOICES.map((p) => (
          <SelectItem key={p.value} value={p.value} text={p.text} />
        ))}
      </Select>
      {value.choice === 'LAST_N_DAYS' && (
        <TextInput
          id={`${id}-n`}
          labelText="Number of days (includes today)"
          type="number"
          min={1}
          max={3650}
          size="sm"
          value={String(value.n ?? 30)}
          invalid={!Number.isInteger(value.n) || (value.n ?? 0) < 1 || (value.n ?? 0) > 3650}
          invalidText="1–3650 days"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange({ choice: 'LAST_N_DAYS', n: Number(e.currentTarget.value) })
          }
        />
      )}
    </>
  );
}

/** Decode the server-stored opaque preset for display; never resolve its dates in the browser. */
export function presetChoice(p: {
  defaultValue: string | null;
  datePreset?: { preset: string; n?: number } | null;
}): DatePresetChoice {
  // The encoded default is authoritative; stale editor metadata must not revive an old range.
  if (p.defaultValue?.startsWith('$preset:')) {
    try {
      const v = JSON.parse(p.defaultValue.slice(8)) as { preset: string; n?: number };
      return DATE_PRESET_CHOICES.some((x) => x.value === v.preset)
        ? { choice: v.preset as DatePresetChoice['choice'], ...(v.n ? { n: v.n } : {}) }
        : { choice: '' };
    } catch {
      return { choice: '' };
    }
  }
  return { choice: '' };
}
