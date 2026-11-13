import { z } from 'zod';
import { toDbTimestamp } from '../db/schema.js';
import { dbTimestampToIso } from '../util/time.js';
import { AppError } from '../util/errors.js';

/**
 * Share expiry (migration 014). A report or folder share may carry EXPIRES_AT: the first instant
 * (UTC) at which it no longer gives access. NULL means it never expires.
 *
 * Every access check compares EXPIRES_AT with the current time on each request, so a share
 * stops working the moment it expires; nothing has to clean it up. An expired row stays until
 * the owner renews it (sets a new, future expiry or clears it) or removes it.
 *
 * At exactly EXPIRES_AT the share is already expired: access needs EXPIRES_AT > now.
 */

/** Where "now" comes from. Injected so tests can move time; production uses the system clock. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Furthest ahead an expiry may be set (about ten years). */
export const MAX_EXPIRY_MS = 10 * 366 * 24 * 60 * 60 * 1000;

/** Epoch milliseconds of a stored or requested expiry, or null for none / unreadable. */
export function expiryMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const iso = /[zZ]$|[+-]\d{2}:\d{2}$/.test(String(v).trim())
    ? String(v).trim()
    : dbTimestampToIso(v);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}

/** A stored EXPIRES_AT as ISO-8601 UTC, or null. */
export function expiryIso(v: unknown): string | null {
  const t = expiryMs(v);
  return t === null ? null : new Date(t).toISOString();
}

/**
 * True while a share with this EXPIRES_AT gives access at `now`. A value that cannot be read is
 * treated as expired (fail closed), never as "no expiry".
 */
export function shareActive(expiresAt: unknown, now: Date): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return true;
  const t = expiryMs(expiresAt);
  return t !== null && t > now.getTime();
}

/** Bind value for EXPIRES_AT (Db2 for i TIMESTAMP text, UTC) or null. */
export const expiryParam = (iso: string | null): string | null =>
  iso === null ? null : toDbTimestamp(new Date(iso));

/** SQL predicate "this share is in force", binding one parameter: activeParam(now). */
export const ACTIVE_SHARE = (alias: string) =>
  `(${alias}.EXPIRES_AT IS NULL OR ${alias}.EXPIRES_AT > CAST(? AS TIMESTAMP))`;
export const activeParam = (now: Date) => toDbTimestamp(now);

/**
 * Optional expiry on a share in a PUT body: an ISO-8601 date-time with a zone (the browser sends
 * the end of the chosen day in the sharer's time zone, as UTC). null clears it; leaving it out
 * keeps the share's current expiry (none for a new share).
 */
export const expiresAtInput = z.string().datetime({ offset: true }).nullable().optional();

/**
 * The expiry to store for one share, given what was asked for and what is stored now.
 * Unchanged values are kept as they are, even when already past, so saving a dialog that lists
 * an expired share does not fail; a new or changed expiry must be in the future (and no more
 * than about ten years ahead).
 */
export function resolveExpiry(
  requested: string | null | undefined,
  current: string | null,
  now: Date,
): string | null {
  if (requested === undefined) return current;
  if (requested === null) return null;
  const t = expiryMs(requested);
  if (t === null) throw new AppError(400, 'BAD_EXPIRY', 'The expiry date is not valid.');
  if (current !== null && expiryMs(current) === t) return current;
  if (t <= now.getTime())
    throw new AppError(400, 'EXPIRY_IN_PAST', 'An expiry date must be in the future.');
  if (t - now.getTime() > MAX_EXPIRY_MS)
    throw new AppError(400, 'EXPIRY_TOO_FAR', 'An expiry date can be at most ten years from now.');
  return new Date(t).toISOString();
}
