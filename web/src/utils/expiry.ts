/**
 * Share expiry in the browser (migration 014). The server stores an instant (UTC) and refuses
 * access from that instant on. People pick a day instead: a share "until 20 Nov" works through
 * the end of 20 Nov in the sharer's own time zone, so the stored instant is the start (00:00)
 * of the next day there. Picking today keeps access until midnight tonight.
 */

const pad = (n: number) => String(n).padStart(2, '0');
/** A Date as YYYY-MM-DD in the browser's time zone. */
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Today, YYYY-MM-DD, in the browser's time zone (the earliest day a share can run until). */
export const todayLocal = (now: Date = new Date()) => localDate(now);

/** The instant (ISO-8601 UTC) a share picked to run "until `day`" stops: next local midnight. */
export function endOfDayIso(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The last day (YYYY-MM-DD, local) a share with this expiry works: the day before it stops. */
export function lastDayOf(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? '' : localDate(new Date(t - 1));
}

/** True once the expiry instant has been reached (the server says the same on every request). */
export const isExpired = (expiresAt: string | null | undefined, now: number = Date.now()) =>
  Boolean(expiresAt) && Date.parse(expiresAt!) <= now;

/** "20 Nov 2026" style text for the last day of access. */
export function formatLastDay(expiresAt: string | null | undefined): string {
  const day = lastDayOf(expiresAt);
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** The browser's IANA time zone name, for the "ends at the end of the day in …" hint. */
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your time zone';
  } catch {
    return 'your time zone';
  }
};

/** One audit event's expiry change, in words, or '' when the expiry did not change. */
export function describeExpiryChange(
  who: string,
  actor: string,
  oldExpiresAt: string | null | undefined,
  newExpiresAt: string | null | undefined,
): string {
  const before = oldExpiresAt ? formatLastDay(oldExpiresAt) : '';
  const after = newExpiresAt ? formatLastDay(newExpiresAt) : '';
  if (!before && after) return `${actor} set ${who}'s access to end after ${after}`;
  if (before && !after) return `${actor} removed the end date from ${who}'s access`;
  if (before && after)
    return `${actor} changed ${who}'s access to end after ${after} (was ${before})`;
  return '';
}

/** "until 20 Nov 2026" for a share that has an end date and has not reached it. */
export const untilText = (expiresAt: string | null | undefined) =>
  expiresAt && !isExpired(expiresAt) ? `until ${formatLastDay(expiresAt)}` : '';
