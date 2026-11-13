import { z } from 'zod';

/**
 * Friendly schedule cadences. They are stored as the equivalent 5-field cron expression in
 * QF_SCHEDULES.CRON_EXPR (always evaluated in the schedule's own IANA time zone), so the
 * scheduler has a single code path and older custom-cron schedules keep working.
 *
 * Monthly schedules offer days 1-28 plus "last day of the month": every month has those, so a
 * monthly schedule never silently skips a month (cron "0 7 31 * *" would skip seven of them).
 */
export const FREQUENCIES = ['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const cadenceSchema = z
  .object({
    frequency: z.enum(FREQUENCIES),
    /** 24-hour local time in the schedule's time zone, "HH:MM". */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 07:30.'),
    /** 0 = Sunday ... 6 = Saturday (WEEKLY only). */
    weekday: z.number().int().min(0).max(6).optional(),
    /** 1-28, or 'LAST' for the last day of the month (MONTHLY only). */
    dayOfMonth: z.union([z.number().int().min(1).max(28), z.literal('LAST')]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.frequency === 'WEEKLY' && c.weekday === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekday'],
        message: 'Choose a day of the week.',
      });
    if (c.frequency === 'MONTHLY' && c.dayOfMonth === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dayOfMonth'],
        message: 'Choose a day of the month (1-28 or the last day).',
      });
  });
export type Cadence = z.infer<typeof cadenceSchema>;

/** The cron expression a cadence is stored as. */
export function cadenceToCron(c: Cadence): string {
  const [h, m] = c.time.split(':').map(Number);
  switch (c.frequency) {
    case 'DAILY':
      return `${m} ${h} * * *`;
    case 'WEEKDAYS':
      return `${m} ${h} * * 1-5`;
    case 'WEEKLY':
      return `${m} ${h} * * ${c.weekday ?? 1}`;
    case 'MONTHLY':
      return `${m} ${h} ${c.dayOfMonth === 'LAST' ? 'L' : (c.dayOfMonth ?? 1)} * *`;
  }
}

const NUM = '(\\d{1,2})';
/** Recognise a stored cron expression that one of the friendly cadences produces; null otherwise. */
export function cronToCadence(expr: string): Cadence | null {
  const m = new RegExp(`^${NUM} ${NUM} (\\*|L|\\d{1,2}) \\* (\\*|1-5|\\d)$`).exec(
    expr.trim().replace(/\s+/g, ' '),
  );
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const [, , , dom, dow] = m;
  if (dom === '*' && dow === '*') return { frequency: 'DAILY', time };
  if (dom === '*' && dow === '1-5') return { frequency: 'WEEKDAYS', time };
  if (dom === '*' && /^\d$/.test(dow)) {
    const weekday = Number(dow);
    return weekday <= 6 ? { frequency: 'WEEKLY', time, weekday } : null;
  }
  if (dow === '*' && dom === 'L') return { frequency: 'MONTHLY', time, dayOfMonth: 'LAST' };
  if (dow === '*' && /^\d+$/.test(dom)) {
    const day = Number(dom);
    return day >= 1 && day <= 28 ? { frequency: 'MONTHLY', time, dayOfMonth: day } : null;
  }
  return null;
}

/** Plain-English description, e.g. "Every Monday at 07:00". The time zone is shown separately. */
export function describeCadence(c: Cadence | null, cron: string): string {
  if (!c) return `Custom (cron ${cron.trim()})`;
  switch (c.frequency) {
    case 'DAILY':
      return `Every day at ${c.time}`;
    case 'WEEKDAYS':
      return `Weekdays (Monday to Friday) at ${c.time}`;
    case 'WEEKLY':
      return `Every ${WEEKDAY_NAMES[c.weekday ?? 1]} at ${c.time}`;
    case 'MONTHLY':
      return c.dayOfMonth === 'LAST'
        ? `Monthly on the last day at ${c.time}`
        : `Monthly on day ${c.dayOfMonth} at ${c.time}`;
  }
}
