import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';

export type GroupSource = 'LOCAL' | 'OIDC' | 'LDAP';
export const GROUP_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Application group membership stored in Db2 for i (QF_USER_GROUPS). */
export class GroupRepository {
  private readonly table: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.userGroups);
  }

  async forUser(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ GROUP_NAME: string }>(
      `SELECT GROUP_NAME FROM ${this.table} WHERE USER_ID = ? ORDER BY GROUP_NAME`,
      [userId],
    );
    return rows.map((r) => String(r.GROUP_NAME));
  }

  async allNames(): Promise<string[]> {
    const rows = await this.db.query<{ GROUP_NAME: string }>(
      `SELECT DISTINCT GROUP_NAME FROM ${this.table} ORDER BY GROUP_NAME`,
    );
    return rows.map((r) => String(r.GROUP_NAME));
  }

  /** Replace the memberships that came from one source (IdP groups are re-synced at every sign-in). */
  async sync(userId: string, source: GroupSource, groups: string[]): Promise<void> {
    const unique = [...new Set(groups.filter((g) => GROUP_NAME_RE.test(g)))];
    await this.db.transaction(async (tx) => {
      await tx.update(`DELETE FROM ${this.table} WHERE USER_ID = ? AND SOURCE = ?`, [
        userId,
        source,
      ]);
      for (const g of unique) {
        await tx.update(
          `INSERT INTO ${this.table} (USER_ID, GROUP_NAME, SOURCE, CREATED_AT) VALUES (?, ?, ?, ${NOW_UTC})`,
          [userId, g, source],
        );
      }
    });
  }
}

/** Map IdP / directory group names to application groups using GROUP_MAP. Unmapped groups are dropped. */
export function mapExternalGroups(external: string[], map: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const g of external) {
    const m = map.get(g.trim().toLowerCase());
    if (m) out.add(m);
  }
  return [...out].sort();
}
