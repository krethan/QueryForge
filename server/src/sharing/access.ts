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
import type { FolderReportGrants } from './folder-report-grants.js';
import {
  expiresAtInput,
  expiryIso,
  expiryParam,
  resolveExpiry,
  shareActive,
  systemClock,
  type Clock,
} from './expiry.js';

export type ShareRole = 'VIEWER' | 'EDITOR';
export interface Share {
  type: 'USER' | 'GROUP';
  id: string;
  role: ShareRole;
  displayName?: string;
  /**
   * The instant (ISO-8601 UTC) the share stops giving access (migration 014), or null: never.
   * In a PUT body, leaving it out keeps the share's current expiry and null clears it.
   */
  expiresAt?: string | null;
  /** True once expiresAt has passed: the share gives no access until it is renewed. */
  expired?: boolean;
}

/**
 * GRANT / CHANGE (role) / REVOKE, and (migration 014) EXPIRY: only the share's expiry was set,
 * changed, renewed or cleared. Every event carries the expiry before and after.
 */
export type AuditAction = 'GRANT' | 'CHANGE' | 'REVOKE' | 'EXPIRY';
export interface ShareAuditEvent {
  id: string;
  reportId: string;
  action: AuditAction;
  principalType: 'USER' | 'GROUP';
  principalId: string;
  principalName?: string;
  oldRole: ShareRole | null;
  newRole: ShareRole | null;
  /** Expiry before / after the change (ISO-8601 UTC), null meaning none (migration 014). */
  oldExpiresAt: string | null;
  newExpiresAt: string | null;
  actorId: string;
  actorName?: string;
  /** ISO-8601 UTC */
  occurredAt: string;
}

/** A share as stored or as it will be stored: who, which role, and its expiry (if any). */
export type ShareState = Pick<Share, 'type' | 'id' | 'role'> & { expiresAt?: string | null };
export interface ShareChange {
  action: AuditAction;
  type: 'USER' | 'GROUP';
  id: string;
  oldRole: ShareRole | null;
  newRole: ShareRole | null;
  oldExpiresAt: string | null;
  newExpiresAt: string | null;
}

/**
 * Audit events needed to turn `before` into `after`: GRANT, CHANGE (role changed, whatever
 * happened to the expiry), EXPIRY (same role, expiry set / changed / cleared) and REVOKE.
 */
export function diffShares(before: ShareState[], after: ShareState[]): ShareChange[] {
  const key = (s: { type: string; id: string }) => `${s.type}:${s.id}`;
  const exp = (s: ShareState) => expiryIso(s.expiresAt ?? null);
  const old = new Map(before.map((s) => [key(s), s]));
  const out: ShareChange[] = [];
  for (const s of after) {
    const o = old.get(key(s));
    const base = { type: s.type, id: s.id };
    if (!o)
      out.push({
        ...base,
        action: 'GRANT',
        oldRole: null,
        newRole: s.role,
        oldExpiresAt: null,
        newExpiresAt: exp(s),
      });
    else if (o.role !== s.role || exp(o) !== exp(s))
      out.push({
        ...base,
        action: o.role !== s.role ? 'CHANGE' : 'EXPIRY',
        oldRole: o.role,
        newRole: s.role,
        oldExpiresAt: exp(o),
        newExpiresAt: exp(s),
      });
    old.delete(key(s));
  }
  for (const o of old.values())
    out.push({
      type: o.type,
      id: o.id,
      action: 'REVOKE',
      oldRole: o.role,
      newRole: null,
      oldExpiresAt: exp(o),
      newExpiresAt: null,
    });
  return out;
}

/** A QF_REPORT_SHARES / QF_FOLDER_SHARES row as read for access checks and replacement. */
export interface ShareRow {
  PRINCIPAL_TYPE: string;
  PRINCIPAL_ID: string;
  SHARE_ROLE: string;
  EXPIRES_AT?: unknown;
}

/** Stored rows as share states (expiry as ISO-8601 UTC). */
export const shareStates = (rows: ShareRow[]): ShareState[] =>
  rows.map((r) => ({
    type: r.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
    id: String(r.PRINCIPAL_ID),
    role: r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER',
    expiresAt: expiryIso(r.EXPIRES_AT),
  }));

/**
 * The shares to store, with each expiry resolved against what is stored now (see
 * resolveExpiry): an unchanged expiry is kept even when past, a new or changed one must be in
 * the future, a missing one keeps the current value and null clears it.
 */
export function resolveShareExpiries(
  requested: z.infer<typeof sharesInputSchema>['shares'],
  current: ShareState[],
  now: Date,
): (ShareState & { expiresAt: string | null })[] {
  const byKey = new Map(current.map((c) => [`${c.type}:${c.id}`, c]));
  return requested.map((s) => ({
    type: s.type,
    id: s.id,
    role: s.role,
    expiresAt: resolveExpiry(s.expiresAt, byKey.get(`${s.type}:${s.id}`)?.expiresAt ?? null, now),
  }));
}

/** Rows that give access at `now` (all of them when expired shares should count too). */
export const liveShares = <R extends { EXPIRES_AT?: unknown }>(
  rows: R[],
  now: Date,
  includeExpired = false,
): R[] => (includeExpired ? rows : rows.filter((r) => shareActive(r.EXPIRES_AT, now)));

/** Options for access checks. */
export interface AccessCheckOptions {
  /**
   * Count expired shares as if they were still in force. Only used to explain why someone has
   * no access (a scheduled delivery skipping a recipient whose share expired); never to grant.
   */
  includeExpired?: boolean;
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
        expiresAt: expiresAtInput,
      }),
    )
    .max(200),
  /**
   * E-mail the people who gain a share or whose role changes (migration 015). The Share dialog
   * sends true by default ("Notify people"); leaving it out sends nothing.
   */
  notify: z.boolean().optional(),
});

const RANK: Record<AccessRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3, ADMIN: 2 };
export type Need = 'VIEW' | 'EDIT' | 'OWNER';
const NEED_RANK: Record<Need, number> = { VIEW: 1, EDIT: 2, OWNER: 3 };

/**
 * Central authorisation for saved reports. Every report endpoint resolves the
 * caller's effective role (OWNER / EDITOR / VIEWER) from QF_REPORTS.OWNER_ID and
 * QF_REPORT_SHARES (direct user shares and app-group shares) before acting, plus any access the
 * report's owner gave through one of their shared folders (migration 011, FolderReportGrants);
 * the strongest role wins. Reports the caller cannot see are reported as 404 so their
 * existence is not leaked.
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
    private readonly folderGrants?: FolderReportGrants,
    private readonly clock: Clock = systemClock,
  ) {
    this.shares = q(schema, T.shares);
    this.audit = q(schema, T.shareAudit);
    this.users = q(schema, T.users);
  }

  /**
   * The caller's effective role on a report. A share whose EXPIRES_AT (migration 014) is not
   * after the current time gives nothing, on this and every later request.
   */
  async roleFor(
    user: Pick<AppUser, 'id' | 'role'>,
    report: Report,
    opts: AccessCheckOptions = {},
  ): Promise<AccessRole | null> {
    if (user.role === 'ADMIN' && report.ownerId !== user.id) return 'ADMIN';
    if (report.ownerId === user.id) return 'OWNER';
    const rows = liveShares(
      await this.db.query<ShareRow>(
        `SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT FROM ${this.shares} WHERE REPORT_ID = ?`,
        [report.id],
      ),
      this.clock(),
      opts.includeExpired,
    );
    let groupSet: Promise<Set<string>> | undefined;
    const groups = () => (groupSet ??= this.groups.forUser(user.id).then((g) => new Set(g)));
    const g = rows.some((r) => r.PRINCIPAL_TYPE === 'GROUP') ? await groups() : new Set<string>();
    let best: AccessRole | null = null;
    for (const r of rows) {
      const match =
        (r.PRINCIPAL_TYPE === 'USER' && r.PRINCIPAL_ID === user.id) ||
        (r.PRINCIPAL_TYPE === 'GROUP' && g.has(r.PRINCIPAL_ID));
      if (!match) continue;
      const role: AccessRole = r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER';
      if (!best || RANK[role] > RANK[best]) best = role;
    }
    // A direct share keeps its strength; a folder can only add to it, never lower it.
    if (best !== 'EDITOR' && this.folderGrants) {
      const viaFolder = await this.folderGrants.roleFor(user, report, groups, opts);
      if (viaFolder && (!best || RANK[viaFolder] > RANK[best])) best = viaFolder;
    }
    return best;
  }

  /** Global admins are editor-equivalent, not owners, except that they may
   * inspect grants and audit history without altering either one. */
  canViewAudit(user: Pick<AppUser, 'id' | 'role'>, report: Report): boolean {
    return report.ownerId === user.id || user.role === 'ADMIN';
  }

  /** Load a report and require at least `need`. Throws 404 when invisible, 403 when visible but insufficient. */
  async require(
    user: Pick<AppUser, 'id' | 'role'>,
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
      `SELECT S.PRINCIPAL_TYPE, S.PRINCIPAL_ID, S.SHARE_ROLE, S.EXPIRES_AT, U.DISPLAY_NAME
         FROM ${this.shares} S LEFT JOIN ${users} U ON S.PRINCIPAL_TYPE = 'USER' AND U.USER_ID = S.PRINCIPAL_ID
        WHERE S.REPORT_ID = ? ORDER BY S.PRINCIPAL_TYPE, S.PRINCIPAL_ID`,
      [reportId],
    );
    return toShares(rows, this.clock());
  }

  /** Replace all shares of a report (owner only; caller has already checked). */
  async replaceShares(
    report: Report,
    by: string,
    shares: z.infer<typeof sharesInputSchema>['shares'],
    userExists: (id: string) => Promise<boolean>,
    /** Called with the committed changes (for share notifications, migration 015). */
    onCommitted?: (changes: ShareChange[]) => void,
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
    const committed = await this.db.transaction(async (tx) => {
      const current = shareStates(
        await tx.query<ShareRow>(
          `SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT FROM ${this.shares} WHERE REPORT_ID = ?`,
          [report.id],
        ),
      );
      // A new or changed expiry must be in the future; an unchanged one is kept as it is.
      const next = resolveShareExpiries(shares, current, this.clock());
      const events = diffShares(current, next);
      // audit rows commit or roll back together with the share change
      for (const ev of events)
        await tx.update(
          `INSERT INTO ${this.audit} (AUDIT_ID, REPORT_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, OLD_EXPIRES_AT, NEW_EXPIRES_AT, ACTOR_ID, OCCURRED_AT)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
          [
            randomUUID(),
            report.id,
            ev.action,
            ev.type,
            ev.id,
            ev.oldRole,
            ev.newRole,
            expiryParam(ev.oldExpiresAt),
            expiryParam(ev.newExpiresAt),
            by,
          ],
        );
      await tx.update(`DELETE FROM ${this.shares} WHERE REPORT_ID = ?`, [report.id]);
      for (const s of next)
        await tx.update(
          `INSERT INTO ${this.shares} (REPORT_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT, CREATED_BY, CREATED_AT)
           VALUES (?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
          [report.id, s.type, s.id, s.role, expiryParam(s.expiresAt), by],
        );
      return events;
    });
    onCommitted?.(committed);
    return this.listShares(report.id);
  }

  /** Sharing audit trail for one report, newest first (owner/admin; caller has checked). */
  async listAudit(reportId: string, limit = 100): Promise<ShareAuditEvent[]> {
    const n = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT A.AUDIT_ID, A.REPORT_ID, A.ACTION, A.PRINCIPAL_TYPE, A.PRINCIPAL_ID, A.OLD_ROLE, A.NEW_ROLE,
              A.OLD_EXPIRES_AT, A.NEW_EXPIRES_AT, A.ACTOR_ID, A.OCCURRED_AT, ACT.DISPLAY_NAME AS ACTOR_NAME, PU.DISPLAY_NAME AS PRINCIPAL_NAME
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
      oldExpiresAt: expiryIso(r.OLD_EXPIRES_AT),
      newExpiresAt: expiryIso(r.NEW_EXPIRES_AT),
      actorId: String(r.ACTOR_ID),
      actorName: r.ACTOR_NAME ? String(r.ACTOR_NAME) : undefined,
      occurredAt: dbTs(r.OCCURRED_AT),
    }));
  }
}

/** Share rows (with EXPIRES_AT and DISPLAY_NAME) as the API returns them, flagged when expired. */
export function toShares(rows: Record<string, unknown>[], now: Date): Share[] {
  return rows.map((r) => ({
    type: r.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
    id: String(r.PRINCIPAL_ID),
    role: r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER',
    displayName: r.DISPLAY_NAME ? String(r.DISPLAY_NAME) : undefined,
    expiresAt: expiryIso(r.EXPIRES_AT),
    expired: !shareActive(r.EXPIRES_AT, now),
  }));
}
