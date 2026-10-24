import cronParser from 'cron-parser';
import { AppError } from '../util/errors.js';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next occurrence strictly after `from`, evaluated in the schedule's IANA time zone. */
export function nextRun(expr: string, tz: string, from: Date = new Date()): Date {
  return cronParser.parseExpression(expr, { tz, currentDate: from }).next().toDate();
}

/**
 * Validate a standard 5-field cron expression (minute hour day-of-month month day-of-week)
 * and enforce the minimum interval between runs.
 */
export function validateCron(
  expr: string,
  tz: string,
  minIntervalMinutes: number,
  from = new Date(),
): Date[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new AppError(
      400,
      'INVALID_CRON',
      'Use a 5-field cron expression: minute hour day month weekday.',
    );
  if (!isValidTimezone(tz))
    throw new AppError(400, 'INVALID_TIMEZONE', `Unknown time zone "${tz}".`);
  let it;
  try {
    it = cronParser.parseExpression(expr.trim(), { tz, currentDate: from });
  } catch (e) {
    throw new AppError(400, 'INVALID_CRON', `Invalid cron expression: ${(e as Error).message}`);
  }
  const next: Date[] = [];
  for (let i = 0; i < 6; i++) next.push(it.next().toDate());
  for (let i = 1; i < next.length; i++) {
    if (next[i].getTime() - next[i - 1].getTime() < minIntervalMinutes * 60_000)
      throw new AppError(
        400,
        'SCHEDULE_TOO_FREQUENT',
        `Schedules may run at most once every ${minIntervalMinutes} minutes.`,
      );
  }
  return next.slice(0, 5);
}
