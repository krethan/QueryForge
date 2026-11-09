import { z } from 'zod';
import { AppError } from '../util/errors.js';

/**
 * Rolling date values are stored as these names, never as a date captured when a report
 * was saved. Every value resolves on the server, immediately before the `?` is bound,
 * in the configured IANA zone (default UTC, not the browser's or IBM i's time zone).
 * Week starts Monday; quarters are calendar quarters. "Last N days" includes today (N=1 = Today); N is 1..3650.
 */
export const DATE_PRESETS = [
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'LAST_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_QUARTER',
  'LAST_QUARTER',
  'YTD',
  'LAST_YEAR',
  'LAST_N_DAYS',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export const DATE_PRESET_PREFIX = '$preset:';
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  TODAY: 'Today',
  YESTERDAY: 'Yesterday',
  THIS_WEEK: 'This week',
  LAST_WEEK: 'Last week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  THIS_QUARTER: 'This quarter',
  LAST_QUARTER: 'Last quarter',
  YTD: 'Year to date',
  LAST_YEAR: 'Last year',
  LAST_N_DAYS: 'Last N days',
};
export const datePresetSchema = z
  .object({
    preset: z.enum(DATE_PRESETS),
    n: z.number().int().min(1).max(3650).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.preset === 'LAST_N_DAYS' && v.n === undefined)
      ctx.addIssue({ code: 'custom', path: ['n'], message: 'Last N days needs N.' });
    if (v.preset !== 'LAST_N_DAYS' && v.n !== undefined)
      ctx.addIssue({ code: 'custom', path: ['n'], message: 'N only applies to Last N days.' });
  });
export interface DatePresetSpec {
  preset: DatePreset;
  n?: number;
}
export interface DateRange {
  from: string;
  to: string;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (y: number, m: number, day: number) => new Date(Date.UTC(y, m, day));
const add = (d: Date, days: number) =>
  at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days);

/** Encoded value kept in PARAMETER_JSON / BUILDER_DEF instead of a resolved date. */
export function datePresetValue(spec: DatePresetSpec): string {
  return DATE_PRESET_PREFIX + JSON.stringify(spec);
}

/** Both bounds, used by Report Builder date range filters (value/value2 or FROM/TO). */
const parts = (s: string) => s.split('-').map(Number);

/** Rolling dates have no time-of-day ambiguity; convert a UTC instant to its wall date in zone. */
export function dateInZone(now: Date, timeZone: string): Date {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    /* valid zone validated below */
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const text = fmt.format(now);
  const [y, m, d] = parts(text);
  return new Date(Date.UTC(y, m - 1, d));
}

export function datePresetRange(
  spec: DatePresetSpec,
  now = new Date(),
  timeZone = 'UTC',
): DateRange {
  const today = dateInZone(now, timeZone);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (spec.preset) {
    case 'TODAY':
      return { from: iso(today), to: iso(today) };
    case 'YESTERDAY': {
      const d = add(today, -1);
      return { from: iso(d), to: iso(d) };
    }
    case 'THIS_WEEK': {
      const from = add(today, -((today.getUTCDay() + 6) % 7));
      return { from: iso(from), to: iso(add(from, 6)) };
    }
    case 'LAST_WEEK': {
      const start = add(today, -((today.getUTCDay() + 6) % 7));
      return { from: iso(add(start, -7)), to: iso(add(start, -1)) };
    }
    case 'THIS_MONTH':
      return { from: iso(at(y, m, 1)), to: iso(at(y, m + 1, 0)) };
    case 'LAST_MONTH':
      return { from: iso(at(y, m - 1, 1)), to: iso(at(y, m, 0)) };
    case 'THIS_QUARTER': {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(at(y, q, 1)), to: iso(at(y, q + 3, 0)) };
    }
    case 'LAST_QUARTER': {
      const q = Math.floor(m / 3) * 3 - 3;
      return { from: iso(at(y, q, 1)), to: iso(at(y, q + 3, 0)) };
    }
    case 'YTD':
      return { from: iso(at(y, 0, 1)), to: iso(today) };
    case 'LAST_YEAR':
      return { from: iso(at(y - 1, 0, 1)), to: iso(at(y - 1, 11, 31)) };
    case 'LAST_N_DAYS': {
      if (!Number.isInteger(spec.n) || spec.n! < 1 || spec.n! > 3650)
        throw new AppError(
          400,
          'INVALID_DATE_PRESET',
          'Last N days needs a whole number from 1 to 3650.',
        );
      return { from: iso(add(today, -(spec.n! - 1))), to: iso(today) };
    }
  }
}
export function parseDatePreset(v: unknown): DatePresetSpec | null {
  if (v && typeof v === 'object') return canonicalDatePreset(v);
  if (typeof v !== 'string' || !v.startsWith(DATE_PRESET_PREFIX)) return null;
  try {
    const p = datePresetSchema.safeParse(JSON.parse(v.slice(DATE_PRESET_PREFIX.length)));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}
export function isDatePreset(v: unknown): boolean {
  return parseDatePreset(v) !== null;
}
export function canonicalDatePreset(v: unknown): DatePresetSpec | null {
  const r = datePresetSchema.safeParse(v);
  return r.success ? r.data : null;
}
