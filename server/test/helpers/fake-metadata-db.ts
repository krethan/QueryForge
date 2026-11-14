import type { MetadataDb } from '../../src/db/types.js';
import { DbError } from '../../src/util/errors.js';

type P = (string | number | null)[];
type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the Db2 for i metadata tables, used only by tests.
 * It understands exactly the parameterised statements Uncle Bob issues and
 * asserts that no user-supplied value ever appears inside SQL text.
 */
export class FakeMetadataDb implements MetadataDb {
  users = new Map<string, Row>();
  reports = new Map<string, Row>();
  executions = new Map<string, Row>();
  /** key `${userId}|${group}` */
  userGroups = new Map<string, Row>();
  shares: Row[] = [];
  shareAudit: Row[] = [];
  schedules = new Map<string, Row>();
  locks = new Map<string, Row>();
  folders = new Map<string, Row>();
  /** key `${userId}|${reportId}` */
  reportPrefs = new Map<string, Row>();
  /** key `${userId}|${reportId}` */
  tileOrder = new Map<string, Row>();
  folderShares: Row[] = [];
  /** key `${folderId}|${reportId}` */
  folderReports = new Map<string, Row>();
  folderShareAudit: Row[] = [];
  scheduleDeliveries: Row[] = [];
  /** key folderId (migration 011) */
  folderReportSharing = new Map<string, Row>();
  /** QF_FOLDER_DELETIONS (migration 013): no foreign keys, never cascaded. */
  folderDeletions: Row[] = [];
  /** QF_SHARE_REMINDERS (migration 015): unique on kind, target, principal and EXPIRES_AT. */
  shareReminders: Row[] = [];
  /** QF_USER_SETTINGS (migration 015), key USER_ID. */
  userSettings = new Map<string, Row>();
  statements: { sql: string; params: P }[] = [];
  private clock = 0;
  failNext?: Error;

  /**
   * Where the fake's own CURRENT TIMESTAMP comes from. Unset (the default), it is a fixed day in
   * October 2026 that ticks once per row; tests of time-ordered features (in-app notifications)
   * can point it at their movable clock instead. Every value is still distinct (a microsecond
   * counter is added).
   */
  dbClock?: () => Date;
  /** False simulates a database where migration 016 (QF_USER_SETTINGS.NOTICES_READ_AT) is missing. */
  noticesReadColumn = true;

  private now() {
    this.clock++;
    if (this.dbClock)
      return (
        this.dbClock().toISOString().replace('T', ' ').slice(0, 23) +
        String(this.clock % 1000).padStart(3, '0')
      );
    return `2026-10-23 12:00:${String(this.clock % 60).padStart(2, '0')}.${String(this.clock).padStart(6, '0')}`;
  }

  private record(sql: string, params: P) {
    this.statements.push({ sql, params });
    for (const p of params) {
      if (typeof p === 'string' && p.length > 3 && sql.includes(p) && !/^[A-Z_]+$/.test(p))
        throw new Error(`Parameter value was concatenated into SQL: ${p}`);
    }
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
  }

  addUser(u: {
    id: string;
    username: string;
    hash: string;
    displayName?: string;
    role?: string;
    active?: number;
  }) {
    this.users.set(u.id, {
      USER_ID: u.id,
      USERNAME: u.username,
      DISPLAY_NAME: u.displayName ?? u.username,
      PASSWORD_HASH: u.hash,
      ROLE: u.role ?? 'USER',
      IS_ACTIVE: u.active ?? 1,
      FAILED_LOGINS: 0,
      LOCKED_UNTIL: null,
      AUTH_SOURCE: 'LOCAL',
      EXTERNAL_ID: null,
      EMAIL: null,
    });
  }

  setEmail(userId: string, email: string | null) {
    const u = this.users.get(userId);
    if (!u) throw new Error(`FakeMetadataDb: no user ${userId}`);
    u.EMAIL = email;
  }

  removeGroup(userId: string, group: string) {
    this.userGroups.delete(`${userId}|${group}`);
  }

  /**
   * The SQL predicate (EXPIRES_AT IS NULL OR EXPIRES_AT > CAST(? AS TIMESTAMP)) for a share row,
   * with `now` the bound Db2 timestamp text. Compared as instants, like Db2 compares TIMESTAMPs.
   */
  static activeAt(sh: Row, now: unknown) {
    if (sh.EXPIRES_AT === null || sh.EXPIRES_AT === undefined) return true;
    const t = (v: unknown) => Date.parse(String(v).trim().replace(' ', 'T').slice(0, 23) + 'Z');
    return t(sh.EXPIRES_AT) > t(now);
  }

  private matchesPrincipal(sh: Row, uid: unknown, groups: unknown[]) {
    return (
      (sh.PRINCIPAL_TYPE === 'USER' && sh.PRINCIPAL_ID === uid) ||
      (sh.PRINCIPAL_TYPE === 'GROUP' && groups.includes(sh.PRINCIPAL_ID))
    );
  }

  /** Statements for sharing a folder's reports (migration 011). */
  private folderReportSharingQuery(s: string, params: P): Row[] | undefined {
    if (
      /^SELECT FOLDER_ID, MAX_ROLE FROM \w+\.QF_FOLDER_REPORT_SHARING WHERE FOLDER_ID IN \(/.test(s)
    )
      return [...this.folderReportSharing.values()]
        .filter((x) => params.includes(x.FOLDER_ID as string))
        .map((x) => ({ FOLDER_ID: x.FOLDER_ID, MAX_ROLE: x.MAX_ROLE }));
    if (
      /^SELECT F\.FOLDER_ID, F\.FOLDER_NAME, X\.MAX_ROLE FROM \w+\.QF_FOLDERS F JOIN \w+\.QF_FOLDER_REPORT_SHARING X ON X\.FOLDER_ID = F\.FOLDER_ID WHERE F\.OWNER_ID = \? ORDER BY F\.FOLDER_NAME_KEY$/.test(
        s,
      )
    )
      return [...this.folders.values()]
        .filter(
          (f) => f.OWNER_ID === params[0] && this.folderReportSharing.has(String(f.FOLDER_ID)),
        )
        .sort((a, b) => String(a.FOLDER_NAME_KEY).localeCompare(String(b.FOLDER_NAME_KEY)))
        .map((f) => ({
          FOLDER_ID: f.FOLDER_ID,
          FOLDER_NAME: f.FOLDER_NAME,
          MAX_ROLE: this.folderReportSharing.get(String(f.FOLDER_ID))!.MAX_ROLE,
        }));
    if (
      /^SELECT FOLDER_ID FROM \w+\.QF_FOLDER_REPORTS WHERE REPORT_ID = \? AND ADDED_BY = \? AND FOLDER_ID IN \(/.test(
        s,
      )
    ) {
      const [rid, by, ...fids] = params;
      return [...this.folderReports.values()]
        .filter(
          (i) => i.REPORT_ID === rid && i.ADDED_BY === by && fids.includes(i.FOLDER_ID as string),
        )
        .map((i) => ({ FOLDER_ID: i.FOLDER_ID }));
    }
    if (
      /^SELECT S\.FOLDER_ID, S\.PRINCIPAL_TYPE, S\.PRINCIPAL_ID, S\.SHARE_ROLE, S\.EXPIRES_AT, U\.DISPLAY_NAME FROM \w+\.QF_FOLDER_SHARES S LEFT JOIN \w+\.QF_USERS U ON S\.PRINCIPAL_TYPE = 'USER' AND U\.USER_ID = S\.PRINCIPAL_ID WHERE S\.FOLDER_ID IN \(/.test(
        s,
      )
    )
      return this.folderShares
        .filter((x) => params.includes(x.FOLDER_ID as string))
        .map((x): Row => ({
          ...x,
          DISPLAY_NAME:
            x.PRINCIPAL_TYPE === 'USER'
              ? (this.users.get(String(x.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
              : null,
        }))
        .sort((a, b) =>
          `${a.FOLDER_ID}|${a.PRINCIPAL_TYPE}|${a.PRINCIPAL_ID}`.localeCompare(
            `${b.FOLDER_ID}|${b.PRINCIPAL_TYPE}|${b.PRINCIPAL_ID}`,
          ),
        );
    if (
      /^SELECT S\.FOLDER_ID, S\.SHARE_ROLE, S\.EXPIRES_AT, F\.OWNER_ID, X\.MAX_ROLE FROM \w+\.QF_FOLDER_SHARES S JOIN \w+\.QF_FOLDERS F ON F\.FOLDER_ID = S\.FOLDER_ID JOIN \w+\.QF_FOLDER_REPORT_SHARING X ON X\.FOLDER_ID = S\.FOLDER_ID WHERE F\.OWNER_ID <> \? AND \(\(S\.PRINCIPAL_TYPE = 'USER' AND S\.PRINCIPAL_ID = \?\)( OR \(S\.PRINCIPAL_TYPE = 'GROUP' AND S\.PRINCIPAL_ID IN \([?, ]+\)\))?\)$/.test(
        s,
      )
    ) {
      const [notOwner, uid, ...groups] = params;
      const out: Row[] = [];
      for (const sh of this.folderShares) {
        const f = this.folders.get(String(sh.FOLDER_ID));
        const x = this.folderReportSharing.get(String(sh.FOLDER_ID));
        if (!f || !x || f.OWNER_ID === notOwner || !this.matchesPrincipal(sh, uid, groups))
          continue;
        out.push({
          FOLDER_ID: sh.FOLDER_ID,
          SHARE_ROLE: sh.SHARE_ROLE,
          EXPIRES_AT: sh.EXPIRES_AT ?? null,
          OWNER_ID: f.OWNER_ID,
          MAX_ROLE: x.MAX_ROLE,
        });
      }
      return out;
    }
    if (
      /FROM \w+\.QF_REPORTS R JOIN \w+\.QF_USERS U ON U\.USER_ID = R\.OWNER_ID WHERE R\.REPORT_ID IN \(/.test(
        s,
      )
    )
      return params
        .map((id) => this.reports.get(String(id)))
        .filter((r): r is Row => Boolean(r))
        .map((r) => ({ ...r, OWNER_NAME: this.users.get(String(r.OWNER_ID))?.DISPLAY_NAME }));
    if (
      /^SELECT U\.USER_ID, U\.DISPLAY_NAME, U\.EMAIL FROM \w+\.QF_USERS U WHERE U\.IS_ACTIVE = 1 AND U\.EMAIL IS NOT NULL AND \(U\.USER_ID IN \(|^SELECT U\.USER_ID, U\.DISPLAY_NAME, U\.EMAIL FROM \w+\.QF_USERS U WHERE U\.IS_ACTIVE = 1 AND U\.EMAIL IS NOT NULL AND \(U\.USER_ID IN \(SELECT G\.USER_ID FROM \w+\.QF_USER_GROUPS G WHERE G\.GROUP_NAME IN \(/.test(
        s,
      )
    ) {
      // folder-granted recipients: direct user IDs first, then group names (see RecipientService)
      const direct = /U\.USER_ID IN \(([?, ]+)\)/.exec(s);
      const nUsers = direct ? (direct[1].match(/\?/g) ?? []).length : 0;
      const ids = params.slice(0, nUsers);
      const groups = params.slice(nUsers);
      return [...this.users.values()]
        .filter(
          (u) =>
            u.IS_ACTIVE === 1 &&
            u.EMAIL !== null &&
            (ids.includes(u.USER_ID as string) ||
              [...this.userGroups.values()].some(
                (g) => g.USER_ID === u.USER_ID && groups.includes(g.GROUP_NAME as string),
              )),
        )
        .sort((a, b) => String(a.DISPLAY_NAME).localeCompare(String(b.DISPLAY_NAME)))
        .map((u) => ({ USER_ID: u.USER_ID, DISPLAY_NAME: u.DISPLAY_NAME, EMAIL: u.EMAIL }));
    }
    return undefined;
  }

  private folderQuery(s: string, params: P): Row[] | undefined {
    const sharing = this.folderReportSharingQuery(s, params);
    if (sharing) return sharing;
    if (
      /^SELECT FOLDER_ID, OWNER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM \w+\.QF_FOLDERS WHERE FOLDER_ID = \?$/.test(
        s,
      )
    ) {
      const f = this.folders.get(String(params[0]));
      return f ? [{ ...f }] : [];
    }
    if (
      /^SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT FROM \w+\.QF_FOLDER_SHARES WHERE FOLDER_ID = \?$/.test(
        s,
      )
    )
      return this.folderShares.filter((x) => x.FOLDER_ID === params[0]).map((x) => ({ ...x }));
    if (/^SELECT FOLDER_ID, EXPIRES_AT FROM \w+\.QF_FOLDER_SHARES WHERE FOLDER_ID IN \(/.test(s))
      return this.folderShares
        .filter((x) => params.includes(x.FOLDER_ID as string))
        .map((x) => ({ FOLDER_ID: x.FOLDER_ID, EXPIRES_AT: x.EXPIRES_AT ?? null }));
    if (
      /FROM \w+\.QF_FOLDERS F JOIN \w+\.QF_FOLDER_SHARES S ON S\.FOLDER_ID = F\.FOLDER_ID JOIN \w+\.QF_USERS U ON U\.USER_ID = F\.OWNER_ID WHERE F\.OWNER_ID <> \?/.test(
        s,
      )
    ) {
      const admin = /WHERE F\.OWNER_ID <> \? ORDER BY/.test(s);
      const [notOwner, uid, ...groups] = params;
      const out: Row[] = [];
      for (const sh of this.folderShares) {
        const f = this.folders.get(String(sh.FOLDER_ID));
        if (!f || f.OWNER_ID === notOwner) continue;
        const match =
          admin ||
          (sh.PRINCIPAL_TYPE === 'USER' && sh.PRINCIPAL_ID === uid) ||
          (sh.PRINCIPAL_TYPE === 'GROUP' && groups.includes(sh.PRINCIPAL_ID as string));
        if (!match) continue;
        out.push({
          ...f,
          SHARE_ROLE: sh.SHARE_ROLE,
          EXPIRES_AT: sh.EXPIRES_AT ?? null,
          OWNER_NAME: this.users.get(String(f.OWNER_ID))?.DISPLAY_NAME,
        });
      }
      return out.sort((a, b) => String(a.FOLDER_NAME_KEY).localeCompare(String(b.FOLDER_NAME_KEY)));
    }
    if (
      /FROM \w+\.QF_FOLDER_REPORTS I JOIN \w+\.QF_REPORTS R ON R\.REPORT_ID = I\.REPORT_ID WHERE I\.FOLDER_ID IN \(/.test(
        s,
      )
    )
      return [...this.folderReports.values()]
        .filter(
          (i) => params.includes(i.FOLDER_ID as string) && this.reports.has(String(i.REPORT_ID)),
        )
        .map((i) => ({
          ...i,
          REPORT_NAME_KEY: this.reports.get(String(i.REPORT_ID))!.REPORT_NAME_KEY,
          OWNER_ID: this.reports.get(String(i.REPORT_ID))!.OWNER_ID,
        }));
    if (
      /FROM \w+\.QF_REPORT_PREFS P JOIN \w+\.QF_REPORTS R ON R\.REPORT_ID = P\.REPORT_ID WHERE P\.FOLDER_ID IN \(/.test(
        s,
      )
    )
      return [...this.reportPrefs.values()]
        .filter(
          (p) =>
            p.FOLDER_ID !== null &&
            params.includes(p.FOLDER_ID as string) &&
            this.reports.has(String(p.REPORT_ID)),
        )
        .map((p) => ({
          ...p,
          REPORT_NAME_KEY: this.reports.get(String(p.REPORT_ID))!.REPORT_NAME_KEY,
          OWNER_ID: this.reports.get(String(p.REPORT_ID))!.OWNER_ID,
        }));
    if (
      /^SELECT REPORT_ID, ADDED_BY FROM \w+\.QF_FOLDER_REPORTS WHERE FOLDER_ID = \? AND REPORT_ID = \?$/.test(
        s,
      )
    ) {
      const i = this.folderReports.get(`${params[0]}|${params[1]}`);
      return i ? [{ REPORT_ID: i.REPORT_ID, ADDED_BY: i.ADDED_BY }] : [];
    }
    if (/FROM \w+\.QF_FOLDER_SHARES S LEFT JOIN \w+\.QF_USERS U .* WHERE S\.FOLDER_ID = \?/.test(s))
      return this.folderShares
        .filter((x) => x.FOLDER_ID === params[0])
        .sort((a, b) =>
          `${a.PRINCIPAL_TYPE}:${a.PRINCIPAL_ID}`.localeCompare(
            `${b.PRINCIPAL_TYPE}:${b.PRINCIPAL_ID}`,
          ),
        )
        .map((x) => ({
          ...x,
          DISPLAY_NAME:
            x.PRINCIPAL_TYPE === 'USER'
              ? (this.users.get(String(x.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
              : null,
        }));
    if (
      /FROM \w+\.QF_FOLDER_SHARE_AUDIT A .* WHERE A\.FOLDER_ID = \? ORDER BY A\.OCCURRED_AT DESC/.test(
        s,
      )
    ) {
      // ORDER BY A.OCCURRED_AT DESC, A.AUDIT_ID [OFFSET n ROWS] FETCH FIRST m ROWS ONLY
      const page = /(?:OFFSET (\d+) ROWS )?FETCH FIRST (\d+) ROWS ONLY$/.exec(s);
      const skip = Number(page?.[1] ?? 0);
      const take = page ? Number(page[2]) : Infinity;
      return this.folderShareAudit
        .filter((a) => a.FOLDER_ID === params[0])
        .sort(
          (a, b) =>
            String(b.OCCURRED_AT).localeCompare(String(a.OCCURRED_AT)) ||
            String(a.AUDIT_ID).localeCompare(String(b.AUDIT_ID)),
        )
        .slice(skip, skip + take)
        .map((a) => ({
          ...a,
          ACTOR_NAME: this.users.get(String(a.ACTOR_ID))?.DISPLAY_NAME ?? null,
          PRINCIPAL_NAME:
            a.PRINCIPAL_TYPE === 'USER'
              ? (this.users.get(String(a.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
              : null,
        }));
    }
    return undefined;
  }

  private folderUpdate(s: string, params: P): number | undefined {
    if (/^DELETE FROM \w+\.QF_FOLDER_REPORT_SHARING WHERE FOLDER_ID = \?$/.test(s))
      return this.folderReportSharing.delete(String(params[0])) ? 1 : 0;
    if (
      /^INSERT INTO \w+\.QF_FOLDER_REPORT_SHARING \(FOLDER_ID, MAX_ROLE, UPDATED_BY, UPDATED_AT\) VALUES \(\?, \?, \?, /.test(
        s,
      )
    ) {
      const [folderId, role, by] = params;
      if (!this.folders.has(String(folderId)))
        throw new DbError('Foreign key violation.', '23503', -530);
      if (this.folderReportSharing.has(String(folderId)))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      if (role !== 'VIEWER' && role !== 'EDITOR')
        throw new DbError('Check constraint.', '23513', -545);
      this.folderReportSharing.set(String(folderId), {
        FOLDER_ID: folderId,
        MAX_ROLE: role,
        UPDATED_BY: by,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_FOLDER_REPORTS SET ADDED_BY = \? WHERE FOLDER_ID = \? AND REPORT_ID = \?$/.test(
        s,
      )
    ) {
      const i = this.folderReports.get(`${params[1]}|${params[2]}`);
      if (!i) return 0;
      i.ADDED_BY = params[0];
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_FOLDER_REPORTS \(FOLDER_ID, REPORT_ID, ITEM_POS, ADDED_BY, ADDED_AT\) VALUES \(\?, \?, (NULL|\?), \?, /.test(
        s,
      )
    ) {
      const nullPos = /VALUES \(\?, \?, NULL,/.test(s);
      const [folderId, reportId, ...rest] = params;
      const pos = nullPos ? null : rest[0];
      const by = nullPos ? rest[0] : rest[1];
      if (this.folderReports.has(`${folderId}|${reportId}`))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      if (!this.folders.has(String(folderId)) || !this.reports.has(String(reportId)))
        throw new DbError('Foreign key violation.', '23503', -530);
      if (pos !== null && (typeof pos !== 'number' || pos < 0))
        throw new DbError('Check constraint.', '23513', -545);
      this.folderReports.set(`${folderId}|${reportId}`, {
        FOLDER_ID: folderId,
        REPORT_ID: reportId,
        ITEM_POS: pos,
        ADDED_BY: by,
        ADDED_AT: this.now(),
      });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_FOLDER_REPORTS SET ITEM_POS = \? WHERE FOLDER_ID = \? AND REPORT_ID = \?$/.test(
        s,
      )
    ) {
      const [pos, folderId, reportId] = params;
      const i = this.folderReports.get(`${folderId}|${reportId}`);
      if (!i) return 0;
      if (typeof pos !== 'number' || pos < 0) throw new DbError('Check constraint.', '23513', -545);
      i.ITEM_POS = pos;
      return 1;
    }
    if (/^DELETE FROM \w+\.QF_FOLDER_REPORTS WHERE FOLDER_ID = \? AND REPORT_ID = \?$/.test(s))
      return this.folderReports.delete(`${params[0]}|${params[1]}`) ? 1 : 0;
    if (/^DELETE FROM \w+\.QF_FOLDER_REPORTS WHERE FOLDER_ID = \?$/.test(s)) {
      let n = 0;
      for (const [k, v] of this.folderReports)
        if (v.FOLDER_ID === params[0]) {
          this.folderReports.delete(k);
          n++;
        }
      return n;
    }
    if (/^DELETE FROM \w+\.QF_FOLDER_SHARES WHERE FOLDER_ID = \?$/.test(s)) {
      const before = this.folderShares.length;
      this.folderShares = this.folderShares.filter((x) => x.FOLDER_ID !== params[0]);
      return before - this.folderShares.length;
    }
    if (
      /^INSERT INTO \w+\.QF_FOLDER_SHARES \(FOLDER_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT, CREATED_BY, CREATED_AT\)/.test(
        s,
      )
    ) {
      const [folderId, type, id, role, expiresAt, by] = params;
      if (!this.folders.has(String(folderId)))
        throw new DbError('Foreign key violation.', '23503', -530);
      if (
        this.folderShares.some(
          (x) => x.FOLDER_ID === folderId && x.PRINCIPAL_TYPE === type && x.PRINCIPAL_ID === id,
        )
      )
        throw new DbError('Duplicate key value specified.', '23505', -803);
      this.folderShares.push({
        FOLDER_ID: folderId,
        PRINCIPAL_TYPE: type,
        PRINCIPAL_ID: id,
        SHARE_ROLE: role,
        EXPIRES_AT: expiresAt,
        CREATED_BY: by,
        CREATED_AT: this.now(),
      });
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_FOLDER_SHARE_AUDIT \(AUDIT_ID, FOLDER_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, OLD_EXPIRES_AT, NEW_EXPIRES_AT, ACTOR_ID, OCCURRED_AT\)/.test(
        s,
      )
    ) {
      const [id, folderId, action, type, pid, oldRole, newRole, oldExp, newExp, actor] = params;
      // QF_FSAU_CK_ACTION as widened by migration 014
      if (!['GRANT', 'CHANGE', 'REVOKE', 'EXPIRY'].includes(String(action)))
        throw new DbError('Check constraint QF_FSAU_CK_ACTION violated.', '23513', -545);
      // QF_FSAU_CK_TYPE as widened by migration 012
      if (!['USER', 'GROUP', 'REPORTS'].includes(String(type)))
        throw new DbError('Check constraint QF_FSAU_CK_TYPE violated.', '23513', -545);
      if (![null, 'VIEWER', 'EDITOR'].includes(oldRole as string | null))
        throw new DbError('Check constraint QF_FSAU_CK_OLD violated.', '23513', -545);
      if (![null, 'VIEWER', 'EDITOR'].includes(newRole as string | null))
        throw new DbError('Check constraint QF_FSAU_CK_NEW violated.', '23513', -545);
      this.folderShareAudit.push({
        AUDIT_ID: id,
        FOLDER_ID: folderId,
        ACTION: action,
        PRINCIPAL_TYPE: type,
        PRINCIPAL_ID: pid,
        OLD_ROLE: oldRole,
        NEW_ROLE: newRole,
        OLD_EXPIRES_AT: oldExp,
        NEW_EXPIRES_AT: newExp,
        ACTOR_ID: actor,
        OCCURRED_AT: this.now(),
      });
      return 1;
    }
    return undefined;
  }

  /** Statements for auditing folder deletion (migration 013) and exporting folder audit. */
  private folderDeletionQuery(s: string, params: P): Row[] | undefined {
    if (
      /^SELECT FOLDER_NAME FROM \w+\.QF_FOLDERS WHERE FOLDER_ID = \? AND OWNER_ID = \?$/.test(s)
    ) {
      const f = this.folders.get(String(params[0]));
      return f && f.OWNER_ID === params[1] ? [{ FOLDER_NAME: f.FOLDER_NAME }] : [];
    }
    if (
      /^SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT FROM \w+\.QF_FOLDER_SHARES WHERE FOLDER_ID = \? ORDER BY PRINCIPAL_TYPE, PRINCIPAL_ID$/.test(
        s,
      )
    )
      return this.folderShares
        .filter((x) => x.FOLDER_ID === params[0])
        .sort(
          (a, b) =>
            String(a.PRINCIPAL_TYPE).localeCompare(String(b.PRINCIPAL_TYPE)) ||
            String(a.PRINCIPAL_ID).localeCompare(String(b.PRINCIPAL_ID)),
        )
        .map((x) => ({ ...x }));
    if (/^SELECT MAX_ROLE FROM \w+\.QF_FOLDER_REPORT_SHARING WHERE FOLDER_ID = \?$/.test(s)) {
      const x = this.folderReportSharing.get(String(params[0]));
      return x ? [{ MAX_ROLE: x.MAX_ROLE }] : [];
    }
    // Keyset batch of a folder's audit trail (export).
    if (
      /FROM \w+\.QF_FOLDER_SHARE_AUDIT A .* WHERE A\.FOLDER_ID = \? AND \(A\.OCCURRED_AT < CAST\(\? AS TIMESTAMP\) OR \(A\.OCCURRED_AT = CAST\(\? AS TIMESTAMP\) AND A\.AUDIT_ID > \?\)\) ORDER BY A\.OCCURRED_AT DESC, A\.AUDIT_ID FETCH FIRST (\d+) ROWS ONLY$/.test(
        s,
      )
    ) {
      const take = Number(/FETCH FIRST (\d+) ROWS ONLY$/.exec(s)![1]);
      const [folderId, at, , afterId] = params;
      return this.folderShareAudit
        .filter((a) => a.FOLDER_ID === folderId)
        .filter(
          (a) =>
            String(a.OCCURRED_AT) < String(at) ||
            (String(a.OCCURRED_AT) === String(at) && String(a.AUDIT_ID) > String(afterId)),
        )
        .sort(
          (a, b) =>
            String(b.OCCURRED_AT).localeCompare(String(a.OCCURRED_AT)) ||
            String(a.AUDIT_ID).localeCompare(String(b.AUDIT_ID)),
        )
        .slice(0, take)
        .map((a) => this.withAuditNames(a));
    }
    if (/FROM \w+\.QF_FOLDER_DELETIONS D\b/.test(s)) return this.folderDeletionRows(s, params);
    return undefined;
  }

  /**
   * QF_FOLDER_DELETIONS reads (migration 013): the list / search page, its COUNT(*), the
   * distinct "deleted by" users and the per-folder lookup. The WHERE clause is read in the order
   * FolderRepository writes it, consuming one bound value per marker, and LIKE is evaluated as
   * Db2 does it (case-sensitive, so UPPER() on the column is applied here too, with `\` as the
   * escape character). Anything left unconsumed is an error, so a marker / value mismatch fails.
   */
  private folderDeletionRows(s: string, params: P): Row[] {
    const withNames = (x: Row): Row => {
      const owner = this.users.get(String(x.OWNER_ID));
      return {
        ...x,
        OWNER_NAME: owner?.DISPLAY_NAME ?? null,
        OWNER_USERNAME: owner?.USERNAME ?? null,
        ACTOR_NAME: this.users.get(String(x.ACTOR_ID))?.DISPLAY_NAME ?? null,
      };
    };
    if (
      /^SELECT DISTINCT D\.ACTOR_ID, AU\.DISPLAY_NAME AS ACTOR_NAME FROM \w+\.QF_FOLDER_DELETIONS D LEFT JOIN \w+\.QF_USERS AU ON AU\.USER_ID = D\.ACTOR_ID ORDER BY D\.ACTOR_ID FETCH FIRST (\d+) ROWS ONLY$/.test(
        s,
      )
    ) {
      const take = Number(/FETCH FIRST (\d+) ROWS ONLY$/.exec(s)![1]);
      const ids = [...new Set(this.folderDeletions.map((x) => String(x.ACTOR_ID)))].sort();
      return ids.slice(0, take).map((id) => ({
        ACTOR_ID: id,
        ACTOR_NAME: this.users.get(id)?.DISPLAY_NAME ?? null,
      }));
    }
    const where = /\bWHERE (.*?)(?: ORDER BY |$)/.exec(s)?.[1] ?? '';
    const tests: ((x: Row) => boolean)[] = [];
    let rest = where;
    let i = 0;
    const take = () => {
      if (i >= params.length) throw new Error(`Too few parameters for: ${s}`);
      return params[i++];
    };
    const eat = (re: RegExp) => {
      const m = re.exec(rest);
      if (!m) return null;
      rest = rest.slice(m[0].length).replace(/^ AND /, '');
      return m;
    };
    const like = (pattern: unknown) => {
      const re = String(pattern).replace(/\\(.)|([%_])|([^\\%_]+)/g, (_, esc, wild, lit) =>
        esc !== undefined
          ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : wild === '%'
            ? '[\\s\\S]*'
            : wild === '_'
              ? '[\\s\\S]'
              : String(lit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      );
      const rx = new RegExp(`^${re}$`);
      return (v: unknown) => v !== null && v !== undefined && rx.test(String(v).toUpperCase());
    };
    if (eat(/^D\.FOLDER_ID = \?/)) {
      const id = take();
      tests.push((x) => x.FOLDER_ID === id);
    }
    const q = eat(
      /^\(UPPER\(D\.FOLDER_NAME\) LIKE \? ESCAPE '\\' OR UPPER\(OU\.DISPLAY_NAME\) LIKE \? ESCAPE '\\' OR UPPER\(OU\.USERNAME\) LIKE \? ESCAPE '\\'( OR D\.OWNER_ID = \?)?\)/,
    );
    if (q) {
      if (!/LEFT JOIN \w+\.QF_USERS OU ON OU\.USER_ID = D\.OWNER_ID/.test(s))
        throw new Error('Owner search without the owner join');
      const [a, b, c] = [like(take()), like(take()), like(take())];
      const id = q[1] ? take() : undefined;
      tests.push((x) => {
        const n = withNames(x);
        return (
          a(n.FOLDER_NAME) ||
          b(n.OWNER_NAME) ||
          c(n.OWNER_USERNAME) ||
          (id !== undefined && n.OWNER_ID === id)
        );
      });
    }
    if (eat(/^D\.ACTOR_ID = \?/)) {
      const id = take();
      tests.push((x) => x.ACTOR_ID === id);
    }
    if (eat(/^D\.DELETED_AT >= CAST\(\? AS TIMESTAMP\)/)) {
      const t = String(take());
      tests.push((x) => String(x.DELETED_AT) >= t);
    }
    if (eat(/^D\.DELETED_AT < CAST\(\? AS TIMESTAMP\)/)) {
      const t = String(take());
      tests.push((x) => String(x.DELETED_AT) < t);
    }
    if (
      eat(
        /^\(D\.DELETED_AT < CAST\(\? AS TIMESTAMP\) OR \(D\.DELETED_AT = CAST\(\? AS TIMESTAMP\) AND D\.DELETION_ID > \?\)\)/,
      )
    ) {
      const [t, t2, id] = [String(take()), String(take()), String(take())];
      if (t !== t2) throw new Error('Keyset timestamps differ');
      tests.push(
        (x) =>
          String(x.DELETED_AT) < t || (String(x.DELETED_AT) === t && String(x.DELETION_ID) > id),
      );
    }
    if (rest.trim()) throw new Error(`Unexpected QF_FOLDER_DELETIONS predicate: ${rest}`);
    if (i !== params.length) throw new Error(`Unused parameters for: ${s}`);
    const rows = this.folderDeletions.filter((x) => tests.every((t) => t(x)));
    if (/^SELECT COUNT\(\*\) AS N FROM /.test(s)) return [{ N: rows.length }];
    const page = /(?:OFFSET (\d+) ROWS )?FETCH FIRST (\d+) ROWS ONLY$/.exec(s);
    const skip = Number(page?.[1] ?? 0);
    const n = page ? Number(page[2]) : Infinity;
    return rows
      .sort(
        (a, b) =>
          String(b.DELETED_AT).localeCompare(String(a.DELETED_AT)) ||
          String(a.DELETION_ID).localeCompare(String(b.DELETION_ID)),
      )
      .slice(skip, skip + n)
      .map((x) => {
        const r = withNames(x);
        delete r.OWNER_USERNAME;
        return r;
      });
  }

  private withAuditNames(a: Row): Row {
    return {
      ...a,
      ACTOR_NAME: this.users.get(String(a.ACTOR_ID))?.DISPLAY_NAME ?? null,
      PRINCIPAL_NAME:
        a.PRINCIPAL_TYPE === 'USER'
          ? (this.users.get(String(a.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
          : null,
    };
  }

  private folderDeletionUpdate(s: string, params: P): number | undefined {
    if (
      /^INSERT INTO \w+\.QF_FOLDER_DELETIONS \(DELETION_ID, FOLDER_ID, FOLDER_NAME, OWNER_ID, ACTOR_ID, SHARE_COUNT, PLACED_COUNT, FILED_COUNT, REPORTS_ROLE, DELETED_AT\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, /.test(
        s,
      )
    ) {
      const [id, folderId, name, owner, actor, shares, placed, filed, role] = params;
      if (this.folderDeletions.some((x) => x.DELETION_ID === id))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      for (const n of [shares, placed, filed])
        if (typeof n !== 'number' || n < 0)
          throw new DbError('Check constraint QF_FDEL_CK_COUNTS violated.', '23513', -545);
      if (![null, 'VIEWER', 'EDITOR'].includes(role as string | null))
        throw new DbError('Check constraint QF_FDEL_CK_ROLE violated.', '23513', -545);
      if (name === null || folderId === null || owner === null || actor === null)
        throw new DbError('Null value not allowed.', '23502', -407);
      this.folderDeletions.push({
        DELETION_ID: id,
        FOLDER_ID: folderId,
        FOLDER_NAME: name,
        OWNER_ID: owner,
        ACTOR_ID: actor,
        SHARE_COUNT: shares,
        PLACED_COUNT: placed,
        FILED_COUNT: filed,
        REPORTS_ROLE: role,
        DELETED_AT: this.now(),
      });
      return 1;
    }
    return undefined;
  }

  addGroup(userId: string, group: string, source = 'LOCAL') {
    this.userGroups.set(`${userId}|${group}`, {
      USER_ID: userId,
      GROUP_NAME: group,
      SOURCE: source,
    });
  }

  /** Scheduled delivery recipients (users by e-mail, report recipient options) and history. */
  private deliveryQuery(s: string, params: P): Row[] | undefined {
    if (/FROM \w+\.QF_USERS WHERE IS_ACTIVE = 1 AND LOWER\(EMAIL\) IN \(/.test(s)) {
      return [...this.users.values()].filter(
        (u) =>
          u.IS_ACTIVE === 1 && u.EMAIL !== null && params.includes(String(u.EMAIL).toLowerCase()),
      );
    }
    if (
      /^SELECT U\.USER_ID, U\.DISPLAY_NAME, U\.EMAIL FROM \w+\.QF_USERS U WHERE U\.IS_ACTIVE = 1 AND U\.EMAIL IS NOT NULL AND \(U\.USER_ID = \? OR U\.USER_ID IN \(SELECT S\.PRINCIPAL_ID FROM \w+\.QF_REPORT_SHARES S WHERE S\.REPORT_ID = \? AND S\.PRINCIPAL_TYPE = 'USER' AND \(S\.EXPIRES_AT IS NULL OR S\.EXPIRES_AT > CAST\(\? AS TIMESTAMP\)\)\) OR U\.USER_ID IN \(SELECT G\.USER_ID FROM \w+\.QF_USER_GROUPS G JOIN \w+\.QF_REPORT_SHARES S ON S\.PRINCIPAL_TYPE = 'GROUP' AND S\.PRINCIPAL_ID = G\.GROUP_NAME WHERE S\.REPORT_ID = \? AND \(S\.EXPIRES_AT IS NULL OR S\.EXPIRES_AT > CAST\(\? AS TIMESTAMP\)\)\)\) ORDER BY U\.DISPLAY_NAME FETCH FIRST 500 ROWS ONLY$/.test(
        s,
      )
    ) {
      const [ownerId, rid, now] = params;
      const shares = this.shares.filter(
        (x) => x.REPORT_ID === rid && FakeMetadataDb.activeAt(x, now),
      );
      const groups = new Set(
        shares.filter((x) => x.PRINCIPAL_TYPE === 'GROUP').map((x) => x.PRINCIPAL_ID),
      );
      return [...this.users.values()]
        .filter(
          (u) =>
            u.IS_ACTIVE === 1 &&
            u.EMAIL !== null &&
            (u.USER_ID === ownerId ||
              shares.some((x) => x.PRINCIPAL_TYPE === 'USER' && x.PRINCIPAL_ID === u.USER_ID) ||
              [...this.userGroups.values()].some(
                (g) => g.USER_ID === u.USER_ID && groups.has(g.GROUP_NAME),
              )),
        )
        .sort((a, b) => String(a.DISPLAY_NAME).localeCompare(String(b.DISPLAY_NAME)))
        .map((u) => ({ USER_ID: u.USER_ID, DISPLAY_NAME: u.DISPLAY_NAME, EMAIL: u.EMAIL }));
    }
    if (
      /^SELECT D\.DELIVERY_ID, .* FROM \w+\.QF_SCHEDULE_DELIVERIES D LEFT JOIN \w+\.QF_USERS U ON U\.USER_ID = D\.REQUESTED_BY WHERE D\.SCHEDULE_ID = \? ORDER BY D\.STARTED_AT DESC, D\.DELIVERY_ID FETCH FIRST (\d+) ROWS ONLY$/.test(
        s,
      )
    ) {
      const n = Number(/FETCH FIRST (\d+) ROWS/.exec(s)![1]);
      return this.scheduleDeliveries
        .filter((d) => d.SCHEDULE_ID === params[0])
        .sort(
          (a, b) =>
            String(b.STARTED_AT).localeCompare(String(a.STARTED_AT)) ||
            String(a.DELIVERY_ID).localeCompare(String(b.DELIVERY_ID)),
        )
        .slice(0, n)
        .map((d) => ({
          ...d,
          REQUESTED_BY_NAME: d.REQUESTED_BY
            ? (this.users.get(String(d.REQUESTED_BY))?.DISPLAY_NAME ?? null)
            : null,
        }));
    }
    return undefined;
  }

  private withReportName(sc: Row): Row {
    const r = this.reports.get(String(sc.REPORT_ID));
    return {
      ...sc,
      REPORT_NAME: r?.REPORT_NAME ?? null,
      REPORT_NAME_KEY: r?.REPORT_NAME_KEY ?? null,
    };
  }

  /** In-app notifications (no migration for the list; 016 for the read state). */
  private inboxQuery(s: string, params: P): Row[] | undefined {
    const ts = (v: unknown) => Date.parse(String(v).trim().replace(' ', 'T').slice(0, 23) + 'Z');
    const missing016 = () => {
      if (!this.noticesReadColumn)
        throw new DbError('Column NOTICES_READ_AT not in specified tables.', '42703', -206);
    };
    if (/^SELECT NOTICES_READ_AT FROM \w+\.QF_USER_SETTINGS WHERE USER_ID = \?$/.test(s)) {
      missing016();
      const r = this.userSettings.get(String(params[0]));
      return r ? [{ NOTICES_READ_AT: r.NOTICES_READ_AT ?? null }] : [];
    }
    /** Principal values after `skip` leading ones: the user ID then any group names. */
    const principals = (sql: string, from: number) => {
      const g = /PRINCIPAL_TYPE = 'GROUP' AND \w\.PRINCIPAL_ID IN \(([?, ]+)\)/.exec(sql);
      const n = g ? (g[1].match(/\?/g) ?? []).length : 0;
      return {
        uid: params[from],
        groups: params.slice(from + 1, from + 1 + n),
        next: from + 1 + n,
      };
    };
    const audit =
      /^SELECT A\.AUDIT_ID, A\.(REPORT_ID|FOLDER_ID) AS TARGET_ID, .* FROM \w+\.(QF_SHARE_AUDIT|QF_FOLDER_SHARE_AUDIT) A JOIN \w+\.(QF_REPORTS|QF_FOLDERS) O ON .* WHERE A\.ACTION IN \('GRANT', 'CHANGE'\) AND A\.ACTOR_ID <> \? AND O\.OWNER_ID <> \? AND A\.OCCURRED_AT > CAST\(\? AS TIMESTAMP\)( AND A\.OCCURRED_AT < CAST\(\? AS TIMESTAMP\))? AND \(\(A\.PRINCIPAL_TYPE = 'USER' AND A\.PRINCIPAL_ID = \?\)( OR \(A\.PRINCIPAL_TYPE = 'GROUP' AND A\.PRINCIPAL_ID IN \([?, ]+\)\))?\) AND EXISTS \(SELECT 1 FROM \w+\.(QF_REPORT_SHARES|QF_FOLDER_SHARES) S WHERE .* AND \(S\.EXPIRES_AT IS NULL OR S\.EXPIRES_AT > CAST\(\? AS TIMESTAMP\)\)\) ORDER BY A\.OCCURRED_AT DESC, A\.AUDIT_ID DESC FETCH FIRST (\d+) ROWS ONLY$/.exec(
        s,
      );
    if (audit) {
      const report = audit[1] === 'REPORT_ID';
      const [actor, notOwner, from] = params;
      let i = 3;
      const to = audit[4] ? params[i++] : null;
      const pr = principals(s, i);
      const now = params[pr.next];
      const rows = report ? this.shareAudit : this.folderShareAudit;
      const shares = report ? this.shares : this.folderShares;
      const key = report ? 'REPORT_ID' : 'FOLDER_ID';
      return rows
        .filter((a) => {
          const o = (report ? this.reports : this.folders).get(String(a[key]));
          return (
            o &&
            (a.ACTION === 'GRANT' || a.ACTION === 'CHANGE') &&
            a.ACTOR_ID !== actor &&
            o.OWNER_ID !== notOwner &&
            ts(a.OCCURRED_AT) > ts(from) &&
            (to === null || ts(a.OCCURRED_AT) < ts(to)) &&
            this.matchesPrincipal(a, pr.uid, pr.groups) &&
            shares.some(
              (x) =>
                x[key] === a[key] &&
                x.PRINCIPAL_TYPE === a.PRINCIPAL_TYPE &&
                x.PRINCIPAL_ID === a.PRINCIPAL_ID &&
                FakeMetadataDb.activeAt(x, now),
            )
          );
        })
        .sort(
          (a, b) =>
            ts(b.OCCURRED_AT) - ts(a.OCCURRED_AT) ||
            String(b.AUDIT_ID).localeCompare(String(a.AUDIT_ID)),
        )
        .slice(0, Number(audit[7]))
        .map((a) => {
          const o = (report ? this.reports : this.folders).get(String(a[key]))!;
          return {
            AUDIT_ID: a.AUDIT_ID,
            TARGET_ID: a[key],
            ACTION: a.ACTION,
            PRINCIPAL_TYPE: a.PRINCIPAL_TYPE,
            PRINCIPAL_ID: a.PRINCIPAL_ID,
            OLD_ROLE: a.OLD_ROLE ?? null,
            NEW_ROLE: a.NEW_ROLE ?? null,
            NEW_EXPIRES_AT: a.NEW_EXPIRES_AT ?? null,
            OCCURRED_AT: a.OCCURRED_AT,
            TARGET_NAME: report ? o.REPORT_NAME : o.FOLDER_NAME,
            ACTOR_NAME: this.users.get(String(a.ACTOR_ID))?.DISPLAY_NAME ?? null,
          };
        });
    }
    const exp =
      /^SELECT S\.(REPORT_ID|FOLDER_ID) AS TARGET_ID, S\.PRINCIPAL_TYPE, S\.PRINCIPAL_ID, S\.SHARE_ROLE, S\.EXPIRES_AT, S\.CREATED_AT, O\.(?:REPORT_NAME|FOLDER_NAME) AS TARGET_NAME, O\.OWNER_ID, U\.DISPLAY_NAME AS PRINCIPAL_NAME FROM \w+\.(?:QF_REPORT_SHARES|QF_FOLDER_SHARES) S JOIN .* WHERE S\.EXPIRES_AT IS NOT NULL AND S\.EXPIRES_AT > CAST\(\? AS TIMESTAMP\) AND S\.EXPIRES_AT <= CAST\(\? AS TIMESTAMP\) AND \(O\.OWNER_ID = \? OR \(\(S\.PRINCIPAL_TYPE = 'USER' AND S\.PRINCIPAL_ID = \?\)( OR \(S\.PRINCIPAL_TYPE = 'GROUP' AND S\.PRINCIPAL_ID IN \([?, ]+\)\))?\)\) ORDER BY S\.EXPIRES_AT DESC FETCH FIRST (\d+) ROWS ONLY$/.exec(
        s,
      );
    if (exp) {
      const report = exp[1] === 'REPORT_ID';
      const [lo, hi, owner] = params;
      const pr = principals(s, 3);
      const key = report ? 'REPORT_ID' : 'FOLDER_ID';
      return (report ? this.shares : this.folderShares)
        .filter((x) => {
          const o = (report ? this.reports : this.folders).get(String(x[key]));
          return (
            o &&
            x.EXPIRES_AT !== null &&
            x.EXPIRES_AT !== undefined &&
            ts(x.EXPIRES_AT) > ts(lo) &&
            ts(x.EXPIRES_AT) <= ts(hi) &&
            (o.OWNER_ID === owner || this.matchesPrincipal(x, pr.uid, pr.groups))
          );
        })
        .sort((a, b) => ts(b.EXPIRES_AT) - ts(a.EXPIRES_AT))
        .slice(0, Number(exp[3]))
        .map((x) => {
          const o = (report ? this.reports : this.folders).get(String(x[key]))!;
          return {
            TARGET_ID: x[key],
            PRINCIPAL_TYPE: x.PRINCIPAL_TYPE,
            PRINCIPAL_ID: x.PRINCIPAL_ID,
            SHARE_ROLE: x.SHARE_ROLE,
            EXPIRES_AT: x.EXPIRES_AT,
            CREATED_AT: x.CREATED_AT ?? null,
            TARGET_NAME: report ? o.REPORT_NAME : o.FOLDER_NAME,
            OWNER_ID: o.OWNER_ID,
            PRINCIPAL_NAME:
              x.PRINCIPAL_TYPE === 'USER'
                ? (this.users.get(String(x.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
                : null,
          };
        });
    }
    const dlv =
      /^SELECT D\.DELIVERY_ID, D\.SCHEDULE_ID, D\.REPORT_ID, D\.FINISHED_AT, D\.RUN_TRIGGER, D\.ERROR_MESSAGE, R\.REPORT_NAME, R\.OWNER_ID FROM \w+\.QF_SCHEDULE_DELIVERIES D JOIN \w+\.QF_SCHEDULES S ON S\.SCHEDULE_ID = D\.SCHEDULE_ID JOIN \w+\.QF_REPORTS R ON R\.REPORT_ID = D\.REPORT_ID WHERE S\.CREATED_BY = \? AND D\.STATUS = 'FAILED' AND D\.FINISHED_AT > CAST\(\? AS TIMESTAMP\)( AND D\.FINISHED_AT < CAST\(\? AS TIMESTAMP\))? ORDER BY D\.FINISHED_AT DESC, D\.DELIVERY_ID DESC FETCH FIRST (\d+) ROWS ONLY$/.exec(
        s,
      );
    if (dlv) {
      const [by, from] = params;
      const to = dlv[1] ? params[2] : null;
      return this.scheduleDeliveries
        .filter((d) => {
          const sch = this.schedules.get(String(d.SCHEDULE_ID));
          return (
            sch &&
            this.reports.has(String(d.REPORT_ID)) &&
            sch.CREATED_BY === by &&
            d.STATUS === 'FAILED' &&
            ts(d.FINISHED_AT) > ts(from) &&
            (to === null || ts(d.FINISHED_AT) < ts(to))
          );
        })
        .sort(
          (a, b) =>
            ts(b.FINISHED_AT) - ts(a.FINISHED_AT) ||
            String(b.DELIVERY_ID).localeCompare(String(a.DELIVERY_ID)),
        )
        .slice(0, Number(dlv[2]))
        .map((d) => {
          const r = this.reports.get(String(d.REPORT_ID))!;
          return {
            DELIVERY_ID: d.DELIVERY_ID,
            SCHEDULE_ID: d.SCHEDULE_ID,
            REPORT_ID: d.REPORT_ID,
            FINISHED_AT: d.FINISHED_AT,
            RUN_TRIGGER: d.RUN_TRIGGER,
            ERROR_MESSAGE: d.ERROR_MESSAGE ?? null,
            REPORT_NAME: r.REPORT_NAME,
            OWNER_ID: r.OWNER_ID,
          };
        });
    }
    return undefined;
  }

  private inboxUpdate(s: string, params: P): number | undefined {
    const missing016 = () => {
      if (!this.noticesReadColumn)
        throw new DbError('Column NOTICES_READ_AT not in specified tables.', '42703', -206);
    };
    if (
      /^UPDATE \w+\.QF_USER_SETTINGS SET NOTICES_READ_AT = CAST\(\? AS TIMESTAMP\), UPDATED_AT = .* WHERE USER_ID = \?$/.test(
        s,
      )
    ) {
      missing016();
      const r = this.userSettings.get(String(params[1]));
      if (!r) return 0;
      Object.assign(r, { NOTICES_READ_AT: params[0], UPDATED_AT: this.now() });
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_USER_SETTINGS \(USER_ID, SHARE_EMAILS, NOTICES_READ_AT, UPDATED_AT\) VALUES \(\?, 1, CAST\(\? AS TIMESTAMP\), /.test(
        s,
      )
    ) {
      missing016();
      const [uid, at] = params;
      if (this.userSettings.has(String(uid)))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      if (!this.users.has(String(uid))) throw new DbError('Foreign key violation.', '23503', -530);
      this.userSettings.set(String(uid), {
        USER_ID: uid,
        SHARE_EMAILS: 1,
        NOTICES_READ_AT: at,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    return undefined;
  }

  /** Share notifications and per-user settings (migration 015). */
  private notificationQuery(s: string, params: P): Row[] | undefined {
    const ts = (v: unknown) => Date.parse(String(v).trim().replace(' ', 'T').slice(0, 23) + 'Z');
    const optedIn = (uid: unknown) => this.userSettings.get(String(uid))?.SHARE_EMAILS !== 0;
    if (/^SELECT SHARE_EMAILS FROM \w+\.QF_USER_SETTINGS WHERE USER_ID = \?$/.test(s)) {
      const r = this.userSettings.get(String(params[0]));
      return r ? [{ SHARE_EMAILS: r.SHARE_EMAILS }] : [];
    }
    if (/^SELECT DISPLAY_NAME FROM \w+\.QF_USERS WHERE USER_ID = \?$/.test(s)) {
      const u = this.users.get(String(params[0]));
      return u ? [{ DISPLAY_NAME: u.DISPLAY_NAME }] : [];
    }
    if (
      /^SELECT U\.USER_ID, U\.DISPLAY_NAME, U\.EMAIL FROM \w+\.QF_USERS U WHERE U\.IS_ACTIVE = 1 AND U\.EMAIL IS NOT NULL AND U\.USER_ID IN \([?, ]+\) AND NOT EXISTS \(SELECT 1 FROM \w+\.QF_USER_SETTINGS X WHERE X\.USER_ID = U\.USER_ID AND X\.SHARE_EMAILS = 0\)$/.test(
        s,
      )
    )
      return [...this.users.values()]
        .filter(
          (u) =>
            u.IS_ACTIVE === 1 &&
            u.EMAIL !== null &&
            params.includes(u.USER_ID as string) &&
            optedIn(u.USER_ID),
        )
        .map((u) => ({ USER_ID: u.USER_ID, DISPLAY_NAME: u.DISPLAY_NAME, EMAIL: u.EMAIL }));
    if (
      /^SELECT G\.GROUP_NAME, U\.USER_ID, U\.DISPLAY_NAME, U\.EMAIL FROM \w+\.QF_USER_GROUPS G JOIN \w+\.QF_USERS U ON U\.USER_ID = G\.USER_ID WHERE G\.GROUP_NAME IN \([?, ]+\) AND U\.IS_ACTIVE = 1 AND U\.EMAIL IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM \w+\.QF_USER_SETTINGS X WHERE X\.USER_ID = U\.USER_ID AND X\.SHARE_EMAILS = 0\) ORDER BY G\.GROUP_NAME, U\.USER_ID FETCH FIRST (\d+) ROWS ONLY$/.test(
        s,
      )
    ) {
      const n = Number(/FETCH FIRST (\d+) ROWS/.exec(s)![1]);
      const out: Row[] = [];
      for (const g of [...this.userGroups.values()].sort(
        (a, b) =>
          String(a.GROUP_NAME).localeCompare(String(b.GROUP_NAME)) ||
          String(a.USER_ID).localeCompare(String(b.USER_ID)),
      )) {
        const u = this.users.get(String(g.USER_ID));
        if (!params.includes(g.GROUP_NAME as string) || !u) continue;
        if (u.IS_ACTIVE !== 1 || u.EMAIL === null || !optedIn(u.USER_ID)) continue;
        out.push({
          GROUP_NAME: g.GROUP_NAME,
          USER_ID: u.USER_ID,
          DISPLAY_NAME: u.DISPLAY_NAME,
          EMAIL: u.EMAIL,
        });
      }
      return out.slice(0, n);
    }
    const due =
      /^SELECT S\.(REPORT_ID|FOLDER_ID) AS TARGET_ID, S\.PRINCIPAL_TYPE, S\.PRINCIPAL_ID, S\.SHARE_ROLE, S\.EXPIRES_AT, T\.(REPORT_NAME|FOLDER_NAME) AS TARGET_NAME, T\.OWNER_ID FROM \w+\.(QF_REPORT_SHARES|QF_FOLDER_SHARES) S JOIN \w+\.(QF_REPORTS|QF_FOLDERS) T ON T\.\1 = S\.\1 WHERE S\.EXPIRES_AT > CAST\(\? AS TIMESTAMP\) AND S\.EXPIRES_AT <= CAST\(\? AS TIMESTAMP\) AND NOT EXISTS \(SELECT 1 FROM \w+\.QF_SHARE_REMINDERS M WHERE M\.SHARE_KIND = '(REPORT|FOLDER)' AND M\.TARGET_ID = S\.\1 AND M\.PRINCIPAL_TYPE = S\.PRINCIPAL_TYPE AND M\.PRINCIPAL_ID = S\.PRINCIPAL_ID AND M\.EXPIRES_AT = S\.EXPIRES_AT AND \(M\.STATUS <> 'FAILED' OR M\.ATTEMPTS >= (\d+)\)\) ORDER BY S\.EXPIRES_AT FETCH FIRST (\d+) ROWS ONLY$/.exec(
        s,
      );
    if (due) {
      const [, key, nameCol, , , kind, maxAttempts, limit] = due;
      const [from, until] = params.map(ts);
      const rows = kind === 'REPORT' ? this.shares : this.folderShares;
      const targets: Map<string, Row> = kind === 'REPORT' ? this.reports : this.folders;
      return rows
        .filter((x) => x.EXPIRES_AT !== null && x.EXPIRES_AT !== undefined)
        .filter((x) => ts(x.EXPIRES_AT) > from && ts(x.EXPIRES_AT) <= until)
        .filter((x) => targets.has(String(x[key])))
        .filter(
          (x) =>
            !this.shareReminders.some(
              (m) =>
                m.SHARE_KIND === kind &&
                m.TARGET_ID === x[key] &&
                m.PRINCIPAL_TYPE === x.PRINCIPAL_TYPE &&
                m.PRINCIPAL_ID === x.PRINCIPAL_ID &&
                ts(m.EXPIRES_AT) === ts(x.EXPIRES_AT) &&
                (m.STATUS !== 'FAILED' || Number(m.ATTEMPTS) >= Number(maxAttempts)),
            ),
        )
        .sort((a, b) => ts(a.EXPIRES_AT) - ts(b.EXPIRES_AT))
        .slice(0, Number(limit))
        .map((x) => {
          const t = targets.get(String(x[key]))!;
          return {
            TARGET_ID: x[key],
            PRINCIPAL_TYPE: x.PRINCIPAL_TYPE,
            PRINCIPAL_ID: x.PRINCIPAL_ID,
            SHARE_ROLE: x.SHARE_ROLE,
            EXPIRES_AT: x.EXPIRES_AT,
            TARGET_NAME: t[nameCol],
            OWNER_ID: t.OWNER_ID,
          };
        });
    }
    return undefined;
  }

  private notificationUpdate(s: string, params: P): number | undefined {
    const ts = (v: unknown) => Date.parse(String(v).trim().replace(' ', 'T').slice(0, 23) + 'Z');
    if (
      /^UPDATE \w+\.QF_USER_SETTINGS SET SHARE_EMAILS = \?, UPDATED_AT = .* WHERE USER_ID = \?$/.test(
        s,
      )
    ) {
      const r = this.userSettings.get(String(params[1]));
      if (!r) return 0;
      Object.assign(r, { SHARE_EMAILS: params[0], UPDATED_AT: this.now() });
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_USER_SETTINGS \(USER_ID, SHARE_EMAILS, UPDATED_AT\) VALUES \(\?, \?, /.test(
        s,
      )
    ) {
      const [uid, v] = params;
      if (this.userSettings.has(String(uid)))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      if (!this.users.has(String(uid))) throw new DbError('Foreign key violation.', '23503', -530);
      if (v !== 0 && v !== 1) throw new DbError('Check constraint.', '23513', -545);
      this.userSettings.set(String(uid), { USER_ID: uid, SHARE_EMAILS: v, UPDATED_AT: this.now() });
      return 1;
    }
    const same = (m: Row, k: P) =>
      m.SHARE_KIND === k[0] &&
      m.TARGET_ID === k[1] &&
      m.PRINCIPAL_TYPE === k[2] &&
      m.PRINCIPAL_ID === k[3] &&
      ts(m.EXPIRES_AT) === ts(k[4]);
    if (
      /^INSERT INTO \w+\.QF_SHARE_REMINDERS \(REMINDER_ID, SHARE_KIND, TARGET_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, EXPIRES_AT, STATUS, ATTEMPTS, RECIPIENT_COUNT, CLAIMED_BY, CREATED_AT, UPDATED_AT\) VALUES \(\?, \?, \?, \?, \?, \?, 'CLAIMED', 1, 0, \?, /.test(
        s,
      )
    ) {
      const [id, ...rest] = params;
      const k = rest.slice(0, 5);
      if (this.shareReminders.some((m) => same(m, k)))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      this.shareReminders.push({
        REMINDER_ID: id,
        SHARE_KIND: k[0],
        TARGET_ID: k[1],
        PRINCIPAL_TYPE: k[2],
        PRINCIPAL_ID: k[3],
        EXPIRES_AT: k[4],
        STATUS: 'CLAIMED',
        ATTEMPTS: 1,
        RECIPIENT_COUNT: 0,
        CLAIMED_BY: rest[5],
        LAST_ERROR: null,
        CREATED_AT: this.now(),
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    const retry =
      /^UPDATE \w+\.QF_SHARE_REMINDERS SET STATUS = 'CLAIMED', ATTEMPTS = ATTEMPTS \+ 1, CLAIMED_BY = \?, UPDATED_AT = .* WHERE SHARE_KIND = \? AND TARGET_ID = \? AND PRINCIPAL_TYPE = \? AND PRINCIPAL_ID = \? AND EXPIRES_AT = \? AND STATUS = 'FAILED' AND ATTEMPTS < (\d+)$/.exec(
        s,
      );
    if (retry) {
      const [by, ...k] = params;
      const m = this.shareReminders.find(
        (x) => same(x, k) && x.STATUS === 'FAILED' && Number(x.ATTEMPTS) < Number(retry[1]),
      );
      if (!m) return 0;
      Object.assign(m, {
        STATUS: 'CLAIMED',
        ATTEMPTS: Number(m.ATTEMPTS) + 1,
        CLAIMED_BY: by,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_SHARE_REMINDERS SET STATUS = \?, RECIPIENT_COUNT = \?, LAST_ERROR = \?, UPDATED_AT = .* WHERE SHARE_KIND = \? AND TARGET_ID = \? AND PRINCIPAL_TYPE = \? AND PRINCIPAL_ID = \? AND EXPIRES_AT = \? AND CLAIMED_BY = \?$/.test(
        s,
      )
    ) {
      const [status, count, err, ...rest] = params;
      const k = rest.slice(0, 5);
      const m = this.shareReminders.find((x) => same(x, k) && x.CLAIMED_BY === rest[5]);
      if (!m) return 0;
      if (!['CLAIMED', 'SENT', 'SKIPPED', 'FAILED'].includes(String(status)))
        throw new DbError('Check constraint.', '23513', -545);
      Object.assign(m, {
        STATUS: status,
        RECIPIENT_COUNT: count,
        LAST_ERROR: err,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    return undefined;
  }

  // ---- History retention (no migration): batched DELETEs on the history and audit tables ----

  /** Every table retention may delete from, by name: its rows and how to remove one. */
  private retentionTables(): Record<string, { rows: () => Row[]; remove: (r: Row) => void }> {
    // Removed in place, so tests holding a reference to an array see the change.
    const list = (rows: Row[]) => ({
      rows: () => rows,
      remove: (r: Row) => {
        const i = rows.indexOf(r);
        if (i >= 0) rows.splice(i, 1);
      },
    });
    return {
      QF_SCHEDULE_DELIVERIES: list(this.scheduleDeliveries),
      QF_SHARE_REMINDERS: list(this.shareReminders),
      QF_SHARE_AUDIT: list(this.shareAudit),
      QF_FOLDER_SHARE_AUDIT: list(this.folderShareAudit),
      QF_FOLDER_DELETIONS: list(this.folderDeletions),
      QF_EXECUTIONS: {
        rows: () => [...this.executions.values()],
        remove: (r: Row) => this.executions.delete(String(r.EXECUTION_ID)),
      },
    };
  }

  /** A stored timestamp (Db2 text, ISO or Date) as epoch milliseconds. */
  static tsMs(v: unknown): number {
    if (v instanceof Date) return v.getTime();
    const t = String(v)
      .trim()
      .replace(' ', 'T')
      .replace(/(\.\d{3})\d*/, '$1');
    return Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(t) ? t : `${t}Z`);
  }

  private retentionMatches(rows: Row[], col: string, cutoff: unknown, notRunning: boolean) {
    const c = FakeMetadataDb.tsMs(cutoff);
    if (Number.isNaN(c)) throw new Error(`FakeMetadataDb: bad retention cutoff ${String(cutoff)}`);
    return rows.filter((r) => {
      const t = FakeMetadataDb.tsMs(r[col]);
      return !Number.isNaN(t) && t < c && (!notRunning || r.STATUS !== 'RUNNING');
    });
  }

  /** Retention DELETEs seen, per table (tests check the batching). */
  retentionDeletes: { table: string; deleted: number }[] = [];

  private retentionUpdate(s: string, params: P): number | undefined {
    const m =
      /^DELETE FROM \w+\.(QF_[A-Z_]+) WHERE ([A-Z_]+) IN \(SELECT \2 FROM \w+\.\1 WHERE ([A-Z_]+) < CAST\(\? AS TIMESTAMP\)( AND STATUS <> 'RUNNING')? FETCH FIRST (\d+) ROWS ONLY\)$/.exec(
        s,
      );
    if (!m) return undefined;
    const [, table, , col, notRunning, n] = m;
    const t = this.retentionTables()[table];
    if (!t) throw new Error(`FakeMetadataDb: retention may not delete from ${table}`);
    const doomed = [...this.retentionMatches(t.rows(), col, params[0], !!notRunning)].slice(
      0,
      Number(n),
    );
    for (const r of doomed) t.remove(r);
    this.retentionDeletes.push({ table, deleted: doomed.length });
    return doomed.length;
  }

  private retentionQuery(s: string, params: P): Row[] | undefined {
    const m =
      /^SELECT COUNT\(\*\) AS N FROM \w+\.(QF_[A-Z_]+) WHERE ([A-Z_]+) < CAST\(\? AS TIMESTAMP\)( AND STATUS <> 'RUNNING')?$/.exec(
        s,
      );
    if (!m) return undefined;
    const t = this.retentionTables()[m[1]];
    if (!t) throw new Error(`FakeMetadataDb: no retention table ${m[1]}`);
    return [{ N: this.retentionMatches(t.rows(), m[2], params[0], !!m[3]).length }];
  }

  async query<T>(sql: string, params: P = []): Promise<T[]> {
    this.record(sql, params);
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('SELECT 1 AS OK')) return [{ OK: 1 }] as T[];
    const inboxRows = this.inboxQuery(s, params);
    if (inboxRows) return inboxRows as T[];
    const retentionRows = this.retentionQuery(s, params);
    if (retentionRows) return retentionRows as T[];
    const notificationRows = this.notificationQuery(s, params);
    if (notificationRows) return notificationRows as T[];
    const deletionRows = this.folderDeletionQuery(s, params);
    if (deletionRows) return deletionRows as T[];
    const folderRows = this.folderQuery(s, params);
    if (folderRows) return folderRows as T[];
    const deliveryRows = this.deliveryQuery(s, params);
    if (deliveryRows) return deliveryRows as T[];
    if (/FROM \w+\.QF_USERS WHERE USERNAME = \?/.test(s)) {
      const u = [...this.users.values()].find((x) => x.USERNAME === params[0]);
      return (u ? [u] : []) as T[];
    }
    if (/FROM \w+\.QF_USERS WHERE USER_ID = \? AND IS_ACTIVE = 1/.test(s)) {
      const u = this.users.get(String(params[0]));
      return (u && u.IS_ACTIVE === 1 ? [u] : []) as T[];
    }
    if (/FROM \w+\.QF_USERS WHERE AUTH_SOURCE = \? AND EXTERNAL_ID = \?/.test(s)) {
      const u = [...this.users.values()].find(
        (x) => x.AUTH_SOURCE === params[0] && x.EXTERNAL_ID === params[1],
      );
      return (u ? [{ ...u }] : []) as T[];
    }
    if (/FROM \w+\.QF_USERS WHERE IS_ACTIVE = 1 AND \(UPPER\(USERNAME\) LIKE \?/.test(s)) {
      const pat = String(params[0]).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1');
      return [...this.users.values()]
        .filter(
          (u) =>
            u.IS_ACTIVE === 1 &&
            (String(u.USERNAME).toUpperCase().includes(pat) ||
              String(u.DISPLAY_NAME).toUpperCase().includes(pat)),
        )
        .sort((a, b) => String(a.USERNAME).localeCompare(String(b.USERNAME))) as T[];
    }
    if (
      /^SELECT GROUP_NAME FROM \w+\.QF_USER_GROUPS WHERE USER_ID = \? ORDER BY GROUP_NAME$/.test(s)
    ) {
      return [...this.userGroups.values()]
        .filter((g) => g.USER_ID === params[0])
        .map((g) => ({ GROUP_NAME: g.GROUP_NAME }))
        .sort((a, b) => String(a.GROUP_NAME).localeCompare(String(b.GROUP_NAME))) as T[];
    }
    if (/^SELECT DISTINCT GROUP_NAME FROM \w+\.QF_USER_GROUPS ORDER BY GROUP_NAME$/.test(s)) {
      return [...new Set([...this.userGroups.values()].map((g) => String(g.GROUP_NAME)))]
        .sort()
        .map((g) => ({ GROUP_NAME: g })) as T[];
    }
    if (
      /^SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT FROM \w+\.QF_REPORT_SHARES WHERE REPORT_ID = \?$/.test(
        s,
      )
    ) {
      return this.shares.filter((x) => x.REPORT_ID === params[0]).map((x) => ({ ...x })) as T[];
    }
    if (
      /FROM \w+\.QF_REPORT_SHARES S LEFT JOIN \w+\.QF_USERS U .* WHERE S\.REPORT_ID = \?/.test(s)
    ) {
      return this.shares
        .filter((x) => x.REPORT_ID === params[0])
        .map((x): Row => ({
          ...x,
          DISPLAY_NAME:
            x.PRINCIPAL_TYPE === 'USER'
              ? (this.users.get(String(x.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
              : null,
        }))
        .sort((a, b) =>
          `${a.PRINCIPAL_TYPE}${a.PRINCIPAL_ID}`.localeCompare(
            `${b.PRINCIPAL_TYPE}${b.PRINCIPAL_ID}`,
          ),
        ) as T[];
    }
    if (
      /FROM \w+\.QF_SHARE_AUDIT A .* WHERE A\.REPORT_ID = \? ORDER BY A\.OCCURRED_AT DESC/.test(s)
    ) {
      const n = Number(/FETCH FIRST (\d+) ROWS ONLY/.exec(s)?.[1] ?? 100);
      return this.shareAudit
        .filter((x) => x.REPORT_ID === params[0])
        .map((x, i) => ({ x, i }))
        .sort((a, b) => b.i - a.i)
        .slice(0, n)
        .map(({ x }) => ({
          ...x,
          ACTOR_NAME: this.users.get(String(x.ACTOR_ID))?.DISPLAY_NAME ?? null,
          PRINCIPAL_NAME:
            x.PRINCIPAL_TYPE === 'USER'
              ? (this.users.get(String(x.PRINCIPAL_ID))?.DISPLAY_NAME ?? null)
              : null,
        })) as T[];
    }
    if (
      /FROM \w+\.QF_REPORTS R JOIN \w+\.QF_REPORT_SHARES S .* WHERE R\.OWNER_ID <> \? AND/.test(s)
    ) {
      const [notOwner, uid, ...groups] = params;
      const out: Row[] = [];
      for (const sh of this.shares) {
        const r = this.reports.get(String(sh.REPORT_ID));
        if (!r || r.OWNER_ID === notOwner) continue;
        const match =
          (sh.PRINCIPAL_TYPE === 'USER' && sh.PRINCIPAL_ID === uid) ||
          (sh.PRINCIPAL_TYPE === 'GROUP' && groups.includes(sh.PRINCIPAL_ID as string));
        if (!match) continue;
        out.push({
          ...r,
          SHARE_ROLE: sh.SHARE_ROLE,
          EXPIRES_AT: sh.EXPIRES_AT ?? null,
          OWNER_NAME: this.users.get(String(r.OWNER_ID))?.DISPLAY_NAME,
        });
      }
      return out.sort((a, b) =>
        String(a.REPORT_NAME_KEY).localeCompare(String(b.REPORT_NAME_KEY)),
      ) as T[];
    }
    if (/FROM \w+\.QF_REPORTS R JOIN \w+\.QF_USERS U ON U.USER_ID = R.OWNER_ID/.test(s)) {
      return [...this.reports.values()].map((r) => ({
        ...r,
        OWNER_NAME: this.users.get(String(r.OWNER_ID))?.DISPLAY_NAME,
      })) as T[];
    }
    if (
      /FROM \w+\.QF_SCHEDULES S JOIN \w+\.QF_REPORTS R ON R\.REPORT_ID = S\.REPORT_ID(?: WHERE| ORDER|$)/.test(
        s,
      )
    ) {
      let rows = [...this.schedules.values()].map((x) => this.withReportName(x));
      if (s.includes('WHERE S.SCHEDULE_ID = ?'))
        rows = rows.filter((x) => x.SCHEDULE_ID === params[0]);
      else if (s.includes('WHERE S.REPORT_ID = ?'))
        rows = rows.filter((x) => x.REPORT_ID === params[0]);
      else if (s.includes('WHERE R.OWNER_ID = ? OR (S.CREATED_BY = ? AND R.OWNER_ID = ?)'))
        rows = rows.filter((x) => {
          const r = this.reports.get(String(x.REPORT_ID));
          if (!r) return false;
          if (r.OWNER_ID === params[0]) return true;
          if (x.CREATED_BY === params[1] && r.OWNER_ID === params[2]) return true;
          // ... EXISTS (... AND (X.EXPIRES_AT IS NULL OR X.EXPIRES_AT > CAST(? AS TIMESTAMP)) AND ...)
          if (!s.includes('(X.EXPIRES_AT IS NULL OR X.EXPIRES_AT > CAST(? AS TIMESTAMP))'))
            throw new Error('listForUser must test share expiry (migration 014)');
          const now = params[3];
          const userId = params[4];
          const viaFolders = /OR R\.REPORT_ID IN \(([?, ]+)\)/.exec(s);
          const nIds = viaFolders ? (viaFolders[1].match(/\?/g) ?? []).length : 0;
          const groups = params.slice(5, params.length - nIds);
          if (nIds && params.slice(params.length - nIds).includes(r.REPORT_ID as string))
            return true;
          return this.shares.some(
            (sh) =>
              sh.REPORT_ID === r.REPORT_ID &&
              FakeMetadataDb.activeAt(sh, now) &&
              ((sh.PRINCIPAL_TYPE === 'USER' && sh.PRINCIPAL_ID === userId) ||
                (sh.PRINCIPAL_TYPE === 'GROUP' && groups.includes(sh.PRINCIPAL_ID as string))),
          );
        });
      else if (s.includes('WHERE R.OWNER_ID = ? OR S.CREATED_BY = ?'))
        rows = rows.filter(
          (x) =>
            this.reports.get(String(x.REPORT_ID))?.OWNER_ID === params[0] ||
            x.CREATED_BY === params[1],
        );
      else if (s.includes('WHERE S.IS_ENABLED = 1 AND S.NEXT_RUN_AT <= ?'))
        rows = rows
          .filter(
            (x) =>
              x.IS_ENABLED === 1 &&
              x.NEXT_RUN_AT !== null &&
              String(x.NEXT_RUN_AT) <= String(params[0]),
          )
          .sort((a, b) => String(a.NEXT_RUN_AT).localeCompare(String(b.NEXT_RUN_AT)));
      else if (/ ORDER BY R\.REPORT_NAME_KEY, S\.CREATED_AT$/.test(s) && !s.includes(' WHERE '))
        // admins: every schedule
        rows = rows.sort(
          (a, b) =>
            String(a.REPORT_NAME_KEY).localeCompare(String(b.REPORT_NAME_KEY)) ||
            String(a.CREATED_AT).localeCompare(String(b.CREATED_AT)),
        );
      else throw new Error(`FakeMetadataDb: unsupported schedule query ${s}`);
      return rows as T[];
    }
    if (/FROM \w+\.QF_REPORTS WHERE REPORT_ID = \?$/.test(s)) {
      const r = this.reports.get(String(params[0]));
      return (r ? [{ ...r }] : []) as T[];
    }
    if (/FROM \w+\.QF_REPORTS WHERE REPORT_ID = \? AND OWNER_ID = \?/.test(s)) {
      const r = this.reports.get(String(params[0]));
      return (r && r.OWNER_ID === params[1] ? [{ ...r }] : []) as T[];
    }
    if (/FROM \w+\.QF_REPORTS WHERE OWNER_ID = \?/.test(s)) {
      let rows = [...this.reports.values()].filter((r) => r.OWNER_ID === params[0]);
      let i = 1;
      if (s.includes('REPORT_NAME_KEY LIKE ?')) {
        const pat = String(params[i++]).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1');
        rows = rows.filter((r) => String(r.REPORT_NAME_KEY).includes(pat));
      }
      if (s.includes('CATEGORY = ?')) {
        const c = params[i++];
        rows = rows.filter((r) => r.CATEGORY === c);
      }
      if (s.includes('ORDER BY REPORT_NAME_KEY'))
        rows.sort((a, b) => String(a.REPORT_NAME_KEY).localeCompare(String(b.REPORT_NAME_KEY)));
      if (s.includes('ORDER BY CREATED_AT DESC'))
        rows.sort((a, b) => String(b.CREATED_AT).localeCompare(String(a.CREATED_AT)));
      if (s.includes('ORDER BY LAST_EXECUTED_AT DESC'))
        rows.sort((a, b) =>
          String(b.LAST_EXECUTED_AT ?? '').localeCompare(String(a.LAST_EXECUTED_AT ?? '')),
        );
      return rows.map((r) => ({ ...r })) as T[];
    }
    if (/FROM \w+\.QF_EXECUTIONS WHERE USER_ID = \?/.test(s)) {
      let rows = [...this.executions.values()].filter((r) => r.USER_ID === params[0]);
      if (s.includes('AND REPORT_ID = ?')) rows = rows.filter((r) => r.REPORT_ID === params[1]);
      return rows.sort((a, b) => String(b.STARTED_AT).localeCompare(String(a.STARTED_AT))) as T[];
    }
    if (
      /^SELECT FOLDER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM \w+\.QF_FOLDERS WHERE OWNER_ID = \? ORDER BY FOLDER_NAME_KEY$/.test(
        s,
      )
    ) {
      return [...this.folders.values()]
        .filter((f) => f.OWNER_ID === params[0])
        .sort((a, b) => String(a.FOLDER_NAME_KEY).localeCompare(String(b.FOLDER_NAME_KEY)))
        .map((f) => ({ ...f })) as T[];
    }
    if (
      /^SELECT FOLDER_ID, FOLDER_NAME, CREATED_AT, UPDATED_AT FROM \w+\.QF_FOLDERS WHERE FOLDER_ID = \? AND OWNER_ID = \?$/.test(
        s,
      )
    ) {
      const f = this.folders.get(String(params[0]));
      return (f && f.OWNER_ID === params[1] ? [{ ...f }] : []) as T[];
    }
    if (
      /^SELECT REPORT_ID, TILE_POS FROM \w+\.QF_TILE_ORDER WHERE USER_ID = \? ORDER BY TILE_POS$/.test(
        s,
      )
    ) {
      return [...this.tileOrder.values()]
        .filter((t) => t.USER_ID === params[0])
        .sort((a, b) => Number(a.TILE_POS) - Number(b.TILE_POS))
        .map((t) => ({ ...t })) as T[];
    }
    if (
      /^SELECT REPORT_ID, FOLDER_ID, IS_FAVORITE FROM \w+\.QF_REPORT_PREFS WHERE USER_ID = \?$/.test(
        s,
      )
    ) {
      return [...this.reportPrefs.values()]
        .filter((p) => p.USER_ID === params[0])
        .map((p) => ({ ...p })) as T[];
    }
    if (
      /^SELECT FOLDER_ID, IS_FAVORITE FROM \w+\.QF_REPORT_PREFS WHERE USER_ID = \? AND REPORT_ID = \?$/.test(
        s,
      )
    ) {
      const p = this.reportPrefs.get(`${params[0]}|${params[1]}`);
      return (p ? [{ ...p }] : []) as T[];
    }
    throw new Error(`FakeMetadataDb: unsupported query ${s}`);
  }

  async update(sql: string, params: P = []): Promise<number> {
    this.record(sql, params);
    const s = sql.replace(/\s+/g, ' ');
    const inboxN = this.inboxUpdate(s, params);
    if (inboxN !== undefined) return inboxN;
    const retentionN = this.retentionUpdate(s, params);
    if (retentionN !== undefined) return retentionN;
    const notificationN = this.notificationUpdate(s, params);
    if (notificationN !== undefined) return notificationN;
    const deletionN = this.folderDeletionUpdate(s, params);
    if (deletionN !== undefined) return deletionN;
    const folderN = this.folderUpdate(s, params);
    if (folderN !== undefined) return folderN;
    if (s.startsWith('INSERT INTO') && s.includes('.QF_REPORTS')) {
      const [id, owner, name, key, desc, cat, text, pjson, bdef, cdef] = params;
      if ([...this.reports.values()].some((r) => r.OWNER_ID === owner && r.REPORT_NAME_KEY === key))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      const now = this.now();
      this.reports.set(String(id), {
        REPORT_ID: id,
        OWNER_ID: owner,
        REPORT_NAME: name,
        REPORT_NAME_KEY: key,
        DESCRIPTION: desc,
        CATEGORY: cat,
        SQL_TEXT: text,
        PARAMETERS_JSON: pjson ?? null,
        BUILDER_DEF: bdef ?? null,
        CHART_DEF: cdef ?? null,
        VERSION: 1,
        CREATED_AT: now,
        UPDATED_AT: now,
        LAST_EXECUTED_AT: null,
        LAST_STATUS: 'NEVER',
        LAST_ROW_COUNT: null,
        LAST_DURATION_MS: null,
      });
      return 1;
    }
    if (s.startsWith('UPDATE') && s.includes('.QF_REPORTS SET REPORT_NAME = ?')) {
      const [name, key, desc, cat, text, pjson, bdef, id, owner, version] = params;
      const r = this.reports.get(String(id));
      if (!r || r.OWNER_ID !== owner || (version !== undefined && r.VERSION !== version)) return 0;
      if (
        [...this.reports.values()].some(
          (o) => o !== r && o.OWNER_ID === owner && o.REPORT_NAME_KEY === key,
        )
      )
        throw new DbError('Duplicate key value specified.', '23505', -803);
      Object.assign(r, {
        REPORT_NAME: name,
        REPORT_NAME_KEY: key,
        DESCRIPTION: desc,
        CATEGORY: cat,
        SQL_TEXT: text,
        PARAMETERS_JSON: pjson,
        BUILDER_DEF: bdef ?? null,
        VERSION: Number(r.VERSION) + 1,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    if (s.includes('.QF_REPORTS SET CHART_DEF = ?')) {
      const [cdef, id, owner] = params;
      const r = this.reports.get(String(id));
      if (!r || r.OWNER_ID !== owner) return 0;
      Object.assign(r, { CHART_DEF: cdef ?? null, UPDATED_AT: this.now() });
      return 1;
    }
    if (s.includes(".QF_REPORTS SET LAST_STATUS = 'RUNNING'")) {
      const r = this.reports.get(String(params[0]));
      if (!r || r.OWNER_ID !== params[1]) return 0;
      r.LAST_STATUS = 'RUNNING';
      return 1;
    }
    if (s.includes('.QF_REPORTS SET LAST_EXECUTED_AT')) {
      const [status, rows, ms, id, owner] = params;
      const r = this.reports.get(String(id));
      if (!r || r.OWNER_ID !== owner) return 0;
      Object.assign(r, {
        LAST_EXECUTED_AT: this.now(),
        LAST_STATUS: status,
        LAST_ROW_COUNT: rows,
        LAST_DURATION_MS: ms,
      });
      return 1;
    }
    if (s.startsWith('DELETE FROM') && s.includes('.QF_REPORTS')) {
      const r = this.reports.get(String(params[0]));
      if (!r || r.OWNER_ID !== params[1]) return 0;
      this.reports.delete(String(params[0]));
      this.shares = this.shares.filter((x) => x.REPORT_ID !== params[0]); // ON DELETE CASCADE
      for (const [k, v] of this.schedules) if (v.REPORT_ID === params[0]) this.schedules.delete(k);
      this.scheduleDeliveries = this.scheduleDeliveries.filter((d) =>
        this.schedules.has(String(d.SCHEDULE_ID)),
      ); // ON DELETE CASCADE (through QF_SCHEDULES)
      for (const e of this.executions.values()) if (e.REPORT_ID === params[0]) e.REPORT_ID = null; // ON DELETE SET NULL
      for (const [k, v] of this.reportPrefs)
        if (v.REPORT_ID === params[0]) this.reportPrefs.delete(k); // ON DELETE CASCADE
      for (const [k, v] of this.tileOrder) if (v.REPORT_ID === params[0]) this.tileOrder.delete(k); // ON DELETE CASCADE
      for (const [k, v] of this.folderReports)
        if (v.REPORT_ID === params[0]) this.folderReports.delete(k); // ON DELETE CASCADE
      return 1;
    }
    if (s.startsWith('INSERT INTO') && s.includes('.QF_EXECUTIONS')) {
      const [id, reportId, userId, kind, hash, pjson, scheduleId] = params;
      this.executions.set(String(id), {
        EXECUTION_ID: id,
        REPORT_ID: reportId,
        USER_ID: userId,
        KIND: kind,
        STATUS: 'RUNNING',
        STARTED_AT: this.now(),
        TRUNCATED: 0,
        SQL_SHA256: hash,
        PARAMS_JSON: pjson ?? null,
        SCHEDULE_ID: scheduleId ?? null,
      });
      return 1;
    }
    if (s.startsWith('UPDATE') && s.includes('.QF_EXECUTIONS')) {
      const [status, ms, rows, trunc, state, code, msg, id, user] = params;
      const e = this.executions.get(String(id));
      if (!e || e.USER_ID !== user) return 0;
      Object.assign(e, {
        STATUS: status,
        ELAPSED_MS: ms,
        ROW_COUNT: rows,
        TRUNCATED: trunc,
        SQL_STATE: state,
        SQL_CODE: code,
        ERROR_MESSAGE: msg,
        COMPLETED_AT: this.now(),
      });
      return 1;
    }
    if (s.startsWith('UPDATE') && s.includes('.QF_USERS SET FAILED_LOGINS = FAILED_LOGINS + 1')) {
      const u = this.users.get(String(params[1]));
      if (!u) return 0;
      u.FAILED_LOGINS = Number(u.FAILED_LOGINS) + 1;
      if (Number(u.FAILED_LOGINS) >= Number(params[0]))
        u.LOCKED_UNTIL = '2999-01-01 00:00:00.000000';
      return 1;
    }
    if (s.startsWith('UPDATE') && s.includes('.QF_USERS SET FAILED_LOGINS = 0')) {
      const u = this.users.get(String(params[0]));
      if (!u) return 0;
      u.FAILED_LOGINS = 0;
      u.LOCKED_UNTIL = null;
      return 1;
    }
    // ---- users (external identities) ----
    if (
      s.startsWith('UPDATE') &&
      s.includes('.QF_USERS SET DISPLAY_NAME = ?, EMAIL = ?, ROLE = ?')
    ) {
      const [dn, email, role, id] = params;
      const u = this.users.get(String(id));
      if (!u) return 0;
      Object.assign(u, { DISPLAY_NAME: dn, EMAIL: email, ROLE: role });
      return 1;
    }
    if (
      s.startsWith('INSERT INTO') &&
      /\.QF_USERS \(USER_ID, USERNAME, DISPLAY_NAME, PASSWORD_HASH, ROLE, IS_ACTIVE, FAILED_LOGINS, AUTH_SOURCE, EXTERNAL_ID, EMAIL,/.test(
        s,
      )
    ) {
      const [id, username, dn, role, source, ext, email] = params;
      if ([...this.users.values()].some((u) => u.USERNAME === username))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      this.users.set(String(id), {
        USER_ID: id,
        USERNAME: username,
        DISPLAY_NAME: dn,
        PASSWORD_HASH: '!',
        ROLE: role,
        IS_ACTIVE: 1,
        FAILED_LOGINS: 0,
        LOCKED_UNTIL: null,
        AUTH_SOURCE: source,
        EXTERNAL_ID: ext,
        EMAIL: email,
      });
      return 1;
    }
    // ---- groups ----
    if (/^DELETE FROM \w+\.QF_USER_GROUPS WHERE USER_ID = \? AND SOURCE = \?$/.test(s)) {
      let n = 0;
      for (const [k, g] of this.userGroups)
        if (g.USER_ID === params[0] && g.SOURCE === params[1]) {
          this.userGroups.delete(k);
          n++;
        }
      return n;
    }
    if (/^INSERT INTO \w+\.QF_USER_GROUPS \(USER_ID, GROUP_NAME, SOURCE, CREATED_AT\)/.test(s)) {
      const [uid, g, source] = params;
      const k = `${uid}|${g}`;
      if (this.userGroups.has(k))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      this.userGroups.set(k, { USER_ID: uid, GROUP_NAME: g, SOURCE: source });
      return 1;
    }
    // ---- share audit ----
    if (
      /^INSERT INTO \w+\.QF_SHARE_AUDIT \(AUDIT_ID, REPORT_ID, ACTION, PRINCIPAL_TYPE, PRINCIPAL_ID, OLD_ROLE, NEW_ROLE, OLD_EXPIRES_AT, NEW_EXPIRES_AT, ACTOR_ID, OCCURRED_AT\)/.test(
        s,
      )
    ) {
      const [id, rid, action, type, pid, oldRole, newRole, oldExp, newExp, actor] = params;
      // QF_SAUD_CK_ACTION as widened by migration 014
      if (!['GRANT', 'CHANGE', 'REVOKE', 'EXPIRY'].includes(String(action)))
        throw new DbError('Check constraint violation.', '23513', -545);
      this.shareAudit.push({
        AUDIT_ID: id,
        REPORT_ID: rid,
        ACTION: action,
        PRINCIPAL_TYPE: type,
        PRINCIPAL_ID: pid,
        OLD_ROLE: oldRole,
        NEW_ROLE: newRole,
        OLD_EXPIRES_AT: oldExp,
        NEW_EXPIRES_AT: newExp,
        ACTOR_ID: actor,
        OCCURRED_AT: this.now(),
      });
      return 1;
    }
    // ---- shares ----
    if (/^DELETE FROM \w+\.QF_REPORT_SHARES WHERE REPORT_ID = \?$/.test(s)) {
      const before = this.shares.length;
      this.shares = this.shares.filter((x) => x.REPORT_ID !== params[0]);
      return before - this.shares.length;
    }
    if (
      /^INSERT INTO \w+\.QF_REPORT_SHARES \(REPORT_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, EXPIRES_AT, CREATED_BY, CREATED_AT\)/.test(
        s,
      )
    ) {
      const [rid, type, pid, role, expiresAt, by] = params;
      if (!this.reports.has(String(rid)))
        throw new DbError('Foreign key violation.', '23503', -530);
      this.shares.push({
        REPORT_ID: rid,
        PRINCIPAL_TYPE: type,
        PRINCIPAL_ID: pid,
        SHARE_ROLE: role,
        EXPIRES_AT: expiresAt,
        CREATED_BY: by,
      });
      return 1;
    }
    // ---- schedules ----
    if (
      /^INSERT INTO \w+\.QF_SCHEDULES \(SCHEDULE_ID, REPORT_ID, CREATED_BY, CRON_EXPR, TIMEZONE, RECIPIENTS, PARAMS_JSON, IS_ENABLED, NEXT_RUN_AT,/.test(
        s,
      )
    ) {
      const [id, rid, by, cron, tz, rcpt, pjson, enabled, next] = params;
      if (!this.reports.has(String(rid)))
        throw new DbError('Foreign key violation.', '23503', -530);
      const now = this.now();
      this.schedules.set(String(id), {
        SCHEDULE_ID: id,
        REPORT_ID: rid,
        CREATED_BY: by,
        CRON_EXPR: cron,
        TIMEZONE: tz,
        RECIPIENTS: rcpt,
        PARAMS_JSON: pjson,
        IS_ENABLED: enabled,
        NEXT_RUN_AT: next,
        LAST_RUN_AT: null,
        LAST_STATUS: 'NEVER',
        LAST_ERROR: null,
        FAILURE_COUNT: 0,
        VERSION: 1,
        CREATED_AT: now,
        UPDATED_AT: now,
      });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_SCHEDULES SET CRON_EXPR = \?, TIMEZONE = \?, RECIPIENTS = \?, PARAMS_JSON = \?, IS_ENABLED = \?, NEXT_RUN_AT = \?, FAILURE_COUNT = CASE WHEN IS_ENABLED = 0 THEN 0 ELSE FAILURE_COUNT END, VERSION = VERSION \+ 1, UPDATED_AT = .* WHERE SCHEDULE_ID = \?( AND VERSION = \?)?$/.test(
        s,
      )
    ) {
      const [cron, tz, rcpt, pjson, enabled, next, id, version] = params;
      const x = this.schedules.get(String(id));
      if (!x || (version !== undefined && x.VERSION !== version)) return 0;
      Object.assign(x, {
        CRON_EXPR: cron,
        TIMEZONE: tz,
        RECIPIENTS: rcpt,
        PARAMS_JSON: pjson,
        FAILURE_COUNT: x.IS_ENABLED === 0 ? 0 : x.FAILURE_COUNT,
        IS_ENABLED: enabled,
        NEXT_RUN_AT: next,
        VERSION: Number(x.VERSION) + 1,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    if (/^DELETE FROM \w+\.QF_SCHEDULES WHERE SCHEDULE_ID = \?$/.test(s)) {
      this.scheduleDeliveries = this.scheduleDeliveries.filter((d) => d.SCHEDULE_ID !== params[0]); // ON DELETE CASCADE
      return this.schedules.delete(String(params[0])) ? 1 : 0;
    }
    if (
      /^UPDATE \w+\.QF_SCHEDULES SET IS_ENABLED = \?, NEXT_RUN_AT = \?, FAILURE_COUNT = CASE WHEN \? = 1 THEN 0 ELSE FAILURE_COUNT END, VERSION = VERSION \+ 1, UPDATED_AT = .* WHERE SCHEDULE_ID = \?( AND VERSION = \?)?$/.test(
        s,
      )
    ) {
      const [enabled, next, reset, id, version] = params;
      const x = this.schedules.get(String(id));
      if (!x || (version !== undefined && x.VERSION !== version)) return 0;
      Object.assign(x, {
        IS_ENABLED: enabled,
        NEXT_RUN_AT: next,
        FAILURE_COUNT: reset === 1 ? 0 : x.FAILURE_COUNT,
        VERSION: Number(x.VERSION) + 1,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_SCHEDULE_DELIVERIES \(DELIVERY_ID, SCHEDULE_ID, REPORT_ID, RUN_TRIGGER, REQUESTED_BY, STARTED_AT, FINISHED_AT, STATUS, RESULT_ROWS, DELIVERED_TO, SKIPPED_TO, ERROR_MESSAGE\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)$/.test(
        s,
      )
    ) {
      const [id, sid, rid, trig, by, started, finished, status, rows, to, skipped, err] = params;
      if (!this.schedules.has(String(sid)))
        throw new DbError('Foreign key violation.', '23503', -530);
      if (
        !['SCHEDULE', 'MANUAL'].includes(String(trig)) ||
        !['SUCCEEDED', 'FAILED'].includes(String(status))
      )
        throw new DbError('Check constraint violation.', '23513', -545);
      this.scheduleDeliveries.push({
        DELIVERY_ID: id,
        SCHEDULE_ID: sid,
        REPORT_ID: rid,
        RUN_TRIGGER: trig,
        REQUESTED_BY: by,
        STARTED_AT: started,
        FINISHED_AT: finished,
        STATUS: status,
        RESULT_ROWS: rows,
        DELIVERED_TO: to,
        SKIPPED_TO: skipped,
        ERROR_MESSAGE: err,
      });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_SCHEDULES SET NEXT_RUN_AT = \?, LAST_RUN_AT = \?, LAST_STATUS = 'RUNNING' WHERE SCHEDULE_ID = \? AND IS_ENABLED = 1 AND NEXT_RUN_AT = \?$/.test(
        s,
      )
    ) {
      const [next, last, id, expected] = params;
      const x = this.schedules.get(String(id));
      if (!x || x.IS_ENABLED !== 1 || x.NEXT_RUN_AT !== expected) return 0;
      Object.assign(x, { NEXT_RUN_AT: next, LAST_RUN_AT: last, LAST_STATUS: 'RUNNING' });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_SCHEDULES SET LAST_STATUS = \?, LAST_ERROR = \?, FAILURE_COUNT = \?, IS_ENABLED = CASE WHEN \? = 1 THEN 0 ELSE IS_ENABLED END/.test(
        s,
      )
    ) {
      const [status, err, failures, disable, ranAt, id] = params;
      const x = this.schedules.get(String(id));
      if (!x) return 0;
      Object.assign(x, {
        LAST_STATUS: status,
        LAST_ERROR: err,
        FAILURE_COUNT: failures,
        IS_ENABLED: disable === 1 ? 0 : x.IS_ENABLED,
        LAST_RUN_AT: ranAt,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    // ---- scheduler lease ----
    if (
      /^UPDATE \w+\.QF_LOCKS SET HOLDER = \?, EXPIRES_AT = \? WHERE LOCK_NAME = \? AND \(HOLDER = \? OR EXPIRES_AT < \?\)$/.test(
        s,
      )
    ) {
      const [holder, until, name, same, now] = params;
      const l = this.locks.get(String(name));
      if (!l || !(l.HOLDER === same || String(l.EXPIRES_AT) < String(now))) return 0;
      Object.assign(l, { HOLDER: holder, EXPIRES_AT: until });
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_LOCKS \(LOCK_NAME, HOLDER, EXPIRES_AT\) VALUES \(\?, \?, \?\)$/.test(s)
    ) {
      const [name, holder, until] = params;
      if (this.locks.has(String(name)))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      this.locks.set(String(name), { LOCK_NAME: name, HOLDER: holder, EXPIRES_AT: until });
      return 1;
    }
    if (/^DELETE FROM \w+\.QF_LOCKS WHERE LOCK_NAME = \? AND HOLDER = \?$/.test(s)) {
      const l = this.locks.get(String(params[0]));
      if (!l || l.HOLDER !== params[1]) return 0;
      this.locks.delete(String(params[0]));
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_FOLDERS \(FOLDER_ID, OWNER_ID, FOLDER_NAME, FOLDER_NAME_KEY, CREATED_AT, UPDATED_AT\) VALUES \(\?, \?, \?, \?, /.test(
        s,
      )
    ) {
      const [id, owner, name, key] = params;
      if (!this.users.has(String(owner)))
        throw new DbError('Foreign key violation.', '23503', -530);
      if ([...this.folders.values()].some((f) => f.OWNER_ID === owner && f.FOLDER_NAME_KEY === key))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      const now = this.now();
      this.folders.set(String(id), {
        FOLDER_ID: id,
        OWNER_ID: owner,
        FOLDER_NAME: name,
        FOLDER_NAME_KEY: key,
        CREATED_AT: now,
        UPDATED_AT: now,
      });
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_FOLDERS SET FOLDER_NAME = \?, FOLDER_NAME_KEY = \?, UPDATED_AT = .* WHERE FOLDER_ID = \? AND OWNER_ID = \?$/.test(
        s,
      )
    ) {
      const [name, key, id, owner] = params;
      const f = this.folders.get(String(id));
      if (!f || f.OWNER_ID !== owner) return 0;
      if (
        [...this.folders.values()].some(
          (x) => x !== f && x.OWNER_ID === owner && x.FOLDER_NAME_KEY === key,
        )
      )
        throw new DbError('Duplicate key value specified.', '23505', -803);
      Object.assign(f, { FOLDER_NAME: name, FOLDER_NAME_KEY: key, UPDATED_AT: this.now() });
      return 1;
    }
    if (/^DELETE FROM \w+\.QF_FOLDERS WHERE FOLDER_ID = \? AND OWNER_ID = \?$/.test(s)) {
      const f = this.folders.get(String(params[0]));
      if (!f || f.OWNER_ID !== params[1]) return 0;
      this.folders.delete(String(params[0]));
      for (const p of this.reportPrefs.values()) if (p.FOLDER_ID === params[0]) p.FOLDER_ID = null; // ON DELETE SET NULL
      for (const [k, v] of this.folderReports)
        if (v.FOLDER_ID === params[0]) this.folderReports.delete(k); // ON DELETE CASCADE
      this.folderShares = this.folderShares.filter((x) => x.FOLDER_ID !== params[0]); // ON DELETE CASCADE
      this.folderReportSharing.delete(String(params[0])); // ON DELETE CASCADE (011)
      return 1;
    }
    if (
      /^UPDATE \w+\.QF_REPORT_PREFS SET FOLDER_ID = NULL, UPDATED_AT = .* WHERE USER_ID = \? AND FOLDER_ID = \?$/.test(
        s,
      )
    ) {
      let n = 0;
      for (const p of this.reportPrefs.values())
        if (p.USER_ID === params[0] && p.FOLDER_ID === params[1]) {
          p.FOLDER_ID = null;
          n++;
        }
      return n;
    }
    if (/^DELETE FROM \w+\.QF_REPORT_PREFS WHERE USER_ID = \? AND REPORT_ID = \?$/.test(s)) {
      return this.reportPrefs.delete(`${params[0]}|${params[1]}`) ? 1 : 0;
    }
    if (
      /^UPDATE \w+\.QF_REPORT_PREFS SET FOLDER_ID = \?, IS_FAVORITE = \?, UPDATED_AT = .* WHERE USER_ID = \? AND REPORT_ID = \?$/.test(
        s,
      )
    ) {
      const [folder, fav, userId, reportId] = params;
      const p = this.reportPrefs.get(`${userId}|${reportId}`);
      if (!p) return 0;
      this.checkPrefFks(userId, reportId, folder);
      Object.assign(p, { FOLDER_ID: folder, IS_FAVORITE: fav, UPDATED_AT: this.now() });
      return 1;
    }
    if (
      /^INSERT INTO \w+\.QF_REPORT_PREFS \(USER_ID, REPORT_ID, FOLDER_ID, IS_FAVORITE, UPDATED_AT\) VALUES \(\?, \?, \?, \?, /.test(
        s,
      )
    ) {
      const [userId, reportId, folder, fav] = params;
      if (this.reportPrefs.has(`${userId}|${reportId}`))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      this.checkPrefFks(userId, reportId, folder);
      this.reportPrefs.set(`${userId}|${reportId}`, {
        USER_ID: userId,
        REPORT_ID: reportId,
        FOLDER_ID: folder,
        IS_FAVORITE: fav,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    if (/^DELETE FROM \w+\.QF_TILE_ORDER WHERE USER_ID = \?$/.test(s)) {
      let n = 0;
      for (const [k, v] of this.tileOrder)
        if (v.USER_ID === params[0]) {
          this.tileOrder.delete(k);
          n++;
        }
      return n;
    }
    if (
      /^INSERT INTO \w+\.QF_TILE_ORDER \(USER_ID, REPORT_ID, TILE_POS, UPDATED_AT\) VALUES \(\?, \?, \?, /.test(
        s,
      )
    ) {
      const [userId, reportId, pos] = params;
      if (this.tileOrder.has(`${userId}|${reportId}`))
        throw new DbError('Duplicate key value specified.', '23505', -803);
      if (!this.users.has(String(userId)) || !this.reports.has(String(reportId)))
        throw new DbError('Foreign key violation.', '23503', -530);
      if (typeof pos !== 'number' || pos < 0) throw new DbError('Check constraint.', '23513', -545);
      this.tileOrder.set(`${userId}|${reportId}`, {
        USER_ID: userId,
        REPORT_ID: reportId,
        TILE_POS: pos,
        UPDATED_AT: this.now(),
      });
      return 1;
    }
    throw new Error(`FakeMetadataDb: unsupported update ${s}`);
  }

  private checkPrefFks(userId: unknown, reportId: unknown, folder: unknown) {
    if (!this.users.has(String(userId)) || !this.reports.has(String(reportId)))
      throw new DbError('Foreign key violation.', '23503', -530);
    if (folder !== null && !this.folders.has(String(folder)))
      throw new DbError('Foreign key violation.', '23503', -530);
  }

  async transaction<R>(fn: (tx: Omit<MetadataDb, 'transaction'>) => Promise<R>): Promise<R> {
    const snapshot = {
      reports: new Map([...this.reports].map(([k, v]) => [k, { ...v }])),
      executions: new Map([...this.executions].map(([k, v]) => [k, { ...v }])),
      users: new Map([...this.users].map(([k, v]) => [k, { ...v }])),
      userGroups: new Map([...this.userGroups].map(([k, v]) => [k, { ...v }])),
      shares: this.shares.map((x) => ({ ...x })),
      shareAudit: this.shareAudit.map((x) => ({ ...x })),
      schedules: new Map([...this.schedules].map(([k, v]) => [k, { ...v }])),
      locks: new Map([...this.locks].map(([k, v]) => [k, { ...v }])),
      folders: new Map([...this.folders].map(([k, v]) => [k, { ...v }])),
      reportPrefs: new Map([...this.reportPrefs].map(([k, v]) => [k, { ...v }])),
      tileOrder: new Map([...this.tileOrder].map(([k, v]) => [k, { ...v }])),
      folderShares: this.folderShares.map((x) => ({ ...x })),
      folderReports: new Map([...this.folderReports].map(([k, v]) => [k, { ...v }])),
      folderShareAudit: this.folderShareAudit.map((x) => ({ ...x })),
      scheduleDeliveries: this.scheduleDeliveries.map((x) => ({ ...x })),
      folderReportSharing: new Map([...this.folderReportSharing].map(([k, v]) => [k, { ...v }])),
      folderDeletions: this.folderDeletions.map((x) => ({ ...x })),
      shareReminders: this.shareReminders.map((x) => ({ ...x })),
      userSettings: new Map([...this.userSettings].map(([k, v]) => [k, { ...v }])),
    };
    try {
      return await fn(this);
    } catch (e) {
      this.reports = snapshot.reports;
      this.executions = snapshot.executions;
      this.users = snapshot.users;
      this.userGroups = snapshot.userGroups;
      this.shares = snapshot.shares;
      this.shareAudit = snapshot.shareAudit;
      this.schedules = snapshot.schedules;
      this.locks = snapshot.locks;
      this.folders = snapshot.folders;
      this.reportPrefs = snapshot.reportPrefs;
      this.tileOrder = snapshot.tileOrder;
      this.folderShares = snapshot.folderShares;
      this.folderReports = snapshot.folderReports;
      this.folderShareAudit = snapshot.folderShareAudit;
      this.scheduleDeliveries = snapshot.scheduleDeliveries;
      this.folderReportSharing = snapshot.folderReportSharing;
      this.folderDeletions = snapshot.folderDeletions;
      this.shareReminders = snapshot.shareReminders;
      this.userSettings = snapshot.userSettings;
      throw e;
    }
  }
  async ping() {}
  async close() {}
}
