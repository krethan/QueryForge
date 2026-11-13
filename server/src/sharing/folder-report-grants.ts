import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { T, q } from '../db/schema.js';
import { sharesInputSchema, type ShareRole } from './access.js';
import type { FolderAccessService, FolderMember } from './folder-access.js';

/**
 * Sharing the reports in a shared folder (migration 011).
 *
 * The folder owner opts in per folder, choosing the most a recipient can get: VIEWER ("view
 * only") or EDITOR ("match the folder role"). While the option is on, each person or group
 * the folder is shared with can also open the reports in it that
 *
 *   1. the folder owner owns (only a report's owner can share it anywhere else in the app, so
 *      a folder can never re-share someone else's report), and
 *   2. the folder owner placed there themselves: filed it with "Move to folder" or added it,
 *      or added it again to confirm a report an editor put there. A folder editor cannot
 *      widen who sees the owner's reports by dropping them into the folder.
 *
 * The role is the folder share's role capped at the owner's maximum. Nothing is written to
 * QF_REPORT_SHARES: the access is recomputed on every request alongside direct report shares,
 * and the stronger of the two wins. So a report added later is shared as soon as it is in the
 * folder; removing it, changing or revoking a folder share, turning the option off or deleting
 * the folder takes away only what came through the folder, never a direct report share.
 */
export type FolderReportSkipReason = 'NOT_OWNER' | 'ADDED_BY_OTHER';

export interface FolderReportGrant {
  folderId: string;
  folderName: string;
  type: 'USER' | 'GROUP';
  id: string;
  role: ShareRole;
  displayName?: string;
}

export const folderSharesInputSchema = sharesInputSchema.extend({
  /** Omit to leave the option as it is; null turns it off. */
  shareReports: z.enum(['VIEWER', 'EDITOR']).nullable().optional(),
});

const RANK: Record<ShareRole, number> = { VIEWER: 1, EDITOR: 2 };
export const minRole = (a: ShareRole, b: ShareRole): ShareRole => (RANK[a] <= RANK[b] ? a : b);
export const maxRole = (a: ShareRole | null | undefined, b: ShareRole): ShareRole =>
  a && RANK[a] >= RANK[b] ? a : b;
const role = (v: unknown): ShareRole => (v === 'EDITOR' ? 'EDITOR' : 'VIEWER');
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Why a report in a folder is not shared through it, or null when it is. */
export function folderSkipReason(
  folderOwnerId: string,
  m: Pick<FolderMember, 'reportOwnerId' | 'viaOwnerPref' | 'addedBy'>,
): FolderReportSkipReason | null {
  if (m.reportOwnerId !== folderOwnerId) return 'NOT_OWNER';
  if (!m.viaOwnerPref && m.addedBy !== folderOwnerId) return 'ADDED_BY_OTHER';
  return null;
}

export class FolderReportGrants {
  private readonly folders: string;
  private readonly shares: string;
  private readonly items: string;
  private readonly prefs: string;
  private readonly users: string;
  private readonly sharing: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly folderAccess: FolderAccessService,
  ) {
    this.folders = q(schema, T.folders);
    this.shares = q(schema, T.folderShares);
    this.items = q(schema, T.folderReports);
    this.prefs = q(schema, T.reportPrefs);
    this.users = q(schema, T.users);
    this.sharing = q(schema, T.folderReportSharing);
  }

  /** Everyone who can reach `report` through one of its owner's folders, and at what role. */
  async grantsForReport(report: { id: string; ownerId: string }): Promise<FolderReportGrant[]> {
    const folders = await this.db.query<Record<string, unknown>>(
      `SELECT F.FOLDER_ID, F.FOLDER_NAME, X.MAX_ROLE
         FROM ${this.folders} F JOIN ${this.sharing} X ON X.FOLDER_ID = F.FOLDER_ID
        WHERE F.OWNER_ID = ? ORDER BY F.FOLDER_NAME_KEY`,
      [report.ownerId],
    );
    if (!folders.length) return [];
    const ids = folders.map((f) => String(f.FOLDER_ID));
    const inFolder = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placed = await this.db.query<{ FOLDER_ID: string }>(
        `SELECT FOLDER_ID FROM ${this.items} WHERE REPORT_ID = ? AND ADDED_BY = ? AND FOLDER_ID IN (${placeholders(chunk.length)})`,
        [report.id, report.ownerId, ...chunk],
      );
      for (const r of placed) inFolder.add(String(r.FOLDER_ID));
    }
    const filed = await this.db.query<{ FOLDER_ID: string | null }>(
      `SELECT FOLDER_ID, IS_FAVORITE FROM ${this.prefs} WHERE USER_ID = ? AND REPORT_ID = ?`,
      [report.ownerId, report.id],
    );
    const filedIn = filed[0]?.FOLDER_ID;
    if (filedIn && ids.includes(String(filedIn))) inFolder.add(String(filedIn));
    if (!inFolder.size) return [];
    const meta = new Map(
      folders
        .filter((f) => inFolder.has(String(f.FOLDER_ID)))
        .map((f) => [String(f.FOLDER_ID), { name: String(f.FOLDER_NAME), max: role(f.MAX_ROLE) }]),
    );
    const fids = [...meta.keys()];
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT S.FOLDER_ID, S.PRINCIPAL_TYPE, S.PRINCIPAL_ID, S.SHARE_ROLE, U.DISPLAY_NAME
         FROM ${this.shares} S LEFT JOIN ${this.users} U ON S.PRINCIPAL_TYPE = 'USER' AND U.USER_ID = S.PRINCIPAL_ID
        WHERE S.FOLDER_ID IN (${placeholders(fids.length)}) ORDER BY S.FOLDER_ID, S.PRINCIPAL_TYPE, S.PRINCIPAL_ID`,
      fids,
    );
    const out: FolderReportGrant[] = [];
    for (const r of rows) {
      const f = meta.get(String(r.FOLDER_ID));
      if (!f) continue;
      out.push({
        folderId: String(r.FOLDER_ID),
        folderName: f.name,
        type: r.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
        id: String(r.PRINCIPAL_ID),
        role: minRole(role(r.SHARE_ROLE), f.max),
        displayName: r.DISPLAY_NAME ? String(r.DISPLAY_NAME) : undefined,
      });
    }
    return out.sort(
      (a, b) =>
        a.folderName.localeCompare(b.folderName) ||
        a.type.localeCompare(b.type) ||
        a.id.localeCompare(b.id),
    );
  }

  /** The best role `user` (in `groups`) gets on `report` through folders, or null. */
  async roleFor(
    user: { id: string },
    report: { id: string; ownerId: string },
    groups: () => Promise<Set<string>>,
  ): Promise<ShareRole | null> {
    if (report.ownerId === user.id) return null;
    const grants = await this.grantsForReport(report);
    if (!grants.length) return null;
    const g = grants.some((x) => x.type === 'GROUP') ? await groups() : new Set<string>();
    let best: ShareRole | null = null;
    for (const x of grants)
      if ((x.type === 'USER' && x.id === user.id) || (x.type === 'GROUP' && g.has(x.id)))
        best = maxRole(best, x.role);
    return best;
  }

  /**
   * Every report a (non-admin) user reaches through folders shared with them, with the role.
   * Never includes the user's own reports.
   */
  async reportRolesFor(userId: string, groups: string[]): Promise<Map<string, ShareRole>> {
    const params: string[] = [userId, userId];
    let groupClause = '';
    if (groups.length) {
      groupClause = ` OR (S.PRINCIPAL_TYPE = 'GROUP' AND S.PRINCIPAL_ID IN (${placeholders(groups.length)}))`;
      params.push(...groups);
    }
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT S.FOLDER_ID, S.SHARE_ROLE, F.OWNER_ID, X.MAX_ROLE
         FROM ${this.shares} S
         JOIN ${this.folders} F ON F.FOLDER_ID = S.FOLDER_ID
         JOIN ${this.sharing} X ON X.FOLDER_ID = S.FOLDER_ID
        WHERE F.OWNER_ID <> ? AND ((S.PRINCIPAL_TYPE = 'USER' AND S.PRINCIPAL_ID = ?)${groupClause})`,
      params,
    );
    const folders = new Map<string, { ownerId: string; role: ShareRole }>();
    for (const r of rows) {
      const id = String(r.FOLDER_ID);
      const granted = minRole(role(r.SHARE_ROLE), role(r.MAX_ROLE));
      const prev = folders.get(id);
      folders.set(id, { ownerId: String(r.OWNER_ID), role: maxRole(prev?.role, granted) });
    }
    const out = new Map<string, ShareRole>();
    if (!folders.size) return out;
    const list = [...folders].map(([id, f]) => ({ id, ownerId: f.ownerId }));
    const members = await this.folderAccess.members(list);
    for (const f of list) {
      const granted = folders.get(f.id)!.role;
      for (const m of members.get(f.id) ?? []) {
        if (m.reportOwnerId === userId) continue;
        if (folderSkipReason(f.ownerId, m) !== null) continue;
        out.set(m.reportId, maxRole(out.get(m.reportId), granted));
      }
    }
    return out;
  }
}
