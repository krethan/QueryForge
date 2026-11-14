import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppUser } from '../auth/users.js';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q, toDbTimestamp } from '../db/schema.js';
import type { ReportRepository } from '../reports/reports.js';
import type { AccessService, ShareRole } from '../sharing/access.js';
import { expiryIso, expiryMs, systemClock, type Clock } from '../sharing/expiry.js';
import type { FolderAccessService } from '../sharing/folder-access.js';
import type { GroupRepository } from '../sharing/groups.js';
import { AppError, DbError, sanitizeErrorMessage } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';

/**
 * In-app notifications: the bell in the header and its panel.
 *
 * Nothing is stored per notification. The list is worked out on each request from what is
 * already recorded, and only for the signed-in user:
 *   SHARED / ROLE_CHANGED  a GRANT or CHANGE row in the report or folder share audit
 *                          (QF_SHARE_AUDIT 003, QF_FOLDER_SHARE_AUDIT 009) naming the user or one
 *                          of their groups, made by someone else, while that share is still in
 *                          force (it still exists and has not expired, migration 014);
 *   SHARE_ENDING / SHARE_ENDED  a report or folder share with an end date (EXPIRES_AT, 014) that
 *                          ends within the reminder window or ended in the last 30 days, on
 *                          something the user owns or that was shared with them;
 *   DELIVERY_FAILED        a FAILED attempt of a schedule the user created
 *                          (QF_SCHEDULE_DELIVERIES 010).
 *
 * Access is enforced here, on the server: a share event is only listed while the share is in
 * force, a failed delivery only while the user can still open the report, and a share of theirs
 * that has ended names the report or folder only if they can still open it some other way (an
 * owner always sees the names of their own reports and folders). Otherwise the item says "a
 * report" or "a folder" and links nowhere.
 *
 * The only thing kept per user is when they last chose "Mark all read":
 * QF_USER_SETTINGS.NOTICES_READ_AT (migration 016). Everything newer is unread. Without 016 the
 * list still works (everything in the window counts as unread) and "Mark all read" says that the
 * migration is needed.
 */

export type NoticeKind =
  'SHARED' | 'ROLE_CHANGED' | 'SHARE_ENDING' | 'SHARE_ENDED' | 'DELIVERY_FAILED';
export type NoticeTargetType = 'REPORT' | 'FOLDER' | 'SCHEDULE';

export interface Notice {
  /** Stable for the same event, so a client can key on it; also the paging tie-breaker. */
  id: string;
  kind: NoticeKind;
  /** When it happened (ISO-8601 UTC); for SHARE_ENDING, when the end entered the window. */
  at: string;
  unread: boolean;
  /** What kind of thing it is about, even when its name may not be shown. */
  targetType: NoticeTargetType;
  /**
   * The report, folder or schedule. Null when the user may no longer see it (a share of theirs
   * that ended): then neither its name nor its ID is sent.
   */
  target: { id: string; name: string } | null;
  /** SHARE_ENDING / SHARE_ENDED: you shared it (OWNER) or it was shared with you (RECIPIENT). */
  side?: 'OWNER' | 'RECIPIENT';
  /** SHARED / ROLE_CHANGED: who shared it. */
  actorName?: string;
  role?: ShareRole;
  oldRole?: ShareRole;
  /** Through which group it was shared with you, or (owner side) who the share is for. */
  principal?: { type: 'USER' | 'GROUP'; name: string };
  expiresAt?: string | null;
  /** DELIVERY_FAILED: the report the schedule sends, and why it failed. */
  report?: { id: string; name: string };
  error?: string | null;
}

export interface NoticePage {
  items: Notice[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
  lastReadAt: string | null;
  /** False until migration 016 is applied: "Mark all read" is not available. */
  readStateAvailable: boolean;
}

export interface NoticeCount {
  /** Unread notifications, at most MAX_UNREAD_COUNT. */
  unread: number;
  /** True when there are more than MAX_UNREAD_COUNT. */
  capped: boolean;
}

/** How far back the list goes (days). */
export const NOTICE_WINDOW_DAYS = 30;
/** Rows read per source per request: bounds the work whatever the history holds. */
export const NOTICE_SOURCE_CAP = 100;
export const NOTICE_PAGE = 20;
export const MAX_NOTICE_PAGE = 50;
/** The bell shows "99+" beyond this. */
export const MAX_UNREAD_COUNT = 99;
/** Access checks per request for ended shares and failed deliveries; beyond it, fail closed. */
export const MAX_ACCESS_CHECKS = 25;
/** Window for "ends soon" when e-mail reminders are turned off (QF_SHARE_REMINDER_DAYS=0). */
export const DEFAULT_SOON_DAYS = 3;
/** Groups put in one IN list; more are ignored (fail closed: fewer notifications, never more). */
export const MAX_NOTICE_GROUPS = 500;

const DAY = 24 * 60 * 60 * 1000;

export const noticeQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_NOTICE_PAGE).default(NOTICE_PAGE),
    cursor: z.string().max(200).optional(),
  })
  .strict();

interface Cursor {
  t: number;
  i: string;
}

/** Opaque keyset cursor: the (time, id) of the last item on the page. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeCursor(s: string): Cursor {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    const c = z
      .object({ t: z.number().int().nonnegative(), i: z.string().min(1).max(160) })
      .strict()
      .parse(v);
    return c;
  } catch {
    throw new AppError(400, 'BAD_CURSOR', 'The notification page cursor is not valid.');
  }
}

/** Newest first; equal times by id, descending. */
const newerFirst = (a: Item, b: Item) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
/** True when `x` sorts after (is older than) the cursor. */
const after = (x: Item, c: Cursor) => x.t < c.t || (x.t === c.t && x.id < c.i);

type Item = Omit<Notice, 'at' | 'unread'> & { t: number };
type Row = Record<string, unknown>;

const role = (v: unknown): ShareRole | undefined =>
  v === 'EDITOR' ? 'EDITOR' : v === 'VIEWER' ? 'VIEWER' : undefined;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const ms = (v: unknown): number | null => {
  const iso = dbTimestampToIso(v);
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};
/** A short, non-reversible key for an item whose target must not be revealed. */
const hidden = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Db2 for i: column not found (SQL0206, SQLSTATE 42703), i.e. migration 016 not applied. */
const missingColumn = (e: unknown) =>
  e instanceof DbError && (e.sqlState === '42703' || e.sqlCode === -206);

export interface NoticeConfig {
  /** Days before a share ends that it shows as ending soon (QF_SHARE_REMINDER_DAYS, or 3). */
  soonDays: number;
}

export class NotificationInbox {
  private readonly users: string;
  private readonly reports: string;
  private readonly folders: string;
  private readonly shares: string;
  private readonly folderShares: string;
  private readonly audit: string;
  private readonly folderAudit: string;
  private readonly schedules: string;
  private readonly deliveries: string;
  private readonly settings: string;

  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly deps: {
      reports: ReportRepository;
      access: AccessService;
      folderAccess: FolderAccessService;
      groups: GroupRepository;
    },
    private readonly cfg: NoticeConfig,
    private readonly clock: Clock = systemClock,
  ) {
    this.users = q(schema, T.users);
    this.reports = q(schema, T.reports);
    this.folders = q(schema, T.folders);
    this.shares = q(schema, T.shares);
    this.folderShares = q(schema, T.folderShares);
    this.audit = q(schema, T.shareAudit);
    this.folderAudit = q(schema, T.folderShareAudit);
    this.schedules = q(schema, T.schedules);
    this.deliveries = q(schema, T.scheduleDeliveries);
    this.settings = q(schema, T.userSettings);
  }

  private get soonMs() {
    return (this.cfg.soonDays > 0 ? this.cfg.soonDays : DEFAULT_SOON_DAYS) * DAY;
  }

  // ---- read state (QF_USER_SETTINGS.NOTICES_READ_AT, migration 016) ----

  /** When the user last marked everything read, and whether that can be stored at all. */
  async readState(userId: string): Promise<{ readAt: number | null; available: boolean }> {
    try {
      const rows = await this.db.query<{ NOTICES_READ_AT: unknown }>(
        `SELECT NOTICES_READ_AT FROM ${this.settings} WHERE USER_ID = ?`,
        [userId],
      );
      return { readAt: rows[0] ? ms(rows[0].NOTICES_READ_AT) : null, available: true };
    } catch (e) {
      if (!missingColumn(e)) throw e;
      return { readAt: null, available: false };
    }
  }

  /**
   * Mark everything up to now read. The stored time is the later of the app's clock and the
   * newest notification, so an event stamped by a Db2 clock slightly ahead of this server's is
   * not left unread.
   */
  async markAllRead(user: Pick<AppUser, 'id' | 'role'>): Promise<{ lastReadAt: string }> {
    const newest = (await this.page(user, { limit: 1 })).items[0];
    const t = Math.max(this.clock().getTime(), newest ? Date.parse(newest.at) : 0);
    const at = toDbTimestamp(new Date(t));
    const upd = () =>
      this.db.update(
        `UPDATE ${this.settings} SET NOTICES_READ_AT = CAST(? AS TIMESTAMP), UPDATED_AT = ${NOW_UTC} WHERE USER_ID = ?`,
        [at, user.id],
      );
    try {
      if ((await upd()) === 0) {
        try {
          await this.db.update(
            `INSERT INTO ${this.settings} (USER_ID, SHARE_EMAILS, NOTICES_READ_AT, UPDATED_AT) VALUES (?, 1, CAST(? AS TIMESTAMP), ${NOW_UTC})`,
            [user.id, at],
          );
        } catch (e) {
          if (!(e instanceof DbError && (e.sqlState === '23505' || e.sqlCode === -803))) throw e;
          await upd(); // inserted concurrently (another tab): update it instead
        }
      }
    } catch (e) {
      if (!missingColumn(e)) throw e;
      throw new AppError(
        503,
        'MIGRATION_REQUIRED',
        'Marking notifications read needs metadata migration 016. Ask an administrator to run it.',
      );
    }
    return { lastReadAt: new Date(t).toISOString() };
  }

  // ---- the list ----

  /** Unread notifications for the bell (at most MAX_UNREAD_COUNT). */
  async count(user: Pick<AppUser, 'id' | 'role'>): Promise<NoticeCount> {
    const { readAt } = await this.readState(user.id);
    const items = await this.collect(user, { since: readAt, before: null });
    const n = readAt === null ? items.length : items.filter((x) => x.t > readAt).length;
    return { unread: Math.min(n, MAX_UNREAD_COUNT), capped: n > MAX_UNREAD_COUNT };
  }

  /** One page of notifications, newest first, keyset-paged on (time, id). */
  async page(
    user: Pick<AppUser, 'id' | 'role'>,
    opts: { limit?: number; cursor?: string },
  ): Promise<NoticePage> {
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? NOTICE_PAGE), MAX_NOTICE_PAGE));
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const [state, all] = await Promise.all([
      this.readState(user.id),
      this.collect(user, { since: null, before: cursor ? cursor.t : null }),
    ]);
    const rest = cursor ? all.filter((x) => after(x, cursor)) : all;
    const pageItems = rest.slice(0, limit);
    const last = pageItems[pageItems.length - 1];
    return {
      items: pageItems.map(({ t, ...x }) => ({
        ...x,
        at: new Date(t).toISOString(),
        unread: state.readAt === null || t > state.readAt,
      })),
      nextCursor: rest.length > limit && last ? encodeCursor({ t: last.t, i: last.id }) : null,
      lastReadAt: state.readAt === null ? null : new Date(state.readAt).toISOString(),
      readStateAvailable: state.available,
    };
  }

  /**
   * Every notification in the window for this user, newest first. `since` (exclusive) narrows
   * the window for the unread count; `before` (the cursor's time) skips newer ones when paging.
   */
  private async collect(
    user: Pick<AppUser, 'id' | 'role'>,
    w: { since: number | null; before: number | null },
  ): Promise<Item[]> {
    const now = this.clock().getTime();
    const from = Math.max(now - NOTICE_WINDOW_DAYS * DAY, w.since ?? 0);
    // +1 ms: Db2 keeps microseconds, the cursor milliseconds; the exact cut is made in memory.
    const to = w.before === null ? null : w.before + 1;
    const groups = (await this.deps.groups.forUser(user.id)).slice(0, MAX_NOTICE_GROUPS);
    const checks = new AccessChecks(this.deps, user);
    const lists = await Promise.all([
      this.shareEvents('REPORT', user.id, groups, from, to, now),
      this.shareEvents('FOLDER', user.id, groups, from, to, now),
      this.expiries('REPORT', user, groups, now, checks),
      this.expiries('FOLDER', user, groups, now, checks),
      this.failedDeliveries(user, from, to, checks),
    ]);
    return lists
      .flat()
      .filter((x) => x.t > from && (to === null || x.t < to))
      .sort(newerFirst);
  }

  /** "(A.PRINCIPAL_TYPE = 'USER' AND A.PRINCIPAL_ID = ?) OR group IN (...)" and its values. */
  private principal(alias: string, userId: string, groups: string[]) {
    const g = groups.length
      ? ` OR (${alias}.PRINCIPAL_TYPE = 'GROUP' AND ${alias}.PRINCIPAL_ID IN (${placeholders(groups.length)}))`
      : '';
    return {
      sql: `((${alias}.PRINCIPAL_TYPE = 'USER' AND ${alias}.PRINCIPAL_ID = ?)${g})`,
      params: [userId, ...groups],
    };
  }

  /**
   * GRANT and CHANGE audit rows naming the user or one of their groups, by someone else, on
   * something the user does not own, whose share is still in force (same principal, not
   * expired). Revoked and expired shares are left out entirely, so their names never show.
   */
  private async shareEvents(
    kind: 'REPORT' | 'FOLDER',
    userId: string,
    groups: string[],
    from: number,
    to: number | null,
    now: number,
  ): Promise<Item[]> {
    const r = kind === 'REPORT';
    const audit = r ? this.audit : this.folderAudit;
    const key = r ? 'REPORT_ID' : 'FOLDER_ID';
    const p = this.principal('A', userId, groups);
    const rows = await this.db.query<Row>(
      `SELECT A.AUDIT_ID, A.${key} AS TARGET_ID, A.ACTION, A.PRINCIPAL_TYPE, A.PRINCIPAL_ID, A.OLD_ROLE, A.NEW_ROLE,
              A.NEW_EXPIRES_AT, A.OCCURRED_AT, O.${r ? 'REPORT_NAME' : 'FOLDER_NAME'} AS TARGET_NAME, U.DISPLAY_NAME AS ACTOR_NAME
         FROM ${audit} A JOIN ${r ? this.reports : this.folders} O ON O.${key} = A.${key}
         LEFT JOIN ${this.users} U ON U.USER_ID = A.ACTOR_ID
        WHERE A.ACTION IN ('GRANT', 'CHANGE') AND A.ACTOR_ID <> ? AND O.OWNER_ID <> ?
          AND A.OCCURRED_AT > CAST(? AS TIMESTAMP)${to === null ? '' : ' AND A.OCCURRED_AT < CAST(? AS TIMESTAMP)'}
          AND ${p.sql}
          AND EXISTS (SELECT 1 FROM ${r ? this.shares : this.folderShares} S
                       WHERE S.${key} = A.${key} AND S.PRINCIPAL_TYPE = A.PRINCIPAL_TYPE AND S.PRINCIPAL_ID = A.PRINCIPAL_ID
                         AND (S.EXPIRES_AT IS NULL OR S.EXPIRES_AT > CAST(? AS TIMESTAMP)))
        ORDER BY A.OCCURRED_AT DESC, A.AUDIT_ID DESC FETCH FIRST ${NOTICE_SOURCE_CAP} ROWS ONLY`,
      [
        userId,
        userId,
        toDbTimestamp(new Date(from)),
        ...(to === null ? [] : [toDbTimestamp(new Date(to))]),
        ...p.params,
        toDbTimestamp(new Date(now)),
      ],
    );
    const out: Item[] = [];
    for (const x of rows) {
      const t = ms(x.OCCURRED_AT);
      if (t === null) continue;
      const newRole = role(x.NEW_ROLE);
      out.push({
        id: `${r ? 'rs' : 'fs'}:${str(x.AUDIT_ID)}`,
        kind: x.ACTION === 'CHANGE' ? 'ROLE_CHANGED' : 'SHARED',
        t,
        targetType: kind,
        target: { id: str(x.TARGET_ID), name: str(x.TARGET_NAME) },
        actorName: str(x.ACTOR_NAME) || 'Someone',
        ...(newRole ? { role: newRole } : {}),
        ...(role(x.OLD_ROLE) ? { oldRole: role(x.OLD_ROLE) } : {}),
        ...(x.PRINCIPAL_TYPE === 'GROUP'
          ? { principal: { type: 'GROUP' as const, name: str(x.PRINCIPAL_ID) } }
          : {}),
        expiresAt: expiryIso(x.NEW_EXPIRES_AT),
      });
    }
    return out;
  }

  /**
   * Shares with an end date that ends soon or ended in the window: on the user's own reports or
   * folders (they see who it was for), or shared with the user or one of their groups.
   */
  private async expiries(
    kind: 'REPORT' | 'FOLDER',
    user: Pick<AppUser, 'id' | 'role'>,
    groups: string[],
    now: number,
    checks: AccessChecks,
  ): Promise<Item[]> {
    const r = kind === 'REPORT';
    const key = r ? 'REPORT_ID' : 'FOLDER_ID';
    const p = this.principal('S', user.id, groups);
    const rows = await this.db.query<Row>(
      `SELECT S.${key} AS TARGET_ID, S.PRINCIPAL_TYPE, S.PRINCIPAL_ID, S.SHARE_ROLE, S.EXPIRES_AT, S.CREATED_AT,
              O.${r ? 'REPORT_NAME' : 'FOLDER_NAME'} AS TARGET_NAME, O.OWNER_ID, U.DISPLAY_NAME AS PRINCIPAL_NAME
         FROM ${r ? this.shares : this.folderShares} S JOIN ${r ? this.reports : this.folders} O ON O.${key} = S.${key}
         LEFT JOIN ${this.users} U ON S.PRINCIPAL_TYPE = 'USER' AND U.USER_ID = S.PRINCIPAL_ID
        WHERE S.EXPIRES_AT IS NOT NULL AND S.EXPIRES_AT > CAST(? AS TIMESTAMP) AND S.EXPIRES_AT <= CAST(? AS TIMESTAMP)
          AND (O.OWNER_ID = ? OR ${p.sql})
        ORDER BY S.EXPIRES_AT DESC FETCH FIRST ${NOTICE_SOURCE_CAP} ROWS ONLY`,
      [
        toDbTimestamp(new Date(now - NOTICE_WINDOW_DAYS * DAY)),
        toDbTimestamp(new Date(now + this.soonMs)),
        user.id,
        ...p.params,
      ],
    );
    const out: Item[] = [];
    const seenHidden = new Set<string>();
    for (const x of rows) {
      const exp = expiryMs(x.EXPIRES_AT);
      if (exp === null) continue;
      const ended = exp <= now;
      const owner = x.OWNER_ID === user.id;
      // a share created already close to its end appears when it was made, not before
      const created = ms(x.CREATED_AT) ?? 0;
      const t = ended ? exp : Math.max(exp - this.soonMs, created);
      const targetId = str(x.TARGET_ID);
      const base = {
        kind: (ended ? 'SHARE_ENDED' : 'SHARE_ENDING') as NoticeKind,
        t,
        targetType: kind,
        expiresAt: new Date(exp).toISOString(),
        ...(role(x.SHARE_ROLE) ? { role: role(x.SHARE_ROLE) } : {}),
      };
      const principalName =
        x.PRINCIPAL_TYPE === 'GROUP' ? str(x.PRINCIPAL_ID) : str(x.PRINCIPAL_NAME) || 'a user';
      const principal = {
        type: (x.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER') as 'USER' | 'GROUP',
        name: principalName,
      };
      const idBase = `${kind}|${targetId}|${str(x.PRINCIPAL_TYPE)}|${str(x.PRINCIPAL_ID)}|${exp}`;
      if (owner) {
        out.push({
          ...base,
          id: `${ended ? 'xe' : 'xs'}:${hidden(idBase)}`,
          side: 'OWNER',
          target: { id: targetId, name: str(x.TARGET_NAME) },
          principal,
        });
        continue;
      }
      // Shared with me. Ending soon: the share is still in force, so the name may show.
      // Ended: only if I can still open it another way; otherwise say "a report" / "a folder".
      const visible = ended
        ? await checks.canSee(kind, { id: targetId, ownerId: str(x.OWNER_ID) })
        : true;
      if (!visible) {
        const k = `${kind}|${targetId}|${exp}`;
        if (seenHidden.has(k)) continue; // a user share and a group share ending together
        seenHidden.add(k);
        out.push({ ...base, id: `xe:${hidden(k)}`, side: 'RECIPIENT', target: null });
        continue;
      }
      out.push({
        ...base,
        id: `${ended ? 'xe' : 'xs'}:${hidden(idBase)}`,
        side: 'RECIPIENT',
        target: { id: targetId, name: str(x.TARGET_NAME) },
        ...(x.PRINCIPAL_TYPE === 'GROUP' ? { principal } : {}),
      });
    }
    return out;
  }

  /** FAILED deliveries of schedules the user created, while they can still open the report. */
  private async failedDeliveries(
    user: Pick<AppUser, 'id' | 'role'>,
    from: number,
    to: number | null,
    checks: AccessChecks,
  ): Promise<Item[]> {
    const rows = await this.db.query<Row>(
      `SELECT D.DELIVERY_ID, D.SCHEDULE_ID, D.REPORT_ID, D.FINISHED_AT, D.RUN_TRIGGER, D.ERROR_MESSAGE, R.REPORT_NAME, R.OWNER_ID
         FROM ${this.deliveries} D JOIN ${this.schedules} S ON S.SCHEDULE_ID = D.SCHEDULE_ID
         JOIN ${this.reports} R ON R.REPORT_ID = D.REPORT_ID
        WHERE S.CREATED_BY = ? AND D.STATUS = 'FAILED' AND D.FINISHED_AT > CAST(? AS TIMESTAMP)${
          to === null ? '' : ' AND D.FINISHED_AT < CAST(? AS TIMESTAMP)'
        }
        ORDER BY D.FINISHED_AT DESC, D.DELIVERY_ID DESC FETCH FIRST ${NOTICE_SOURCE_CAP} ROWS ONLY`,
      [
        user.id,
        toDbTimestamp(new Date(from)),
        ...(to === null ? [] : [toDbTimestamp(new Date(to))]),
      ],
    );
    const out: Item[] = [];
    for (const x of rows) {
      const t = ms(x.FINISHED_AT);
      if (t === null) continue;
      const reportId = str(x.REPORT_ID);
      if (!(await checks.canSee('REPORT', { id: reportId, ownerId: str(x.OWNER_ID) }))) continue;
      out.push({
        id: `df:${str(x.DELIVERY_ID)}`,
        kind: 'DELIVERY_FAILED',
        t,
        targetType: 'SCHEDULE',
        target: { id: str(x.SCHEDULE_ID), name: str(x.REPORT_NAME) },
        report: { id: reportId, name: str(x.REPORT_NAME) },
        error: x.ERROR_MESSAGE ? sanitizeErrorMessage(String(x.ERROR_MESSAGE)).slice(0, 300) : null,
      });
    }
    return out;
  }
}

/**
 * Per-request access checks with the same services the report and folder endpoints use,
 * cached by target and capped at MAX_ACCESS_CHECKS (anything beyond is treated as not visible).
 */
class AccessChecks {
  private readonly cache = new Map<string, Promise<boolean>>();
  constructor(
    private readonly deps: {
      reports: ReportRepository;
      access: AccessService;
      folderAccess: FolderAccessService;
    },
    private readonly user: Pick<AppUser, 'id' | 'role'>,
  ) {}

  canSee(kind: 'REPORT' | 'FOLDER', t: { id: string; ownerId: string }): Promise<boolean> {
    if (t.ownerId === this.user.id) return Promise.resolve(true);
    const k = `${kind}|${t.id}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    if (this.cache.size >= MAX_ACCESS_CHECKS) return Promise.resolve(false);
    const p = (async () => {
      if (kind === 'FOLDER') return (await this.deps.folderAccess.roleFor(this.user, t)) !== null;
      const report = await this.deps.reports.findById(t.id);
      return report ? (await this.deps.access.roleFor(this.user, report)) !== null : false;
    })();
    this.cache.set(k, p);
    return p;
  }
}
