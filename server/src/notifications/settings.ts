import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import { DbError } from '../util/errors.js';

export interface UserSettings {
  /** E-mails about shares: being given access, a role change, and end-date reminders. */
  shareEmails: boolean;
}
export const DEFAULT_USER_SETTINGS: UserSettings = { shareEmails: true };

const duplicate = (e: unknown) =>
  e instanceof DbError && (e.sqlState === '23505' || e.sqlCode === -803);

/** Per-user settings (QF_USER_SETTINGS, migration 015). No row means the defaults. */
export class UserSettingsRepository {
  private readonly table: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.userSettings);
  }

  async get(userId: string): Promise<UserSettings> {
    const rows = await this.db.query<{ SHARE_EMAILS: unknown }>(
      `SELECT SHARE_EMAILS FROM ${this.table} WHERE USER_ID = ?`,
      [userId],
    );
    return rows[0]
      ? { shareEmails: Number(rows[0].SHARE_EMAILS) !== 0 }
      : { ...DEFAULT_USER_SETTINGS };
  }

  /** Update the row, or insert it the first time (a concurrent insert falls back to the update). */
  async set(userId: string, s: UserSettings): Promise<UserSettings> {
    const v = s.shareEmails ? 1 : 0;
    const upd = () =>
      this.db.update(
        `UPDATE ${this.table} SET SHARE_EMAILS = ?, UPDATED_AT = ${NOW_UTC} WHERE USER_ID = ?`,
        [v, userId],
      );
    if ((await upd()) === 0) {
      try {
        await this.db.update(
          `INSERT INTO ${this.table} (USER_ID, SHARE_EMAILS, UPDATED_AT) VALUES (?, ?, ${NOW_UTC})`,
          [userId, v],
        );
      } catch (e) {
        if (!duplicate(e)) throw e;
        await upd();
      }
    }
    return this.get(userId);
  }
}
