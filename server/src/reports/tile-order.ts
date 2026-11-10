import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';

/** Most tiles one saved order may list. Larger dashboards keep the tail in default order. */
export const MAX_TILE_ORDER = 2000;

export const tileOrderInputSchema = z
  .object({
    reportIds: z
      .array(z.string().uuid())
      .max(MAX_TILE_ORDER, `At most ${MAX_TILE_ORDER} tiles can be ordered.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Each report can be listed once.'),
  })
  .strict();

/**
 * Sort reports by the user's saved tile positions. Reports with a saved position come first,
 * in that order; reports without one (new reports, or reports newly shared with the user)
 * follow in the order they arrived (the default sort). Stable, never adds or drops a report,
 * so it can only reorder what the caller has already authorised.
 */
export function applyTileOrder<R extends { id: string }>(
  reports: R[],
  positions: Map<string, number>,
): R[] {
  return reports
    .map((r, i) => ({ r, i, p: positions.get(r.id) }))
    .sort((a, b) => {
      if (a.p !== undefined && b.p !== undefined) return a.p - b.p || a.i - b.i;
      if (a.p !== undefined) return -1;
      if (b.p !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/**
 * Per-user dashboard tile order (migration 008). Every statement is parameterised and scoped
 * by the signed-in user's ID. The repository stores whatever list it is given; callers must
 * first reduce the list to reports the user can see (see the /dashboard/tile-order route).
 */
export class TileOrderRepository {
  private readonly table: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.tileOrder);
  }

  /** Saved report positions for the user (may include reports they can no longer see). */
  async positions(userId: string): Promise<Map<string, number>> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT REPORT_ID, TILE_POS FROM ${this.table} WHERE USER_ID = ? ORDER BY TILE_POS`,
      [userId],
    );
    return new Map(rows.map((r) => [String(r.REPORT_ID), Number(r.TILE_POS)]));
  }

  /** Replace the user's whole order in one transaction (positions 0..n-1). */
  async replace(userId: string, reportIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(`DELETE FROM ${this.table} WHERE USER_ID = ?`, [userId]);
      for (const [i, id] of reportIds.entries())
        await tx.update(
          `INSERT INTO ${this.table} (USER_ID, REPORT_ID, TILE_POS, UPDATED_AT) VALUES (?, ?, ?, ${NOW_UTC})`,
          [userId, id, i],
        );
    });
  }

  /** Forget the user's order; the dashboard goes back to the default order. */
  async clear(userId: string): Promise<number> {
    return this.db.update(`DELETE FROM ${this.table} WHERE USER_ID = ?`, [userId]);
  }
}
