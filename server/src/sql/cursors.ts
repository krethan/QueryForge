import { randomUUID } from 'node:crypto';
import type { QueryLike, SqlJobLike } from '../db/types.js';
import { AppError } from '../util/errors.js';
import type { ResultColumn } from './results.js';

/** Why a cursor was closed; passed to the onClose hook (history bookkeeping). */
export type CursorCloseReason =
  'COMPLETE' | 'LIMIT' | 'CLOSED' | 'EXPIRED' | 'EVICTED' | 'ERROR' | 'SHUTDOWN';

export interface CursorEntry {
  id: string;
  ownerId: string;
  executionId: string;
  job: SqlJobLike;
  query: QueryLike<unknown>;
  columns: ResultColumn[];
  rowCount: number;
  maxRows: number;
  createdAt: number;
  /** Sliding idle expiry, never later than createdAt + max lifetime. */
  expiresAt: number;
  busy: boolean;
  onClose?: (e: CursorEntry, reason: CursorCloseReason) => void | Promise<void>;
}

export interface CursorLimits {
  idleTtlMs: number;
  maxLifetimeMs: number;
  maxOpen: number;
  maxOpenPerUser: number;
}

export const CURSOR_GONE = () =>
  new AppError(
    410,
    'CURSOR_EXPIRED',
    'These results are no longer available on the server (the paging session expired or was closed). Run the query again to continue.',
  );

/**
 * Short-lived server-side result cursors. Each entry owns one open Mapepire job
 * and Query (read-only reporting identity) so further pages can be read with
 * Query.fetchMore. Entries are bound to the user who opened them, expire after
 * an idle TTL and a hard maximum lifetime, are capped globally and per user, and
 * are swept on a timer; closing an entry always closes its query and job.
 */
export class ResultCursorStore {
  private readonly entries = new Map<string, CursorEntry>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly limits: CursorLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  countFor(ownerId: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.ownerId === ownerId) n++;
    return n;
  }

  /** Start the periodic sweep (unref'd so it never keeps the process alive). */
  start(intervalMs = Math.max(1000, Math.min(15_000, Math.floor(this.limits.idleTtlMs / 4)))) {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), intervalMs);
    this.sweeper.unref?.();
  }

  /**
   * Register an open job/query. When the user is at their limit their oldest
   * cursor is closed first (a new run supersedes an abandoned one). Returns null
   * when the global limit is reached and nothing of this user's can be evicted;
   * the caller must then close the job itself.
   */
  async add(
    e: Omit<CursorEntry, 'id' | 'createdAt' | 'expiresAt' | 'busy'>,
  ): Promise<CursorEntry | null> {
    await this.sweep();
    while (this.countFor(e.ownerId) >= this.limits.maxOpenPerUser) {
      const oldest = [...this.entries.values()]
        .filter((x) => x.ownerId === e.ownerId && !x.busy)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) return null;
      await this.close(oldest.id, 'EVICTED');
    }
    if (this.entries.size >= this.limits.maxOpen) return null;
    const t = this.now();
    const entry: CursorEntry = {
      ...e,
      id: randomUUID(),
      createdAt: t,
      expiresAt: Math.min(t + this.limits.idleTtlMs, t + this.limits.maxLifetimeMs),
      busy: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Look up a live cursor owned by the user and mark it busy. 410 when expired, 404 when not theirs. */
  checkout(id: string, ownerId: string): CursorEntry {
    const e = this.entries.get(id);
    if (!e) throw CURSOR_GONE();
    if (e.ownerId !== ownerId) throw new AppError(404, 'NOT_FOUND', 'Result cursor not found.');
    if (this.now() >= e.expiresAt) {
      void this.close(id, 'EXPIRED');
      throw CURSOR_GONE();
    }
    if (e.busy) throw new AppError(409, 'CURSOR_BUSY', 'The next page is already being fetched.');
    e.busy = true;
    return e;
  }

  /** Return a cursor after a successful fetch, refreshing its idle TTL (capped by max lifetime). */
  checkin(e: CursorEntry) {
    e.busy = false;
    e.expiresAt = Math.min(
      this.now() + this.limits.idleTtlMs,
      e.createdAt + this.limits.maxLifetimeMs,
    );
  }

  /** Close a cursor owned by the user. Returns false if unknown or not owned. */
  async closeOwned(id: string, ownerId: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.ownerId !== ownerId) return false;
    await this.close(id, 'CLOSED');
    return true;
  }

  async close(id: string, reason: CursorCloseReason): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    await e.query.close().catch(() => undefined);
    await e.job.close().catch(() => undefined);
    try {
      await e.onClose?.(e, reason);
    } catch {
      /* bookkeeping must never keep a connection open */
    }
  }

  /** Close every cursor past its expiry (busy cursors are closed by their own timeout). */
  async sweep(): Promise<number> {
    const t = this.now();
    const expired = [...this.entries.values()].filter((e) => !e.busy && t >= e.expiresAt);
    await Promise.all(expired.map((e) => this.close(e.id, 'EXPIRED')));
    return expired.length;
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.all([...this.entries.keys()].map((id) => this.close(id, 'SHUTDOWN')));
  }
}
