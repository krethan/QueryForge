import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q, toDbTimestamp } from '../db/schema.js';
import type { AppUser } from '../auth/users.js';
import { AppError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';
import { FOLDER_NOT_FOUND, type Folder, type FolderRepository } from '../reports/folders.js';
import {
  diffShares,
  type AuditAction,
  type Share,
  type ShareRole,
  type sharesInputSchema,
} from './access.js';
import { GROUP_NAME_RE, type GroupRepository } from './groups.js';

/** The caller's effective role on a folder. ADMIN is editor-equivalent, never the owner. */
export type FolderRole = 'OWNER' | 'EDITOR' | 'VIEWER' | 'ADMIN';
export type FolderNeed = 'VIEW' | 'EDIT' | 'OWNER';

/** A folder as one viewer sees it (GET /folders). */
export interface FolderView extends Folder {
  ownerId: string;
  ownerName: string;
  access: FolderRole;
  /** True when the folder has at least one share (always true for folders shared with you). */
  shared: boolean;
  /**
   * The owner's opt-in (migration 011): when set, the people the folder is shared with can also
   * open the owner's own reports in it, at most at this role. Null: the reports are not shared.
   */
  shareReports: ShareRole | null;
  /**
   * The reports in the folder, in the folder's order, reduced to the ones the viewer can see.
   * Filled in by the route, which knows the viewer's visible reports.
   */
  reportIds: string[];
}

export interface FolderMember {
  reportId: string;
  /** Saved shared position, or null (then sorted after positioned reports, by name). */
  pos: number | null;
  /** Placed by the owner's own filing (QF_REPORT_PREFS) rather than QF_FOLDER_REPORTS. */
  viaOwnerPref: boolean;
  hasItem: boolean;
  nameKey: string;
  /** Who placed the shared QF_FOLDER_REPORTS row (null when only the owner's filing puts it here). */
  addedBy: string | null;
  /** The report's owner. */
  reportOwnerId: string;
}

/**
 * Who a folder audit row is about: a user or group the folder is shared with, or (migration 012)
 * REPORTS for the owner's "also share the reports in this folder" option, whose OLD_ROLE /
 * NEW_ROLE are the option's level before and after (null: off).
 */
export type FolderAuditPrincipal = 'USER' | 'GROUP' | 'REPORTS';
/** PRINCIPAL_ID of a REPORTS audit row. Not a valid group name, so it never reads as one. */
export const FOLDER_REPORTS_PRINCIPAL = '*REPORTS';

export interface FolderShareAuditEvent {
  id: string;
  folderId: string;
  action: AuditAction;
  principalType: FolderAuditPrincipal;
  principalId: string;
  principalName?: string;
  oldRole: ShareRole | null;
  newRole: ShareRole | null;
  actorId: string;
  actorName?: string;
  /** ISO-8601 UTC */
  occurredAt: string;
}

/** One page of a folder's audit trail, newest first. */
export interface FolderAuditPage {
  events: FolderShareAuditEvent[];
  /** True when older events exist past this page. */
  hasMore: boolean;
}

/** Default and largest page of folder audit events. */
export const FOLDER_AUDIT_PAGE = 25;
export const MAX_FOLDER_AUDIT_PAGE = 100;
export const MAX_FOLDER_AUDIT_OFFSET = 100_000;
/** Rows read per round trip when exporting a folder's whole audit trail. */
export const FOLDER_AUDIT_EXPORT_BATCH = 500;

/** Where an audit export batch continues from: the last row read, as Db2 returned it. */
export interface FolderAuditCursor {
  occurredAt: string;
  id: string;
}

export const folderAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FOLDER_AUDIT_PAGE).default(FOLDER_AUDIT_PAGE),
  offset: z.coerce.number().int().min(0).max(MAX_FOLDER_AUDIT_OFFSET).default(0),
});

/** The audit event (if any) for changing the folder's report-sharing option from `before` to `after`. */
export function reportSharingAuditAction(
  before: ShareRole | null,
  after: ShareRole | null,
): AuditAction | null {
  if (before === after) return null;
  if (before === null) return 'GRANT';
  if (after === null) return 'REVOKE';
  return 'CHANGE';
}

/** Most reports one folder reorder may list. */
export const MAX_FOLDER_ORDER = 2000;

export const folderOrderInputSchema = z
  .object({
    reportIds: z
      .array(z.string().uuid())
      .max(MAX_FOLDER_ORDER, `At most ${MAX_FOLDER_ORDER} reports can be ordered.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Each report can be listed once.'),
  })
  .strict();

export const folderAddInputSchema = z.object({ reportId: z.string().uuid() }).strict();

const RANK: Record<FolderRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 2, OWNER: 3 };
const NEED_RANK: Record<FolderNeed, number> = { VIEW: 1, EDIT: 2, OWNER: 3 };
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Positioned members first (by position), then the rest by report name. Stable. */
export function sortMembers(members: FolderMember[]): FolderMember[] {
  return [...members].sort((a, b) => {
    if (a.pos !== null && b.pos !== null)
      return a.pos - b.pos || a.reportId.localeCompare(b.reportId);
    if (a.pos !== null) return -1;
    if (b.pos !== null) return 1;
    return a.nameKey.localeCompare(b.nameKey) || a.reportId.localeCompare(b.reportId);
  });
}

/**
 * Put `wanted` (the caller's new order of the members they can see) into the slots those
 * members occupy in `current`, leaving every member the caller cannot see exactly where it
 * was. Members the caller can see but left out of `wanted` keep their relative order after it.
 */
export function mergeVisibleOrder(
  current: string[],
  visible: Set<string>,
  wanted: string[],
): string[] {
  const order = [
    ...wanted.filter((id) => visible.has(id)),
    ...current.filter((id) => visible.has(id) && !wanted.includes(id)),
  ];
  let i = 0;
  return current.map((id) => (visible.has(id) ? order[i++] : id));
}

/**
 * Folder sharing (migration 009). A folder owner shares a folder with users or app groups as
 * VIEWER or EDITOR, exactly like report sharing (QF_REPORT_SHARES). The folder's contents are
 * the owner's own filing (QF_REPORT_PREFS) plus reports anyone who may edit the folder placed
 * in it (QF_FOLDER_REPORTS). Sharing a folder grants no access to a report by itself: every
 * list is reduced to the reports the viewer can see by the caller. Only when the owner opts in
 * (migration 011, see FolderReportGrants) does the folder also share the owner's own reports in
 * it, and that access is worked out by AccessService like any other share. Folders the caller cannot
 * see are reported as 404 so their existence is not leaked. Global admins are editor-equivalent
 * on folders that are shared with anyone; a personal (unshared) folder stays private to its
 * owner, like their favorites.
 */
export class FolderAccessService {
  private readonly folders: string;
  private readonly shares: string;
  private readonly items: string;
  private readonly audit: string;
  private readonly prefs: string;
  private readonly users: string;
  private readonly reports: string;
  private readonly reportSharing: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly folderRepo: FolderRepository,
    private readonly groups: GroupRepository,
  ) {
    this.folders = q(schema, T.folders);
    this.shares = q(schema, T.folderShares);
    this.items = q(schema, T.folderReports);
    this.audit = q(schema, T.folderShareAudit);
    this.prefs = q(schema, T.reportPrefs);
    this.users = q(schema, T.users);
    this.reports = q(schema, T.reports);
    this.reportSharing = q(schema, T.folderReportSharing);
  }

  /** The owner's "also share the reports" setting for each folder (migration 011). */
  async reportSharingFor(folderIds: string[]): Promise<Map<string, ShareRole>> {
    const out = new Map<string, ShareRole>();
    for (let i = 0; i < folderIds.length; i += 500) {
      const ids = folderIds.slice(i, i + 500);
      const rows = await this.db.query<{ FOLDER_ID: string; MAX_ROLE: string }>(
        `SELECT FOLDER_ID, MAX_ROLE FROM ${this.reportSharing} WHERE FOLDER_ID IN (${placeholders(ids.length)})`,
        ids,
      );
      for (const r of rows)
        out.set(String(r.FOLDER_ID), r.MAX_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER');
    }
    return out;
  }

  private async shareRows(folderId: string) {
    return this.db.query<{ PRINCIPAL_TYPE: string; PRINCIPAL_ID: string; SHARE_ROLE: string }>(
      `SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE FROM ${this.shares} WHERE FOLDER_ID = ?`,
      [folderId],
    );
  }

  async roleFor(
    user: Pick<AppUser, 'id' | 'role'>,
    folder: { id: string; ownerId: string },
  ): Promise<FolderRole | null> {
    if (folder.ownerId === user.id) return 'OWNER';
    const rows = await this.shareRows(folder.id);
    if (!rows.length) return null; // personal folder: owner only, even for admins
    if (user.role === 'ADMIN') return 'ADMIN';
    const groups = rows.some((r) => r.PRINCIPAL_TYPE === 'GROUP')
      ? new Set(await this.groups.forUser(user.id))
      : new Set<string>();
    let best: FolderRole | null = null;
    for (const r of rows) {
      const match =
        (r.PRINCIPAL_TYPE === 'USER' && r.PRINCIPAL_ID === user.id) ||
        (r.PRINCIPAL_TYPE === 'GROUP' && groups.has(r.PRINCIPAL_ID));
      if (!match) continue;
      const role: FolderRole = r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER';
      if (!best || RANK[role] > RANK[best]) best = role;
    }
    return best;
  }

  /** Load a folder and require at least `need`. 404 when invisible, 403 when visible but insufficient. */
  async require(
    user: Pick<AppUser, 'id' | 'role'>,
    folderId: string,
    need: FolderNeed,
  ): Promise<{ folder: Folder & { ownerId: string }; access: FolderRole }> {
    const folder = await this.folderRepo.findById(folderId);
    if (!folder) throw FOLDER_NOT_FOUND();
    const access = await this.roleFor(user, folder);
    if (!access) throw FOLDER_NOT_FOUND();
    if (RANK[access] < NEED_RANK[need])
      throw new AppError(
        403,
        'FORBIDDEN',
        need === 'OWNER'
          ? 'Only the folder owner can do this.'
          : 'You have view-only access to this folder.',
      );
    return { folder, access };
  }

  /**
   * Every folder the user can see: their own (any), folders shared with them directly or
   * through a group, and for a global ADMIN every other folder that is shared with anyone.
   * Own folders first (by name), then the others by name. reportIds is left empty.
   */
  async listAccessible(user: Pick<AppUser, 'id' | 'role'>): Promise<FolderView[]> {
    const ownName = await this.db.query<{ DISPLAY_NAME: string }>(
      `SELECT DISPLAY_NAME FROM ${this.users} WHERE USER_ID = ? AND IS_ACTIVE = 1`,
      [user.id],
    );
    const own = await this.folderRepo.list(user.id);
    const ownShared = await this.sharedFolderIds(own.map((f) => f.id));
    const out: FolderView[] = own.map((f) => ({
      ...f,
      ownerId: user.id,
      ownerName: String(ownName[0]?.DISPLAY_NAME ?? ''),
      access: 'OWNER',
      shared: ownShared.has(f.id),
      shareReports: null,
      reportIds: [],
    }));
    const cols = `F.FOLDER_ID, F.OWNER_ID, F.FOLDER_NAME, F.FOLDER_NAME_KEY, F.CREATED_AT, F.UPDATED_AT, S.SHARE_ROLE, U.DISPLAY_NAME AS OWNER_NAME`;
    let rows: Record<string, unknown>[];
    if (user.role === 'ADMIN') {
      rows = (
        await this.db.query<Record<string, unknown>>(
          `SELECT ${cols}
             FROM ${this.folders} F
             JOIN ${this.shares} S ON S.FOLDER_ID = F.FOLDER_ID
             JOIN ${this.users} U ON U.USER_ID = F.OWNER_ID
            WHERE F.OWNER_ID <> ? ORDER BY F.FOLDER_NAME_KEY`,
          [user.id],
        )
      ).map((r) => ({ ...r, SHARE_ROLE: 'ADMIN' }));
    } else {
      const groups = await this.groups.forUser(user.id);
      const params: string[] = [user.id, user.id];
      let groupClause = '';
      if (groups.length) {
        groupClause = ` OR (S.PRINCIPAL_TYPE = 'GROUP' AND S.PRINCIPAL_ID IN (${placeholders(groups.length)}))`;
        params.push(...groups);
      }
      rows = await this.db.query<Record<string, unknown>>(
        `SELECT ${cols}
           FROM ${this.folders} F
           JOIN ${this.shares} S ON S.FOLDER_ID = F.FOLDER_ID
           JOIN ${this.users} U ON U.USER_ID = F.OWNER_ID
          WHERE F.OWNER_ID <> ? AND ((S.PRINCIPAL_TYPE = 'USER' AND S.PRINCIPAL_ID = ?)${groupClause})
          ORDER BY F.FOLDER_NAME_KEY`,
        params,
      );
    }
    const byId = new Map<string, FolderView & { key: string }>();
    for (const r of rows) {
      const access: FolderRole =
        r.SHARE_ROLE === 'ADMIN' ? 'ADMIN' : r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER';
      const id = String(r.FOLDER_ID);
      const prev = byId.get(id);
      if (prev && RANK[prev.access] >= RANK[access]) continue;
      byId.set(id, {
        id,
        name: String(r.FOLDER_NAME),
        createdAt: dbTimestampToIso(r.CREATED_AT),
        updatedAt: dbTimestampToIso(r.UPDATED_AT),
        ownerId: String(r.OWNER_ID),
        ownerName: String(r.OWNER_NAME ?? ''),
        access,
        shared: true,
        shareReports: null,
        reportIds: [],
        key: String(r.FOLDER_NAME_KEY ?? r.FOLDER_NAME).toUpperCase(),
      });
    }
    const others = [...byId.values()]
      .sort((a, b) => a.key.localeCompare(b.key) || a.ownerName.localeCompare(b.ownerName))
      .map(({ key: _key, ...f }) => f);
    const all = [...out, ...others];
    const sharing = await this.reportSharingFor(all.map((f) => f.id));
    for (const f of all) f.shareReports = sharing.get(f.id) ?? null;
    return all;
  }

  private async sharedFolderIds(folderIds: string[]): Promise<Set<string>> {
    if (!folderIds.length) return new Set();
    const rows = await this.db.query<{ FOLDER_ID: string }>(
      `SELECT DISTINCT FOLDER_ID FROM ${this.shares} WHERE FOLDER_ID IN (${placeholders(folderIds.length)})`,
      folderIds,
    );
    return new Set(rows.map((r) => String(r.FOLDER_ID)));
  }

  /**
   * Every report in each folder, in folder order, regardless of who may see it. Callers MUST
   * reduce the result to the viewer's visible reports before returning anything.
   */
  async members(folders: { id: string; ownerId: string }[]): Promise<Map<string, FolderMember[]>> {
    const out = new Map<string, FolderMember[]>(folders.map((f) => [f.id, []]));
    if (!folders.length) return out;
    const ids = folders.map((f) => f.id);
    const owner = new Map(folders.map((f) => [f.id, f.ownerId]));
    const items = await this.db.query<Record<string, unknown>>(
      `SELECT I.FOLDER_ID, I.REPORT_ID, I.ITEM_POS, I.ADDED_BY, R.REPORT_NAME_KEY, R.OWNER_ID
         FROM ${this.items} I JOIN ${this.reports} R ON R.REPORT_ID = I.REPORT_ID
        WHERE I.FOLDER_ID IN (${placeholders(ids.length)})`,
      ids,
    );
    const filed = await this.db.query<Record<string, unknown>>(
      `SELECT P.USER_ID, P.FOLDER_ID, P.REPORT_ID, R.REPORT_NAME_KEY, R.OWNER_ID
         FROM ${this.prefs} P JOIN ${this.reports} R ON R.REPORT_ID = P.REPORT_ID
        WHERE P.FOLDER_ID IN (${placeholders(ids.length)})`,
      ids,
    );
    const byKey = new Map<string, FolderMember>();
    for (const r of items) {
      const fid = String(r.FOLDER_ID);
      const m: FolderMember = {
        reportId: String(r.REPORT_ID),
        pos: r.ITEM_POS === null || r.ITEM_POS === undefined ? null : Number(r.ITEM_POS),
        viaOwnerPref: false,
        hasItem: true,
        nameKey: String(r.REPORT_NAME_KEY ?? ''),
        addedBy: r.ADDED_BY === null || r.ADDED_BY === undefined ? null : String(r.ADDED_BY),
        reportOwnerId: String(r.OWNER_ID ?? ''),
      };
      byKey.set(`${fid}|${m.reportId}`, m);
      out.get(fid)?.push(m);
    }
    for (const r of filed) {
      const fid = String(r.FOLDER_ID);
      // Only the owner's own filing counts; nobody else can file into this folder via prefs.
      if (owner.get(fid) !== String(r.USER_ID)) continue;
      const k = `${fid}|${String(r.REPORT_ID)}`;
      const existing = byKey.get(k);
      if (existing) {
        existing.viaOwnerPref = true;
        continue;
      }
      const m: FolderMember = {
        reportId: String(r.REPORT_ID),
        pos: null,
        viaOwnerPref: true,
        hasItem: false,
        nameKey: String(r.REPORT_NAME_KEY ?? ''),
        addedBy: null,
        reportOwnerId: String(r.OWNER_ID ?? ''),
      };
      byKey.set(k, m);
      out.get(fid)?.push(m);
    }
    for (const [k, v] of out) out.set(k, sortMembers(v));
    return out;
  }

  /**
   * Place a report in a folder (caller has checked EDIT on the folder and VIEW on the report).
   * When the folder owner adds a report someone else already placed there, the placement
   * becomes the owner's: that is how an owner confirms an editor's addition so it can be
   * shared through the folder (migration 011).
   */
  async addReport(
    folder: { id: string; ownerId: string },
    reportId: string,
    by: string,
  ): Promise<boolean> {
    const folderId = folder.id;
    const rows = await this.db.query<{ REPORT_ID: string; ADDED_BY: string }>(
      `SELECT REPORT_ID, ADDED_BY FROM ${this.items} WHERE FOLDER_ID = ? AND REPORT_ID = ?`,
      [folderId, reportId],
    );
    if (rows.length) {
      if (by !== folder.ownerId || String(rows[0].ADDED_BY) === by) return false;
      await this.db.update(
        `UPDATE ${this.items} SET ADDED_BY = ? WHERE FOLDER_ID = ? AND REPORT_ID = ?`,
        [by, folderId, reportId],
      );
      return true;
    }
    try {
      await this.db.update(
        `INSERT INTO ${this.items} (FOLDER_ID, REPORT_ID, ITEM_POS, ADDED_BY, ADDED_AT) VALUES (?, ?, NULL, ?, ${NOW_UTC})`,
        [folderId, reportId, by],
      );
    } catch (e) {
      // a concurrent add of the same report is fine
      if ((e as { sqlState?: string }).sqlState === '23505') return false;
      throw e;
    }
    return true;
  }

  /**
   * Take a report out of a folder for everyone (caller has checked EDIT on the folder and VIEW
   * on the report): the shared placement, and the owner's own filing if that is how it got
   * there (the owner's favorite is kept). The report itself is never touched.
   */
  async removeReport(folder: { id: string; ownerId: string }, reportId: string): Promise<boolean> {
    const n = await this.db.update(
      `DELETE FROM ${this.items} WHERE FOLDER_ID = ? AND REPORT_ID = ?`,
      [folder.id, reportId],
    );
    const prefs = await this.folderRepo.prefs(folder.ownerId);
    if (prefs.get(reportId)?.folderId === folder.id) {
      await this.folderRepo.setPref(folder.ownerId, reportId, { folderId: null });
      return true;
    }
    return n > 0;
  }

  /** Write positions 0..n-1 for the folder's full member list (caller has merged the order). */
  async saveOrder(folderId: string, ordered: FolderMember[], by: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [i, m] of ordered.entries()) {
        if (m.hasItem)
          await tx.update(
            `UPDATE ${this.items} SET ITEM_POS = ? WHERE FOLDER_ID = ? AND REPORT_ID = ?`,
            [i, folderId, m.reportId],
          );
        else
          await tx.update(
            `INSERT INTO ${this.items} (FOLDER_ID, REPORT_ID, ITEM_POS, ADDED_BY, ADDED_AT) VALUES (?, ?, ?, ?, ${NOW_UTC})`,
            [folderId, m.reportId, i, by],
          );
      }
    });
  }

  /**
   * The owner moved a report with their own "Move to folder": it now sits in `keep` (or
   * nowhere) among the owner's folders, so drop shared placements in their other folders.
   */
  async removeFromOwnFoldersExcept(ownerId: string, reportId: string, keep: string | null) {
    const own = await this.folderRepo.list(ownerId);
    for (const f of own)
      if (f.id !== keep)
        await this.db.update(`DELETE FROM ${this.items} WHERE FOLDER_ID = ? AND REPORT_ID = ?`, [
          f.id,
          reportId,
        ]);
  }

  async listShares(folderId: string): Promise<Share[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT S.PRINCIPAL_TYPE, S.PRINCIPAL_ID, S.SHARE_ROLE, U.DISPLAY_NAME
         FROM ${this.shares} S LEFT JOIN ${this.users} U ON S.PRINCIPAL_TYPE = 'USER' AND U.USER_ID = S.PRINCIPAL_ID
        WHERE S.FOLDER_ID = ? ORDER BY S.PRINCIPAL_TYPE, S.PRINCIPAL_ID`,
      [folderId],
    );
    return rows.map((r) => ({
      type: r.PRINCIPAL_TYPE as 'USER' | 'GROUP',
      id: String(r.PRINCIPAL_ID),
      role: r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER',
      displayName: r.DISPLAY_NAME ? String(r.DISPLAY_NAME) : undefined,
    }));
  }

  /** Replace all shares of a folder (owner only; caller has checked). Audited in the same transaction. */
  async replaceShares(
    folder: { id: string; ownerId: string },
    by: string,
    shares: z.infer<typeof sharesInputSchema>['shares'],
    userExists: (id: string) => Promise<boolean>,
    /** Also set the owner's "share the reports" option (migration 011); undefined leaves it. */
    shareReports?: ShareRole | null,
  ): Promise<Share[]> {
    const seen = new Set<string>();
    for (const s of shares) {
      const key = `${s.type}:${s.id}`;
      if (seen.has(key))
        throw new AppError(400, 'DUPLICATE_SHARE', 'Each user or group can be listed once.');
      seen.add(key);
      if (s.type === 'USER') {
        if (s.id === folder.ownerId)
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
        `SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE FROM ${this.shares} WHERE FOLDER_ID = ?`,
        [folder.id],
      );
      const events = diffShares(
        current.map((r) => ({
          type: r.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
          id: String(r.PRINCIPAL_ID),
          role: r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER',
        })),
        shares,
      );
      for (const ev of events)
        await tx.update(
          `INSERT INTO ${this.audit} (AUDIT_ID, FOLDER_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, ACTOR_ID, OCCURRED_AT)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
          [randomUUID(), folder.id, ev.action, ev.type, ev.id, ev.oldRole, ev.newRole, by],
        );
      await tx.update(`DELETE FROM ${this.shares} WHERE FOLDER_ID = ?`, [folder.id]);
      for (const s of shares)
        await tx.update(
          `INSERT INTO ${this.shares} (FOLDER_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, CREATED_BY, CREATED_AT)
           VALUES (?, ?, ?, ?, ?, ${NOW_UTC})`,
          [folder.id, s.type, s.id, s.role, by],
        );
      // The opt-in commits or rolls back together with the folder's shares, and so does its
      // audit row (migration 012): on = GRANT, off = REVOKE, a new level = CHANGE.
      if (shareReports !== undefined) {
        const was = await tx.query<{ FOLDER_ID: string; MAX_ROLE: string }>(
          `SELECT FOLDER_ID, MAX_ROLE FROM ${this.reportSharing} WHERE FOLDER_ID IN (?)`,
          [folder.id],
        );
        const before: ShareRole | null = was.length
          ? was[0].MAX_ROLE === 'EDITOR'
            ? 'EDITOR'
            : 'VIEWER'
          : null;
        const action = reportSharingAuditAction(before, shareReports);
        if (action)
          await tx.update(
            `INSERT INTO ${this.audit} (AUDIT_ID, FOLDER_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, ACTOR_ID, OCCURRED_AT)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
            [
              randomUUID(),
              folder.id,
              action,
              'REPORTS',
              FOLDER_REPORTS_PRINCIPAL,
              before,
              shareReports,
              by,
            ],
          );
        await tx.update(`DELETE FROM ${this.reportSharing} WHERE FOLDER_ID = ?`, [folder.id]);
        if (shareReports)
          await tx.update(
            `INSERT INTO ${this.reportSharing} (FOLDER_ID, MAX_ROLE, UPDATED_BY, UPDATED_AT) VALUES (?, ?, ?, ${NOW_UTC})`,
            [folder.id, shareReports, by],
          );
      }
    });
    return this.listShares(folder.id);
  }

  /** Folder sharing audit trail, newest first (owner/admin; caller has checked). */
  async listAudit(folderId: string, limit = 100): Promise<FolderShareAuditEvent[]> {
    const n = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
    return (await this.auditPage(folderId, n, 0)).events;
  }

  /**
   * One page of the folder sharing audit trail, newest first (owner/admin; caller has checked).
   * Reads one row past the page to tell whether older events exist.
   */
  async auditPage(folderId: string, limit: number, offset: number): Promise<FolderAuditPage> {
    const n = Math.max(1, Math.min(Math.floor(limit) || FOLDER_AUDIT_PAGE, 500));
    const skip = Math.max(0, Math.min(Math.floor(offset) || 0, MAX_FOLDER_AUDIT_OFFSET));
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${AUDIT_COLUMNS}
         FROM ${this.audit} A
         LEFT JOIN ${this.users} ACT ON ACT.USER_ID = A.ACTOR_ID
         LEFT JOIN ${this.users} PU ON A.PRINCIPAL_TYPE = 'USER' AND PU.USER_ID = A.PRINCIPAL_ID
        WHERE A.FOLDER_ID = ? ORDER BY A.OCCURRED_AT DESC, A.AUDIT_ID
        OFFSET ${skip} ROWS FETCH FIRST ${n + 1} ROWS ONLY`,
      [folderId],
    );
    return { events: rows.slice(0, n).map(toAuditEvent), hasMore: rows.length > n };
  }

  /**
   * One batch of the folder's audit trail for export, newest first, continuing strictly after
   * `after` (keyset paging on OCCURRED_AT DESC, AUDIT_ID). Unlike OFFSET paging, a change
   * recorded while an export runs cannot shift the batches, so no row is repeated or skipped,
   * and there is no offset ceiling. The cursor carries OCCURRED_AT exactly as Db2 returned it.
   * Caller has checked access. The folder itself need not exist any more.
   */
  async auditBatch(
    folderId: string,
    after: FolderAuditCursor | null,
    size = FOLDER_AUDIT_EXPORT_BATCH,
  ): Promise<{ events: FolderShareAuditEvent[]; next: FolderAuditCursor | null }> {
    const n = Math.max(1, Math.min(Math.floor(size) || FOLDER_AUDIT_EXPORT_BATCH, 1000));
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${AUDIT_COLUMNS}
         FROM ${this.audit} A
         LEFT JOIN ${this.users} ACT ON ACT.USER_ID = A.ACTOR_ID
         LEFT JOIN ${this.users} PU ON A.PRINCIPAL_TYPE = 'USER' AND PU.USER_ID = A.PRINCIPAL_ID
        WHERE A.FOLDER_ID = ?${
          after
            ? ' AND (A.OCCURRED_AT < CAST(? AS TIMESTAMP) OR (A.OCCURRED_AT = CAST(? AS TIMESTAMP) AND A.AUDIT_ID > ?))'
            : ''
        }
        ORDER BY A.OCCURRED_AT DESC, A.AUDIT_ID
        FETCH FIRST ${n} ROWS ONLY`,
      after ? [folderId, after.occurredAt, after.occurredAt, after.id] : [folderId],
    );
    const last = rows.at(-1);
    return {
      events: rows.map(toAuditEvent),
      next:
        rows.length === n && last
          ? { occurredAt: cursorTimestamp(last.OCCURRED_AT), id: String(last.AUDIT_ID) }
          : null,
    };
  }

  /** Every audit event for the folder, newest first, read a batch at a time (never truncated). */
  async *auditAll(
    folderId: string,
    size = FOLDER_AUDIT_EXPORT_BATCH,
  ): AsyncGenerator<FolderShareAuditEvent[]> {
    let after: FolderAuditCursor | null = null;
    do {
      const batch = await this.auditBatch(folderId, after, size);
      if (batch.events.length) yield batch.events;
      after = batch.next;
    } while (after);
  }
}

/** OCCURRED_AT exactly as read (Mapepire returns TIMESTAMP as text), to bind back as the cursor. */
const cursorTimestamp = (v: unknown) => (v instanceof Date ? toDbTimestamp(v) : String(v));

const AUDIT_COLUMNS = `A.AUDIT_ID, A.FOLDER_ID, A.ACTION, A.PRINCIPAL_TYPE, A.PRINCIPAL_ID, A.OLD_ROLE, A.NEW_ROLE,
              A.ACTOR_ID, A.OCCURRED_AT, ACT.DISPLAY_NAME AS ACTOR_NAME, PU.DISPLAY_NAME AS PRINCIPAL_NAME`;

const auditRole = (v: unknown): ShareRole | null =>
  v === 'EDITOR' ? 'EDITOR' : v === 'VIEWER' ? 'VIEWER' : null;
const auditType = (v: unknown): FolderAuditPrincipal =>
  v === 'GROUP' ? 'GROUP' : v === 'REPORTS' ? 'REPORTS' : 'USER';
const toAuditEvent = (r: Record<string, unknown>): FolderShareAuditEvent => ({
  id: String(r.AUDIT_ID),
  folderId: String(r.FOLDER_ID),
  action: r.ACTION as AuditAction,
  principalType: auditType(r.PRINCIPAL_TYPE),
  principalId: String(r.PRINCIPAL_ID),
  principalName: r.PRINCIPAL_NAME ? String(r.PRINCIPAL_NAME) : undefined,
  oldRole: auditRole(r.OLD_ROLE),
  newRole: auditRole(r.NEW_ROLE),
  actorId: String(r.ACTOR_ID),
  actorName: r.ACTOR_NAME ? String(r.ACTOR_NAME) : undefined,
  occurredAt: dbTimestampToIso(r.OCCURRED_AT) ?? String(r.OCCURRED_AT),
});
