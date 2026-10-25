import type { MetadataDb } from '../../src/db/types.js';
import { DbError } from '../../src/util/errors.js';

type P = (string | number | null)[];
type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the Db2 for i metadata tables, used only by tests.
 * It understands exactly the parameterised statements QueryForge issues and
 * asserts that no user-supplied value ever appears inside SQL text.
 */
export class FakeMetadataDb implements MetadataDb {
  users = new Map<string, Row>();
  reports = new Map<string, Row>();
  executions = new Map<string, Row>();
  /** key `${userId}|${group}` */
  userGroups = new Map<string, Row>();
  shares: Row[] = [];
  schedules = new Map<string, Row>();
  locks = new Map<string, Row>();
  statements: { sql: string; params: P }[] = [];
  private clock = 0;
  failNext?: Error;

  private now() {
    this.clock++;
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

  addGroup(userId: string, group: string, source = 'LOCAL') {
    this.userGroups.set(`${userId}|${group}`, {
      USER_ID: userId,
      GROUP_NAME: group,
      SOURCE: source,
    });
  }

  private withReportName(sc: Row): Row {
    const r = this.reports.get(String(sc.REPORT_ID));
    return {
      ...sc,
      REPORT_NAME: r?.REPORT_NAME ?? null,
      REPORT_NAME_KEY: r?.REPORT_NAME_KEY ?? null,
    };
  }

  async query<T>(sql: string, params: P = []): Promise<T[]> {
    this.record(sql, params);
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('SELECT 1 AS OK')) return [{ OK: 1 }] as T[];
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
      /^SELECT PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE FROM \w+\.QF_REPORT_SHARES WHERE REPORT_ID = \?$/.test(
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
          OWNER_NAME: this.users.get(String(r.OWNER_ID))?.DISPLAY_NAME,
        });
      }
      return out.sort((a, b) =>
        String(a.REPORT_NAME_KEY).localeCompare(String(b.REPORT_NAME_KEY)),
      ) as T[];
    }
    if (
      /FROM \w+\.QF_SCHEDULES S JOIN \w+\.QF_REPORTS R ON R\.REPORT_ID = S\.REPORT_ID WHERE/.test(s)
    ) {
      let rows = [...this.schedules.values()].map((x) => this.withReportName(x));
      if (s.includes('WHERE S.SCHEDULE_ID = ?'))
        rows = rows.filter((x) => x.SCHEDULE_ID === params[0]);
      else if (s.includes('WHERE S.REPORT_ID = ?'))
        rows = rows.filter((x) => x.REPORT_ID === params[0]);
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
    throw new Error(`FakeMetadataDb: unsupported query ${s}`);
  }

  async update(sql: string, params: P = []): Promise<number> {
    this.record(sql, params);
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('INSERT INTO') && s.includes('.QF_REPORTS')) {
      const [id, owner, name, key, desc, cat, text, pjson] = params;
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
      const [name, key, desc, cat, text, pjson, id, owner, version] = params;
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
        VERSION: Number(r.VERSION) + 1,
        UPDATED_AT: this.now(),
      });
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
      for (const e of this.executions.values()) if (e.REPORT_ID === params[0]) e.REPORT_ID = null; // ON DELETE SET NULL
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
    // ---- shares ----
    if (/^DELETE FROM \w+\.QF_REPORT_SHARES WHERE REPORT_ID = \?$/.test(s)) {
      const before = this.shares.length;
      this.shares = this.shares.filter((x) => x.REPORT_ID !== params[0]);
      return before - this.shares.length;
    }
    if (
      /^INSERT INTO \w+\.QF_REPORT_SHARES \(REPORT_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, CREATED_BY, CREATED_AT\)/.test(
        s,
      )
    ) {
      const [rid, type, pid, role, by] = params;
      if (!this.reports.has(String(rid)))
        throw new DbError('Foreign key violation.', '23503', -530);
      this.shares.push({
        REPORT_ID: rid,
        PRINCIPAL_TYPE: type,
        PRINCIPAL_ID: pid,
        SHARE_ROLE: role,
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
      return this.schedules.delete(String(params[0])) ? 1 : 0;
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
      const [status, err, failures, disable, id] = params;
      const x = this.schedules.get(String(id));
      if (!x) return 0;
      Object.assign(x, {
        LAST_STATUS: status,
        LAST_ERROR: err,
        FAILURE_COUNT: failures,
        IS_ENABLED: disable === 1 ? 0 : x.IS_ENABLED,
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
    throw new Error(`FakeMetadataDb: unsupported update ${s}`);
  }

  async transaction<R>(fn: (tx: Omit<MetadataDb, 'transaction'>) => Promise<R>): Promise<R> {
    const snapshot = {
      reports: new Map([...this.reports].map(([k, v]) => [k, { ...v }])),
      executions: new Map([...this.executions].map(([k, v]) => [k, { ...v }])),
      users: new Map([...this.users].map(([k, v]) => [k, { ...v }])),
      userGroups: new Map([...this.userGroups].map(([k, v]) => [k, { ...v }])),
      shares: this.shares.map((x) => ({ ...x })),
      schedules: new Map([...this.schedules].map(([k, v]) => [k, { ...v }])),
      locks: new Map([...this.locks].map(([k, v]) => [k, { ...v }])),
    };
    try {
      return await fn(this);
    } catch (e) {
      this.reports = snapshot.reports;
      this.executions = snapshot.executions;
      this.users = snapshot.users;
      this.userGroups = snapshot.userGroups;
      this.shares = snapshot.shares;
      this.schedules = snapshot.schedules;
      this.locks = snapshot.locks;
      throw e;
    }
  }
  async ping() {}
  async close() {}
}
