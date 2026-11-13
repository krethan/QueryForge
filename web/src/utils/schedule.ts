import type { Schedule, ScheduleCadence, ScheduleFrequency } from '../api/types';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const FREQUENCY_OPTIONS: { value: ScheduleFrequency | 'CUSTOM'; text: string }[] = [
  { value: 'DAILY', text: 'Daily' },
  { value: 'WEEKDAYS', text: 'Weekdays (Monday to Friday)' },
  { value: 'WEEKLY', text: 'Weekly' },
  { value: 'MONTHLY', text: 'Monthly' },
  { value: 'CUSTOM', text: 'Custom (cron expression)' },
];

export const DEFAULT_CADENCE: ScheduleCadence = { frequency: 'WEEKLY', time: '07:00', weekday: 1 };

/** Same wording as the server's describeCadence(). */
export function describeCadence(c: ScheduleCadence | null, cron = ''): string {
  if (!c) return `Custom (cron ${cron.trim()})`;
  switch (c.frequency) {
    case 'DAILY':
      return `Every day at ${c.time}`;
    case 'WEEKDAYS':
      return `Weekdays (Monday to Friday) at ${c.time}`;
    case 'WEEKLY':
      return `Every ${WEEKDAYS[c.weekday ?? 1]} at ${c.time}`;
    case 'MONTHLY':
      return c.dayOfMonth === 'LAST'
        ? `Monthly on the last day at ${c.time}`
        : `Monthly on day ${c.dayOfMonth} at ${c.time}`;
  }
}

export const scheduleStatusTag: Record<Schedule['lastStatus'], 'gray' | 'blue' | 'green' | 'red'> =
  {
    NEVER: 'gray',
    RUNNING: 'blue',
    SUCCEEDED: 'green',
    FAILED: 'red',
  };

/** Split pasted addresses on commas, semicolons and whitespace. */
export const splitAddresses = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
