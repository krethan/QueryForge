import type { ParameterDef } from '../api/types';
import { parseDatePresetValue } from '../api/types';
import type { DatePresetChoice } from './DatePresetFields';

/** Server-issued encoded rolling range; never evaluates the preset in the browser. */
export function encodePresetChoice(v: DatePresetChoice): string | null {
  return v.choice
    ? '$preset:' +
        JSON.stringify({ preset: v.choice, ...(v.choice === 'LAST_N_DAYS' ? { n: v.n } : {}) })
    : null;
}
/** Store the preset as the authoritative default on both bounds of an asked range. */
export function setPreset(
  defs: ParameterDef[],
  name: string,
  encoded: string | null,
): ParameterDef[] {
  const parsed = parseDatePresetValue(encoded);
  const datePreset = parsed
    ? {
        preset: parsed.choice as NonNullable<ParameterDef['datePreset']>['preset'],
        ...(parsed.n ? { n: parsed.n } : {}),
      }
    : null;
  const lower = name.endsWith('_FROM')
    ? name.slice(0, -5)
    : defs.some((d) => d.name === `${name}_TO`)
      ? name
      : null;
  return defs.map((d) =>
    d.name === name || (lower && d.name === `${lower}_TO`)
      ? { ...d, defaultValue: encoded, datePreset }
      : d,
  );
}
