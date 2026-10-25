import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import type { AppUser } from '../auth/users.js';
import {
  NOT_FOUND,
  type AccessRole,
  type Report,
  type ReportRepository,
} from '../reports/reports.js';
import { AppError } from '../util/errors.js';
import { GROUP_NAME_RE, type GroupRepository } from './groups.js';

export type ShareRole = 'VIEWER' | 'EDITOR';
export interface Share {
  type: 'USER' | 'GROUP';
  id: string;
  role: ShareRole;
  displayName?: string;
}

export const sharesInputSchema = z.object({
  shares: z
    .array(
      z.object({
        type: z.enum(['USER', 'GROUP']),
        id: z.string().min(1).max(128),
        role: z.enum(['VIEWER', 'EDITOR']),
      }),
    )
    .max(200),
});

const RANK: Record<AccessRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };
export type Need = 'VIEW' | 'EDIT' | 'OWNER';
const NEED_RANK: Record<Need, number> = { VIEW: 1, EDIT: 2, OWNER: 3 };

/**
 * Central authorisation for saved reports. Every report endpoint resolves the
 * caller's effective role (OWNER / EDITOR / VIEWER) from QF_REPORTS.OWNER_ID and
 * QF_REPORT_SHARES (direct user shares and app-group shares) before acting.
 * Reports the caller cannot see are reported as 404 so their existence is not leaked.
 */
export class AccessService {
  private readonly shares: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly reports: ReportRepository,
    private readonly groups: GroupRepository,
  ) {
    this.shares = q(schema, T.shares);
  }

  async roleFor(user: Pick<AppUser, 'id'>, report: Report): Promise<AccessRole | null> {
    if (report.ownerId === user.id) return 'OWNER';
    const rows = await this.db.query<{
      PRINCIPAL_TYPE: string;
      PRINCIPAL_ID: string;
      SHARE_ROLE: string;
    }>(`SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE FROM ${this.shares} WHERE REPORT_ID = ?`, [
      report.id,
    ]);
    if (!rows.length) return null;
    const groups = rows.some((r) => r.PRINCIPAL_TYPE === 'GROUP')
      ? new Set(await this.groups.forUser(user.id))
      : new Set<string>();
    let best: AccessRole | null = null;
    for (const r of rows) {
      const match =
        (r.PRINCIPAL_TYPE === 'USER' && r.PRINCIPAL_ID === user.id) ||
        (r.PRINCIPAL_TYPE === 'GROUP' && groups.has(r.PRINCIPAL_ID));
      if (!match) continue;
      const role: AccessRole = r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER';
      if (!best || RANK[role] > RANK[best]) best = role;
    }
    return best;
  }

  /** Load a report and require at least `need`. Throws 404 when invisible, 403 when visible but insufficient. */
  async require(
    user: Pick<AppUser, 'id'>,
    reportId: string,
    need: Need,
  ): Promise<{ report: Report; access: AccessRole }> {
    const report = await this.reports.findById(reportId);
    if (!report) throw NOT_FOUND();
    const access = await this.roleFor(user, report);
    if (!access) throw NOT_FOUND();
    if (RANK[access] < NEED_RANK[need])
      throw new AppError(
        403,
        'FORBIDDEN',
        need === 'OWNER'
          ? 'Only the report owner can do this.'
          : 'You have view-only access to this report.',
      );
    return { report, access };
  }

  async listShares(reportId: string): Promise<Share[]> {
    const users = this.shares.replace(T.shares, T.users);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT S.PRINCIPAL_TYPE, S.PRINCIPAL_ID, S.SHARE_ROLE, U.DISPLAY_NAME
         FROM ${this.shares} S LEFT JOIN ${users} U ON S.PRINCIPAL_TYPE = 'USER' AND U.USER_ID = S.PRINCIPAL_ID
        WHERE S.REPORT_ID = ? ORDER BY S.PRINCIPAL_TYPE, S.PRINCIPAL_ID`,
      [reportId],
    );
    return rows.map((r) => ({
      type: r.PRINCIPAL_TYPE as 'USER' | 'GROUP',
      id: String(r.PRINCIPAL_ID),
      role: r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER',
      displayName: r.DISPLAY_NAME ? String(r.DISPLAY_NAME) : undefined,
    }));
  }

  /** Replace all shares of a report (owner only; caller has already checked). */
  async replaceShares(
    report: Report,
    by: string,
    shares: z.infer<typeof sharesInputSchema>['shares'],
    userExists: (id: string) => Promise<boolean>,
  ): Promise<Share[]> {
    const seen = new Set<string>();
    for (const s of shares) {
      const key = `${s.type}:${s.id}`;
      if (seen.has(key))
        throw new AppError(400, 'DUPLICATE_SHARE', 'Each user or group can be listed once.');
      seen.add(key);
      if (s.type === 'USER') {
        if (s.id === report.ownerId)
          throw new AppError(400, 'BAD_SHARE', 'The owner already has full access.');
        if (!(await userExists(s.id)))
          throw new AppError(400, 'UNKNOWN_USER', 'One of the selected users no longer exists.');
      } else if (!GROUP_NAME_RE.test(s.id)) {
        throw new AppError(400, 'BAD_GROUP', `"${s.id}" is not a valid group name.`);
      }
    }
    await this.db.transaction(async (tx) => {
      await tx.update(`DELETE FROM ${this.shares} WHERE REPORT_ID = ?`, [report.id]);
      for (const s of shares)
        await tx.update(
          `INSERT INTO ${this.shares} (REPORT_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, CREATED_BY, CREATED_AT)
           VALUES (?, ?, ?, ?, ?, ${NOW_UTC})`,
          [report.id, s.type, s.id, s.role, by],
        );
    });
    return this.listShares(report.id);
  }
}
