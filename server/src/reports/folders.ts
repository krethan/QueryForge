import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import { AppError, DbError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';

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

/**
 * Per-user folders and favorites (migration 006). Every statement is parameterised and
 * scoped by the signed-in user's ID, so one user can never see, rename, delete or file
 * into another user's folders, or change another user's favorites. Whether the user may
 * see the report itself is checked by the caller (AccessService) before setPref.
 */
export class FolderRepository {
  private readonly folders: string;
  private readonly prefsTable: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.folders = q(schema, T.folders);
    this.prefsTable = q(schema, T.reportPrefs);
  }

  async list(userId: string): Promise<Folder[]> {
    const rows = await this.db.query(
      `SELECT FOLDER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM ${this.folders} WHERE OWNER_ID = ? ORDER BY FOLDER_NAME_KEY`,
      [userId],
    );
    return rows.map(toFolder);
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

  /** Delete a folder. Its reports become Unfiled; no report is deleted. Returns how many moved. */
  async remove(userId: string, folderId: string): Promise<{ moved: number }> {
    return this.db.transaction(async (tx) => {
      const moved = await tx.update(
        `UPDATE ${this.prefsTable} SET FOLDER_ID = NULL, UPDATED_AT = ${NOW_UTC} WHERE USER_ID = ? AND FOLDER_ID = ?`,
        [userId, folderId],
      );
      const n = await tx.update(
        `DELETE FROM ${this.folders} WHERE FOLDER_ID = ? AND OWNER_ID = ?`,
        [folderId, userId],
      );
      if (n === 0) throw FOLDER_NOT_FOUND(); // rolls back the UPDATE
      return { moved };
    });
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
