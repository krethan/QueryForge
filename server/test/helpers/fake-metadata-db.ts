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
    });
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
      const [id, owner, name, key, desc, cat, text] = params;
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
      const [name, key, desc, cat, text, id, owner, version] = params;
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
      for (const e of this.executions.values()) if (e.REPORT_ID === params[0]) e.REPORT_ID = null; // ON DELETE SET NULL
      return 1;
    }
    if (s.startsWith('INSERT INTO') && s.includes('.QF_EXECUTIONS')) {
      const [id, reportId, userId, kind, hash] = params;
      this.executions.set(String(id), {
        EXECUTION_ID: id,
        REPORT_ID: reportId,
        USER_ID: userId,
        KIND: kind,
        STATUS: 'RUNNING',
        STARTED_AT: this.now(),
        TRUNCATED: 0,
        SQL_SHA256: hash,
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
    throw new Error(`FakeMetadataDb: unsupported update ${s}`);
  }

  async transaction<R>(fn: (tx: Omit<MetadataDb, 'transaction'>) => Promise<R>): Promise<R> {
    const snapshot = {
      reports: new Map([...this.reports].map(([k, v]) => [k, { ...v }])),
      executions: new Map([...this.executions].map(([k, v]) => [k, { ...v }])),
    };
    try {
      return await fn(this);
    } catch (e) {
      this.reports = snapshot.reports;
      this.executions = snapshot.executions;
      throw e;
    }
  }
  async ping() {}
  async close() {}
}
