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
  email?: string | null;
  authSource?: AuthSource;
}
export type AuthSource = 'LOCAL' | 'OIDC' | 'LDAP';

/** Identity asserted by an external provider after it has authenticated the user. */
export interface ExternalIdentity {
  source: 'OIDC' | 'LDAP';
  externalId: string;
  username: string;
  displayName: string;
  email?: string | null;
  /** Raw IdP / directory group names (mapped to app groups via GROUP_MAP). */
  groups: string[];
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
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
  AUTH_SOURCE?: AuthSource;
  EMAIL?: string | null;
}

const toUser = (r: UserRow): AppUser => ({
  id: r.USER_ID,
  username: r.USERNAME,
  displayName: r.DISPLAY_NAME,
  role: r.ROLE,
  email: r.EMAIL ?? null,
  authSource: r.AUTH_SOURCE ?? 'LOCAL',
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
      `SELECT USER_ID, USERNAME, DISPLAY_NAME, ROLE, IS_ACTIVE, AUTH_SOURCE, EMAIL FROM ${this.table} WHERE USER_ID = ? AND IS_ACTIVE = 1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async verifyCredentials(username: string, password: string): Promise<AppUser | null> {
    const uname = username.trim().toLowerCase();
    const rows = await this.db.query<UserRow>(
      `SELECT USER_ID, USERNAME, DISPLAY_NAME, PASSWORD_HASH, ROLE, IS_ACTIVE, FAILED_LOGINS, AUTH_SOURCE, EMAIL,
              CASE WHEN LOCKED_UNTIL > ${NOW_UTC} THEN LOCKED_UNTIL ELSE NULL END AS LOCKED_UNTIL
         FROM ${this.table} WHERE USERNAME = ?`,
      [uname],
    );
    const row = rows[0];
    // External (OIDC / LDAP) accounts can never sign in with a local password.
    if (
      !row ||
      Number(row.IS_ACTIVE) !== 1 ||
      (row.AUTH_SOURCE ?? 'LOCAL') !== 'LOCAL' ||
      !String(row.PASSWORD_HASH).startsWith('$2')
    ) {
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

  /**
   * Find or create the account for an externally authenticated identity, keyed by
   * (AUTH_SOURCE, EXTERNAL_ID). A local account with the same username is never
   * taken over: the sign-in is rejected instead.
   */
  async upsertExternal(id: ExternalIdentity, role: Role): Promise<AppUser> {
    const username = normaliseUsername(id.username);
    const displayName = (id.displayName || username).slice(0, 256);
    const email = id.email ? id.email.slice(0, 320) : null;
    const existing = await this.db.query<UserRow>(
      `SELECT USER_ID, USERNAME, DISPLAY_NAME, ROLE, IS_ACTIVE, AUTH_SOURCE, EMAIL FROM ${this.table}
        WHERE AUTH_SOURCE = ? AND EXTERNAL_ID = ?`,
      [id.source, id.externalId],
    );
    if (existing[0]) {
      if (Number(existing[0].IS_ACTIVE) !== 1)
        throw new AppError(403, 'ACCOUNT_DISABLED', 'Your Uncle Bob account is disabled.');
      await this.db.update(
        `UPDATE ${this.table} SET DISPLAY_NAME = ?, EMAIL = ?, ROLE = ?, LAST_LOGIN_AT = ${NOW_UTC}, UPDATED_AT = ${NOW_UTC}
          WHERE USER_ID = ?`,
        [displayName, email, role, existing[0].USER_ID],
      );
      return {
        id: existing[0].USER_ID,
        username: existing[0].USERNAME,
        displayName,
        role,
        email,
        authSource: id.source,
      };
    }
    const clash = await this.db.query<{ USER_ID: string }>(
      `SELECT USER_ID FROM ${this.table} WHERE USERNAME = ?`,
      [username],
    );
    if (clash[0])
      throw new AppError(
        409,
        'USERNAME_TAKEN',
        'An account with this username already exists. Ask an administrator to link it.',
      );
    const newId = randomUUID();
    await this.db.update(
      `INSERT INTO ${this.table} (USER_ID, USERNAME, DISPLAY_NAME, PASSWORD_HASH, ROLE, IS_ACTIVE, FAILED_LOGINS,
          AUTH_SOURCE, EXTERNAL_ID, EMAIL, LAST_LOGIN_AT, CREATED_AT, UPDATED_AT)
       VALUES (?, ?, ?, '!', ?, 1, 0, ?, ?, ?, ${NOW_UTC}, ${NOW_UTC}, ${NOW_UTC})`,
      [newId, username, displayName, role, id.source, id.externalId, email],
    );
    return { id: newId, username, displayName, role, email, authSource: id.source };
  }

  /** Active users matching a search term, for the share dialog. */
  async search(term: string, limit = 20): Promise<UserSummary[]> {
    const t = `%${term
      .trim()
      .toUpperCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db.query<UserRow>(
      `SELECT USER_ID, USERNAME, DISPLAY_NAME FROM ${this.table}
        WHERE IS_ACTIVE = 1 AND (UPPER(USERNAME) LIKE ? ESCAPE '\\' OR UPPER(DISPLAY_NAME) LIKE ? ESCAPE '\\')
        ORDER BY USERNAME FETCH FIRST ${Math.min(Math.max(limit, 1), 50)} ROWS ONLY`,
      [t, t],
    );
    return rows.map((r) => ({ id: r.USER_ID, username: r.USERNAME, displayName: r.DISPLAY_NAME }));
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

/** Usernames for external identities: lower-case, restricted character set. */
export function normaliseUsername(raw: string): string {
  const u = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, '_')
    .slice(0, 128);
  if (u.length < 2)
    throw new AppError(
      400,
      'INVALID_USERNAME',
      'The identity provider did not supply a usable username.',
    );
  return u;
}
