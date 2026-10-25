import { randomUUID } from 'node:crypto';
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

export type AuditAction = 'GRANT' | 'CHANGE' | 'REVOKE';
export interface ShareAuditEvent {
  id: string;
  reportId: string;
  action: AuditAction;
  principalType: 'USER' | 'GROUP';
  principalId: string;
  principalName?: string;
  oldRole: ShareRole | null;
  newRole: ShareRole | null;
  actorId: string;
  actorName?: string;
  /** ISO-8601 UTC */
  occurredAt: string;
}

/** Grant / change / revoke events needed to turn `before` into `after`. */
export function diffShares(
  before: Pick<Share, 'type' | 'id' | 'role'>[],
  after: Pick<Share, 'type' | 'id' | 'role'>[],
): {
  action: AuditAction;
  type: 'USER' | 'GROUP';
  id: string;
  oldRole: ShareRole | null;
  newRole: ShareRole | null;
}[] {
  const key = (s: { type: string; id: string }) => `${s.type}:${s.id}`;
  const old = new Map(before.map((s) => [key(s), s]));
  const out: ReturnType<typeof diffShares> = [];
  for (const s of after) {
    const o = old.get(key(s));
    if (!o) out.push({ action: 'GRANT', type: s.type, id: s.id, oldRole: null, newRole: s.role });
    else if (o.role !== s.role)
      out.push({ action: 'CHANGE', type: s.type, id: s.id, oldRole: o.role, newRole: s.role });
    old.delete(key(s));
  }
  for (const o of old.values())
    out.push({ action: 'REVOKE', type: o.type, id: o.id, oldRole: o.role, newRole: null });
  return out;
}

const dbTs = (v: unknown) => {
  const s = String(v ?? '');
  const m = /^(\d{4}-\d{2}-\d{2})[ T-](\d{2})[:.](\d{2})[:.](\d{2})(\.\d+)?/.exec(s);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}${(m[5] ?? '').slice(0, 4)}Z` : s;
};

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
  private readonly audit: string;
  private readonly users: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly reports: ReportRepository,
    private readonly groups: GroupRepository,
  ) {
    this.shares = q(schema, T.shares);
    this.audit = q(schema, T.shareAudit);
    this.users = q(schema, T.users);
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
      const current = await tx.query<{
        PRINCIPAL_TYPE: string;
        PRINCIPAL_ID: string;
        SHARE_ROLE: string;
      }>(
        `SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE FROM ${this.shares} WHERE REPORT_ID = ?`,
        [report.id],
      );
      const events = diffShares(
        current.map((r) => ({
          type: r.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
          id: String(r.PRINCIPAL_ID),
          role: r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER',
        })),
        shares,
      );
      // audit rows commit or roll back together with the share change
      for (const ev of events)
        await tx.update(
          `INSERT INTO ${this.audit} (AUDIT_ID, REPORT_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, ACTOR_ID, OCCURRED_AT)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
          [randomUUID(), report.id, ev.action, ev.type, ev.id, ev.oldRole, ev.newRole, by],
        );
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

  /** Sharing audit trail for one report, newest first (owner-only; caller has checked). */
  async listAudit(reportId: string, limit = 100): Promise<ShareAuditEvent[]> {
    const n = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT A.AUDIT_ID, A.REPORT_ID, A.ACTION, A.PRINCIPAL_TYPE, A.PRINCIPAL_ID, A.OLD_ROLE, A.NEW_ROLE,
              A.ACTOR_ID, A.OCCURRED_AT, ACT.DISPLAY_NAME AS ACTOR_NAME, PU.DISPLAY_NAME AS PRINCIPAL_NAME
         FROM ${this.audit} A
         LEFT JOIN ${this.users} ACT ON ACT.USER_ID = A.ACTOR_ID
         LEFT JOIN ${this.users} PU ON A.PRINCIPAL_TYPE = 'USER' AND PU.USER_ID = A.PRINCIPAL_ID
        WHERE A.REPORT_ID = ? ORDER BY A.OCCURRED_AT DESC, A.AUDIT_ID FETCH FIRST ${n} ROWS ONLY`,
      [reportId],
    );
    const role = (v: unknown): ShareRole | null =>
      v === 'EDITOR' ? 'EDITOR' : v === 'VIEWER' ? 'VIEWER' : null;
    return rows.map((r) => ({
      id: String(r.AUDIT_ID),
      reportId: String(r.REPORT_ID),
      action: r.ACTION as AuditAction,
      principalType: r.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
      principalId: String(r.PRINCIPAL_ID),
      principalName: r.PRINCIPAL_NAME ? String(r.PRINCIPAL_NAME) : undefined,
      oldRole: role(r.OLD_ROLE),
      newRole: role(r.NEW_ROLE),
      actorId: String(r.ACTOR_ID),
      actorName: r.ACTOR_NAME ? String(r.ACTOR_NAME) : undefined,
      occurredAt: dbTs(r.OCCURRED_AT),
    }));
  }
}
