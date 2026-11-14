import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q, toDbTimestamp } from '../db/schema.js';
import { AppError, DbError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';
import { expiryIso, expiryParam } from '../sharing/expiry.js';

export interface Folder {
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The viewing user's folder and favorite for one report. */
export interface ReportPref {
  folderId: string | null;
  favorite: boolean;
}

export const MAX_FOLDERS = 200;

/** One deleted folder, from the deletion audit trail (migration 013). */
export interface FolderDeletion {
  id: string;
  folderId: string;
  folderName: string;
  ownerId: string;
  ownerName?: string;
  /** Who deleted it (today always the owner: only the owner may delete a folder). */
  actorId: string;
  actorName?: string;
  /** Users and groups it was shared with. */
  shareCount: number;
  /** Reports placed in it through QF_FOLDER_REPORTS (by the owner or an editor). */
  placedCount: number;
  /** The owner's own reports filed in it, moved to Unfiled. */
  filedCount: number;
  /** Its "also share the reports" level when deleted, or null (off). */
  reportsRole: 'VIEWER' | 'EDITOR' | null;
  /** ISO-8601 UTC */
  deletedAt: string;
}

/** One page of deleted folders, newest first. */
export interface FolderDeletionPage {
  deletions: FolderDeletion[];
  hasMore: boolean;
}

export const FOLDER_DELETIONS_PAGE = 50;
export const MAX_FOLDER_DELETIONS_PAGE = 200;
export const MAX_FOLDER_DELETIONS_OFFSET = 100_000;

/**
 * Longest folder-name / owner search accepted. Even with every character escaped, the LIKE
 * pattern (`%` + 2 x 60 + `%` = 122) stays shorter than the narrowest searched column
 * (FOLDER_NAME and USERNAME, VARCHAR(128)), in case Db2 sizes the untyped marker from it.
 */
export const MAX_FOLDER_DELETION_SEARCH = 60;
/** Rows read per batch by the deleted-folders CSV export. */
export const FOLDER_DELETIONS_EXPORT_BATCH = 500;
/** Most distinct "deleted by" users offered for the filter. */
export const MAX_FOLDER_DELETION_ACTORS = 200;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined));
const optionalInstant = z
  .string()
  .max(40)
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined))
  .pipe(z.string().datetime({ offset: true }).optional());

/**
 * Filters for the admin deleted-folders list and its CSV export, all applied in SQL:
 * - `q`: part of the folder name, or of the owner's display name or username, any case
 *   (or the owner's user ID exactly, for owners no longer in QF_USERS);
 * - `actorId`: who deleted it (exact user ID);
 * - `from` / `to`: ISO-8601 instants; `from` inclusive, `to` exclusive.
 */
export const folderDeletionFilterSchema = z
  .object({
    q: optionalText(MAX_FOLDER_DELETION_SEARCH),
    actorId: optionalText(36),
    from: optionalInstant,
    to: optionalInstant,
  })
  .refine((f) => !f.from || !f.to || Date.parse(f.from) < Date.parse(f.to), {
    message: '"from" must be before "to".',
    path: ['to'],
  });
export type FolderDeletionFilter = z.infer<typeof folderDeletionFilterSchema>;

export const folderDeletionsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_FOLDER_DELETIONS_PAGE)
      .default(FOLDER_DELETIONS_PAGE),
    offset: z.coerce.number().int().min(0).max(MAX_FOLDER_DELETIONS_OFFSET).default(0),
    /** Opaque keyset cursor from a previous page's `next`; replaces `offset`. */
    cursor: z.string().max(400).optional(),
  })
  .and(folderDeletionFilterSchema)
  .refine((v) => !v.cursor || v.offset === 0, {
    message: 'Use either "cursor" or "offset", not both.',
    path: ['cursor'],
  });

/** Where the next page starts: the last row's DELETED_AT (as Db2 returned it) and DELETION_ID. */
export interface FolderDeletionCursor {
  deletedAt: string;
  id: string;
}

const DB_TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T-]\d{2}[:.]\d{2}[:.]\d{2}(?:\.\d{1,12})?$/;

/**
 * A short fingerprint of the normalized filters. Every cursor carries it, so a cursor from one
 * search can never continue a different one (the server answers 400 instead of a wrong page).
 */
export function folderDeletionFilterKey(f: FolderDeletionFilter): string {
  return createHash('sha256')
    .update(JSON.stringify([f.q?.toUpperCase() ?? '', f.actorId ?? '', f.from ?? '', f.to ?? '']))
    .digest('base64url')
    .slice(0, 16);
}

export function encodeFolderDeletionCursor(
  c: FolderDeletionCursor,
  filter: FolderDeletionFilter,
): string {
  return Buffer.from(
    JSON.stringify({ t: c.deletedAt, i: c.id, f: folderDeletionFilterKey(filter) }),
  ).toString('base64url');
}

const BAD_DELETIONS_CURSOR = () =>
  new AppError(
    400,
    'BAD_CURSOR',
    'The page cursor is not valid for this search. Start again from the first page.',
  );

export function decodeFolderDeletionCursor(
  s: string,
  filter: FolderDeletionFilter,
): FolderDeletionCursor {
  let c: { t: string; i: string; f: string };
  try {
    c = z
      .object({
        t: z.string().regex(DB_TIMESTAMP_TEXT),
        i: z.string().min(1).max(36),
        f: z.string().length(16),
      })
      .strict()
      .parse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')));
  } catch {
    throw BAD_DELETIONS_CURSOR();
  }
  if (c.f !== folderDeletionFilterKey(filter)) throw BAD_DELETIONS_CURSOR();
  return { deletedAt: c.t, id: c.i };
}

/** `%term%` for `UPPER(col) LIKE ? ESCAPE '\'`: upper-cased, with `\`, `%` and `_` escaped. */
const containsUpper = (term: string) =>
  `%${term.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** DELETED_AT exactly as read (Mapepire returns TIMESTAMP as text), to bind back as the cursor. */
const cursorTimestamp = (v: unknown) => (v instanceof Date ? toDbTimestamp(v) : String(v));

/** A deletion page with keyset continuation. */
export interface FolderDeletionSearchPage extends FolderDeletionPage {
  /** Where the next (older) page starts, or null when this is the last page. */
  next: FolderDeletionCursor | null;
}

/** Someone who has deleted at least one recorded folder (the "Deleted by" filter's choices). */
export interface FolderDeletionActor {
  id: string;
  name?: string;
}

/** PRINCIPAL_ID of a REPORTS row in QF_FOLDER_SHARE_AUDIT (see FOLDER_REPORTS_PRINCIPAL). */
const REPORTS_PRINCIPAL = '*REPORTS';
const shareRole = (v: unknown): 'VIEWER' | 'EDITOR' | null =>
  v === 'EDITOR' ? 'EDITOR' : v === 'VIEWER' ? 'VIEWER' : null;

export const folderInputSchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, 'Folder name is required.')
        .max(128, 'Folder name is too long.')
        .refine(
          (v) => ![...v].some((c) => c.charCodeAt(0) < 32),
          'Folder name contains invalid characters.',
        )
        .refine((v) => v.toUpperCase() !== 'UNFILED', '"Unfiled" is reserved.')
        .refine((v) => v.toUpperCase() !== 'FAVORITES', '"Favorites" is reserved.'),
    ),
});

const nameKey = (name: string) => name.trim().toUpperCase();
const isDuplicate = (e: unknown) =>
  e instanceof DbError && (e.sqlState === '23505' || e.sqlCode === -803);
export const FOLDER_NOT_FOUND = () => new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found.');
const duplicate = (name: string) =>
  new AppError(409, 'DUPLICATE_FOLDER', `You already have a folder named "${name}".`);

const toFolder = (r: Record<string, unknown>): Folder => ({
  id: String(r.FOLDER_ID),
  name: String(r.FOLDER_NAME),
  createdAt: dbTimestampToIso(r.CREATED_AT),
  updatedAt: dbTimestampToIso(r.UPDATED_AT),
});

const toDeletion = (r: Record<string, unknown>): FolderDeletion => ({
  id: String(r.DELETION_ID),
  folderId: String(r.FOLDER_ID),
  folderName: String(r.FOLDER_NAME ?? ''),
  ownerId: String(r.OWNER_ID),
  ownerName: r.OWNER_NAME ? String(r.OWNER_NAME) : undefined,
  actorId: String(r.ACTOR_ID),
  actorName: r.ACTOR_NAME ? String(r.ACTOR_NAME) : undefined,
  shareCount: Number(r.SHARE_COUNT ?? 0),
  placedCount: Number(r.PLACED_COUNT ?? 0),
  filedCount: Number(r.FILED_COUNT ?? 0),
  reportsRole: shareRole(r.REPORTS_ROLE),
  deletedAt: dbTimestampToIso(r.DELETED_AT) ?? String(r.DELETED_AT),
});

/**
 * Per-user folders and favorites (migration 006). Every statement is parameterised and
 * scoped by the signed-in user's ID, so one user can never see, rename, delete or file
 * into another user's folders, or change another user's favorites. Sharing a folder with
 * other people (migration 009) is handled by FolderAccessService; personal filing here is
 * unchanged by it. Whether the user may
 * see the report itself is checked by the caller (AccessService) before setPref.
 */
export class FolderRepository {
  private readonly folders: string;
  private readonly prefsTable: string;
  private readonly folderReports: string;
  private readonly folderShares: string;
  private readonly reportSharing: string;
  private readonly folderShareAudit: string;
  private readonly deletions: string;
  private readonly users: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.folders = q(schema, T.folders);
    this.prefsTable = q(schema, T.reportPrefs);
    this.folderReports = q(schema, T.folderReports);
    this.folderShares = q(schema, T.folderShares);
    this.reportSharing = q(schema, T.folderReportSharing);
    this.folderShareAudit = q(schema, T.folderShareAudit);
    this.deletions = q(schema, T.folderDeletions);
    this.users = q(schema, T.users);
  }

  async list(userId: string): Promise<Folder[]> {
    const rows = await this.db.query(
      `SELECT FOLDER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM ${this.folders} WHERE OWNER_ID = ? ORDER BY FOLDER_NAME_KEY`,
      [userId],
    );
    return rows.map(toFolder);
  }

  /**
   * Any user's folder by ID, with its owner. Callers must authorise the viewer first
   * (FolderAccessService.require); this never decides who may see the folder.
   */
  async findById(folderId: string): Promise<(Folder & { ownerId: string }) | null> {
    const rows = await this.db.query(
      `SELECT FOLDER_ID, OWNER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM ${this.folders} WHERE FOLDER_ID = ?`,
      [folderId],
    );
    return rows[0] ? { ...toFolder(rows[0]), ownerId: String(rows[0].OWNER_ID) } : null;
  }

  async get(userId: string, folderId: string): Promise<Folder> {
    const rows = await this.db.query(
      `SELECT FOLDER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM ${this.folders} WHERE FOLDER_ID = ? AND OWNER_ID = ?`,
      [folderId, userId],
    );
    if (!rows[0]) throw FOLDER_NOT_FOUND();
    return toFolder(rows[0]);
  }

  async create(userId: string, name: string): Promise<Folder> {
    const existing = await this.list(userId);
    if (existing.length >= MAX_FOLDERS)
      throw new AppError(400, 'TOO_MANY_FOLDERS', `You can have at most ${MAX_FOLDERS} folders.`);
    const id = randomUUID();
    try {
      await this.db.update(
        `INSERT INTO ${this.folders} (FOLDER_ID, OWNER_ID, FOLDER_NAME, FOLDER_NAME_KEY, CREATED_AT, UPDATED_AT) VALUES (?, ?, ?, ?, ${NOW_UTC}, ${NOW_UTC})`,
        [id, userId, name, nameKey(name)],
      );
    } catch (e) {
      if (isDuplicate(e)) throw duplicate(name);
      throw e;
    }
    return this.get(userId, id);
  }

  async rename(userId: string, folderId: string, name: string): Promise<Folder> {
    let n: number;
    try {
      n = await this.db.update(
        `UPDATE ${this.folders} SET FOLDER_NAME = ?, FOLDER_NAME_KEY = ?, UPDATED_AT = ${NOW_UTC} WHERE FOLDER_ID = ? AND OWNER_ID = ?`,
        [name, nameKey(name), folderId, userId],
      );
    } catch (e) {
      if (isDuplicate(e)) throw duplicate(name);
      throw e;
    }
    if (n === 0) throw FOLDER_NOT_FOUND();
    return this.get(userId, folderId);
  }

  /**
   * Delete a folder. Its reports become Unfiled; no report is deleted. Returns how many of the
   * owner's own filed reports moved. If the folder was shared, its shares and the reports
   * others placed in it (migration 009) and its "share the reports" option (011) go with it in
   * the same transaction (the foreign keys also cascade), so every access that came through the
   * folder ends; the reports themselves and their own shares are untouched.
   *
   * The same transaction records the deletion (migration 013): a REVOKE row in the folder's
   * sharing audit trail for every share and for the report-sharing option it ended, and one
   * QF_FOLDER_DELETIONS row with who deleted it, when, its name and what it had. Neither audit
   * table has a foreign key to QF_FOLDERS, so both outlive the folder. If any statement fails,
   * nothing is deleted and nothing is recorded.
   */
  async remove(userId: string, folderId: string): Promise<{ moved: number }> {
    return this.db.transaction(async (tx) => {
      // Read what the folder has before it goes. Scoped to the owner; a folder that is not the
      // caller's reads as empty here and the DELETE below finds no row and rolls back.
      const [folder] = await tx.query<Record<string, unknown>>(
        `SELECT FOLDER_NAME FROM ${this.folders} WHERE FOLDER_ID = ? AND OWNER_ID = ?`,
        [folderId, userId],
      );
      const shares = folder
        ? await tx.query<Record<string, unknown>>(
            `SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT FROM ${this.folderShares} WHERE FOLDER_ID = ? ORDER BY PRINCIPAL_TYPE, PRINCIPAL_ID`,
            [folderId],
          )
        : [];
      const [sharing] = folder
        ? await tx.query<Record<string, unknown>>(
            `SELECT MAX_ROLE FROM ${this.reportSharing} WHERE FOLDER_ID = ?`,
            [folderId],
          )
        : [];
      const moved = await tx.update(
        `UPDATE ${this.prefsTable} SET FOLDER_ID = NULL, UPDATED_AT = ${NOW_UTC} WHERE USER_ID = ? AND FOLDER_ID = ?`,
        [userId, folderId],
      );
      // Only the owner's own folder: the DELETE below re-checks OWNER_ID and rolls all of this back.
      const placed = await tx.update(`DELETE FROM ${this.folderReports} WHERE FOLDER_ID = ?`, [
        folderId,
      ]);
      await tx.update(`DELETE FROM ${this.folderShares} WHERE FOLDER_ID = ?`, [folderId]);
      await tx.update(`DELETE FROM ${this.reportSharing} WHERE FOLDER_ID = ?`, [folderId]);
      const n = await tx.update(
        `DELETE FROM ${this.folders} WHERE FOLDER_ID = ? AND OWNER_ID = ?`,
        [folderId, userId],
      );
      if (n === 0) throw FOLDER_NOT_FOUND(); // rolls back the UPDATE
      const reportsRole = shareRole(sharing?.MAX_ROLE);
      // An expired share (migration 014) is revoked like any other; its expiry goes on the row.
      const revoke = (type: string, id: string, oldRole: string | null, oldExpiry: unknown) =>
        tx.update(
          `INSERT INTO ${this.folderShareAudit} (AUDIT_ID, FOLDER_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, OLD_EXPIRES_AT, NEW_EXPIRES_AT, ACTOR_ID, OCCURRED_AT)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
          [
            randomUUID(),
            folderId,
            'REVOKE',
            type,
            id,
            oldRole,
            null,
            expiryParam(expiryIso(oldExpiry)),
            null,
            userId,
          ],
        );
      for (const sh of shares)
        await revoke(
          sh.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER',
          String(sh.PRINCIPAL_ID),
          shareRole(sh.SHARE_ROLE),
          sh.EXPIRES_AT,
        );
      if (reportsRole) await revoke('REPORTS', REPORTS_PRINCIPAL, reportsRole, null);
      await tx.update(
        `INSERT INTO ${this.deletions} (DELETION_ID, FOLDER_ID, FOLDER_NAME, OWNER_ID, ACTOR_ID, SHARE_COUNT, PLACED_COUNT, FILED_COUNT, REPORTS_ROLE, DELETED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_UTC})`,
        [
          randomUUID(),
          folderId,
          folder ? String(folder.FOLDER_NAME) : '',
          userId,
          userId,
          shares.length,
          Math.max(0, placed),
          Math.max(0, moved),
          reportsRole,
        ],
      );
      return { moved };
    });
  }

  /**
   * Deleted folders, newest first (migration 013). Admin only: the caller must have checked.
   * Reads one row past the page to tell whether older deletions exist. Kept for OFFSET paging
   * without filters; see searchDeletions.
   */
  async listDeletions(limit: number, offset: number): Promise<FolderDeletionPage> {
    const { deletions, hasMore } = await this.searchDeletions({}, { limit, offset });
    return { deletions, hasMore };
  }

  /**
   * The WHERE clause for a deletion filter, over `D` (QF_FOLDER_DELETIONS) and `OU` (the owner's
   * QF_USERS row, LEFT JOINed). Every value is a parameter marker; text search is upper-cased on
   * both sides and its LIKE wildcards are escaped, the same as the saved-reports and user searches.
   */
  private deletionWhere(f: FolderDeletionFilter, after: FolderDeletionCursor | null = null) {
    const where: string[] = [];
    const params: string[] = [];
    if (f.q) {
      const like = containsUpper(f.q);
      // The exact owner-ID match is only added when the term fits OWNER_ID (VARCHAR(36)).
      const byId = f.q.length <= 36;
      where.push(
        `(UPPER(D.FOLDER_NAME) LIKE ? ESCAPE '\\' OR UPPER(OU.DISPLAY_NAME) LIKE ? ESCAPE '\\' OR UPPER(OU.USERNAME) LIKE ? ESCAPE '\\'${byId ? ' OR D.OWNER_ID = ?' : ''})`,
      );
      params.push(like, like, like, ...(byId ? [f.q] : []));
    }
    if (f.actorId) {
      where.push('D.ACTOR_ID = ?');
      params.push(f.actorId);
    }
    if (f.from) {
      where.push('D.DELETED_AT >= CAST(? AS TIMESTAMP)');
      params.push(toDbTimestamp(new Date(f.from)));
    }
    if (f.to) {
      where.push('D.DELETED_AT < CAST(? AS TIMESTAMP)');
      params.push(toDbTimestamp(new Date(f.to)));
    }
    if (after) {
      where.push(
        '(D.DELETED_AT < CAST(? AS TIMESTAMP) OR (D.DELETED_AT = CAST(? AS TIMESTAMP) AND D.DELETION_ID > ?))',
      );
      params.push(after.deletedAt, after.deletedAt, after.id);
    }
    return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
  }

  /**
   * One page of deleted folders matching `filter`, newest first (DELETED_AT DESC, DELETION_ID).
   * With `after` it continues strictly after that row (keyset paging): a deletion recorded while
   * someone pages cannot shift later pages, and the filters are applied to every page the same
   * way. Without it, `offset` rows are skipped (the original API). Admin only: caller checks.
   */
  async searchDeletions(
    filter: FolderDeletionFilter,
    page: { limit: number; offset?: number; after?: FolderDeletionCursor | null },
  ): Promise<FolderDeletionSearchPage> {
    const n = Math.max(1, Math.min(Math.floor(page.limit) || FOLDER_DELETIONS_PAGE, 1000));
    const after = page.after ?? null;
    const skip = after
      ? 0
      : Math.max(0, Math.min(Math.floor(page.offset ?? 0) || 0, MAX_FOLDER_DELETIONS_OFFSET));
    const where = this.deletionWhere(filter, after);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT D.DELETION_ID, D.FOLDER_ID, D.FOLDER_NAME, D.OWNER_ID, D.ACTOR_ID, D.SHARE_COUNT, D.PLACED_COUNT,
              D.FILED_COUNT, D.REPORTS_ROLE, D.DELETED_AT, OU.DISPLAY_NAME AS OWNER_NAME, AU.DISPLAY_NAME AS ACTOR_NAME
         FROM ${this.deletions} D
         LEFT JOIN ${this.users} OU ON OU.USER_ID = D.OWNER_ID
         LEFT JOIN ${this.users} AU ON AU.USER_ID = D.ACTOR_ID${where.sql}
        ORDER BY D.DELETED_AT DESC, D.DELETION_ID
        ${skip ? `OFFSET ${skip} ROWS ` : ''}FETCH FIRST ${n + 1} ROWS ONLY`,
      where.params,
    );
    const pageRows = rows.slice(0, n);
    const last = pageRows.at(-1);
    const hasMore = rows.length > n;
    return {
      deletions: pageRows.map(toDeletion),
      hasMore,
      next:
        hasMore && last
          ? { deletedAt: cursorTimestamp(last.DELETED_AT), id: String(last.DELETION_ID) }
          : null,
    };
  }

  /** How many deletions match `filter` (a full count; no index helps the text search). */
  async countDeletions(filter: FolderDeletionFilter): Promise<number> {
    const where = this.deletionWhere(filter);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS N
         FROM ${this.deletions} D${
           filter.q ? `\n         LEFT JOIN ${this.users} OU ON OU.USER_ID = D.OWNER_ID` : ''
         }${where.sql}`,
      where.params,
    );
    return Number(rows[0]?.N ?? 0);
  }

  /** Every deletion matching `filter`, newest first, read a keyset batch at a time (export). */
  async *allDeletions(
    filter: FolderDeletionFilter,
    size = FOLDER_DELETIONS_EXPORT_BATCH,
  ): AsyncGenerator<FolderDeletion[]> {
    let after: FolderDeletionCursor | null = null;
    do {
      const page: FolderDeletionSearchPage = await this.searchDeletions(filter, {
        limit: size,
        after,
      });
      if (page.deletions.length) yield page.deletions;
      after = page.next;
    } while (after);
  }

  /** Distinct users who deleted a recorded folder, by name (the "Deleted by" filter). */
  async deletionActors(): Promise<FolderDeletionActor[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT DISTINCT D.ACTOR_ID, AU.DISPLAY_NAME AS ACTOR_NAME
         FROM ${this.deletions} D
         LEFT JOIN ${this.users} AU ON AU.USER_ID = D.ACTOR_ID
        ORDER BY D.ACTOR_ID
        FETCH FIRST ${MAX_FOLDER_DELETION_ACTORS} ROWS ONLY`,
    );
    return rows
      .map((r) => ({
        id: String(r.ACTOR_ID),
        name: r.ACTOR_NAME ? String(r.ACTOR_NAME) : undefined,
      }))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id));
  }

  /** The most recent deletion record for a folder ID, or null if none was recorded. */
  async findDeletion(folderId: string): Promise<FolderDeletion | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT D.DELETION_ID, D.FOLDER_ID, D.FOLDER_NAME, D.OWNER_ID, D.ACTOR_ID, D.SHARE_COUNT, D.PLACED_COUNT,
              D.FILED_COUNT, D.REPORTS_ROLE, D.DELETED_AT, OU.DISPLAY_NAME AS OWNER_NAME, AU.DISPLAY_NAME AS ACTOR_NAME
         FROM ${this.deletions} D
         LEFT JOIN ${this.users} OU ON OU.USER_ID = D.OWNER_ID
         LEFT JOIN ${this.users} AU ON AU.USER_ID = D.ACTOR_ID
        WHERE D.FOLDER_ID = ?
        ORDER BY D.DELETED_AT DESC, D.DELETION_ID
        FETCH FIRST 1 ROWS ONLY`,
      [folderId],
    );
    return rows[0] ? toDeletion(rows[0]) : null;
  }

  /** The user's folder / favorite for every report they have filed or starred. */
  async prefs(userId: string): Promise<Map<string, ReportPref>> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT REPORT_ID, FOLDER_ID, IS_FAVORITE FROM ${this.prefsTable} WHERE USER_ID = ?`,
      [userId],
    );
    return new Map(
      rows.map((r) => [
        String(r.REPORT_ID),
        {
          folderId: r.FOLDER_ID === null || r.FOLDER_ID === undefined ? null : String(r.FOLDER_ID),
          favorite: Number(r.IS_FAVORITE) === 1,
        },
      ]),
    );
  }

  /**
   * Change the user's folder and/or favorite for one report. The caller must already have
   * checked that the user can view the report. A target folder must belong to the user.
   */
  async setPref(
    userId: string,
    reportId: string,
    change: { folderId?: string | null; favorite?: boolean },
  ): Promise<ReportPref> {
    if (change.folderId) await this.get(userId, change.folderId); // 404 for someone else's folder
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<Record<string, unknown>>(
        `SELECT FOLDER_ID, IS_FAVORITE FROM ${this.prefsTable} WHERE USER_ID = ? AND REPORT_ID = ?`,
        [userId, reportId],
      );
      const cur: ReportPref = rows[0]
        ? {
            folderId: rows[0].FOLDER_ID == null ? null : String(rows[0].FOLDER_ID),
            favorite: Number(rows[0].IS_FAVORITE) === 1,
          }
        : { folderId: null, favorite: false };
      const next: ReportPref = {
        folderId: change.folderId !== undefined ? change.folderId : cur.folderId,
        favorite: change.favorite !== undefined ? change.favorite : cur.favorite,
      };
      if (!next.folderId && !next.favorite) {
        await tx.update(`DELETE FROM ${this.prefsTable} WHERE USER_ID = ? AND REPORT_ID = ?`, [
          userId,
          reportId,
        ]);
      } else if (rows[0]) {
        await tx.update(
          `UPDATE ${this.prefsTable} SET FOLDER_ID = ?, IS_FAVORITE = ?, UPDATED_AT = ${NOW_UTC} WHERE USER_ID = ? AND REPORT_ID = ?`,
          [next.folderId, next.favorite ? 1 : 0, userId, reportId],
        );
      } else {
        await tx.update(
          `INSERT INTO ${this.prefsTable} (USER_ID, REPORT_ID, FOLDER_ID, IS_FAVORITE, UPDATED_AT) VALUES (?, ?, ?, ?, ${NOW_UTC})`,
          [userId, reportId, next.folderId, next.favorite ? 1 : 0],
        );
      }
      return next;
    });
  }
}
