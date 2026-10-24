import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import { AppError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';

export type Role = 'USER' | 'ADMIN';
export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

const BCRYPT_COST = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 12;

// A real bcrypt hash used to keep timing similar when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('queryforge-timing-equaliser', 4);

interface UserRow {
  USER_ID: string;
  USERNAME: string;
  DISPLAY_NAME: string;
  PASSWORD_HASH: string;
  ROLE: Role;
  IS_ACTIVE: number;
  FAILED_LOGINS: number;
  LOCKED_UNTIL: string | null;
}

const toUser = (r: UserRow): AppUser => ({
  id: r.USER_ID,
  username: r.USERNAME,
  displayName: r.DISPLAY_NAME,
  role: r.ROLE,
});

/**
 * Application user store in Db2 for i. Passwords are hashed with bcrypt (bcryptjs);
 * no custom cryptography. These identities are independent from IBM i user profiles.
 */
export class UserRepository {
  private readonly table: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.users);
  }

  async findById(id: string): Promise<AppUser | null> {
    const rows = await this.db.query<UserRow>(
      `SELECT USER_ID, USERNAME, DISPLAY_NAME, ROLE, IS_ACTIVE FROM ${this.table} WHERE USER_ID = ? AND IS_ACTIVE = 1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async verifyCredentials(username: string, password: string): Promise<AppUser | null> {
    const uname = username.trim().toLowerCase();
    const rows = await this.db.query<UserRow>(
      `SELECT USER_ID, USERNAME, DISPLAY_NAME, PASSWORD_HASH, ROLE, IS_ACTIVE, FAILED_LOGINS,
              CASE WHEN LOCKED_UNTIL > ${NOW_UTC} THEN LOCKED_UNTIL ELSE NULL END AS LOCKED_UNTIL
         FROM ${this.table} WHERE USERNAME = ?`,
      [uname],
    );
    const row = rows[0];
    if (!row || Number(row.IS_ACTIVE) !== 1) {
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }
    if (row.LOCKED_UNTIL) {
      throw new AppError(
        423,
        'ACCOUNT_LOCKED',
        'Too many failed sign-in attempts. Try again later.',
        {
          lockedUntil: dbTimestampToIso(row.LOCKED_UNTIL),
        },
      );
    }
    const ok = await bcrypt.compare(password, row.PASSWORD_HASH);
    if (!ok) {
      await this.db.update(
        `UPDATE ${this.table}
            SET FAILED_LOGINS = FAILED_LOGINS + 1,
                LOCKED_UNTIL = CASE WHEN FAILED_LOGINS + 1 >= ? THEN ${NOW_UTC} + ${LOCK_MINUTES} MINUTES ELSE NULL END
          WHERE USER_ID = ?`,
        [MAX_FAILED, row.USER_ID],
      );
      return null;
    }
    await this.db.update(
      `UPDATE ${this.table} SET FAILED_LOGINS = 0, LOCKED_UNTIL = NULL, LAST_LOGIN_AT = ${NOW_UTC} WHERE USER_ID = ?`,
      [row.USER_ID],
    );
    return toUser(row);
  }

  async upsert(input: {
    username: string;
    displayName: string;
    password: string;
    role: Role;
  }): Promise<AppUser> {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9._@-]{2,128}$/.test(username))
      throw new AppError(400, 'INVALID_USERNAME', 'Invalid username');
    if (input.password.length < MIN_PASSWORD_LENGTH)
      throw new AppError(
        400,
        'WEAK_PASSWORD',
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    const hash = await bcrypt.hash(input.password, BCRYPT_COST);
    const existing = await this.db.query<{ USER_ID: string }>(
      `SELECT USER_ID FROM ${this.table} WHERE USERNAME = ?`,
      [username],
    );
    if (existing[0]) {
      await this.db.update(
        `UPDATE ${this.table} SET DISPLAY_NAME = ?, PASSWORD_HASH = ?, ROLE = ?, IS_ACTIVE = 1, FAILED_LOGINS = 0,
                LOCKED_UNTIL = NULL, UPDATED_AT = ${NOW_UTC} WHERE USER_ID = ?`,
        [input.displayName, hash, input.role, existing[0].USER_ID],
      );
      return {
        id: existing[0].USER_ID,
        username,
        displayName: input.displayName,
        role: input.role,
      };
    }
    const id = randomUUID();
    await this.db.update(
      `INSERT INTO ${this.table} (USER_ID, USERNAME, DISPLAY_NAME, PASSWORD_HASH, ROLE, IS_ACTIVE, FAILED_LOGINS, CREATED_AT, UPDATED_AT)
       VALUES (?, ?, ?, ?, ?, 1, 0, ${NOW_UTC}, ${NOW_UTC})`,
      [id, username, input.displayName, hash, input.role],
    );
    return { id, username, displayName: input.displayName, role: input.role };
  }
}
