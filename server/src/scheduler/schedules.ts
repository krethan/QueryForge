import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q, toDbTimestamp } from '../db/schema.js';
import { parameterValuesSchema } from '../reports/parameters.js';
import { AppError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';

export type ScheduleStatus = 'NEVER' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export interface Schedule {
  id: string;
  reportId: string;
  reportName?: string;
  createdBy: string;
  cron: string;
  timezone: string;
  recipients: string[];
  parameters: Record<string, string | number | null>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleStatus;
  lastError: string | null;
  failureCount: number;
  version: number;
}

export const scheduleInputSchema = z.object({
  cron: z.string().trim().min(1).max(128),
  timezone: z.string().trim().min(1).max(64),
  recipients: z.array(z.string().max(320)).max(100),
  parameters: parameterValuesSchema,
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

const COLS = `S.SCHEDULE_ID, S.REPORT_ID, S.CREATED_BY, S.CRON_EXPR, S.TIMEZONE, S.RECIPIENTS, S.PARAMS_JSON, S.IS_ENABLED,
  S.NEXT_RUN_AT, S.LAST_RUN_AT, S.LAST_STATUS, S.LAST_ERROR, S.FAILURE_COUNT, S.VERSION, R.REPORT_NAME`;

type Row = Record<string, unknown>;
const toSchedule = (r: Row): Schedule => {
  let parameters: Schedule['parameters'] = {};
  try {
    parameters = r.PARAMS_JSON ? JSON.parse(String(r.PARAMS_JSON)) : {};
  } catch {
    parameters = {};
  }
  return {
    id: String(r.SCHEDULE_ID),
    reportId: String(r.REPORT_ID),
    reportName: r.REPORT_NAME ? String(r.REPORT_NAME) : undefined,
    createdBy: String(r.CREATED_BY),
    cron: String(r.CRON_EXPR),
    timezone: String(r.TIMEZONE),
    recipients: String(r.RECIPIENTS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    parameters,
    enabled: Number(r.IS_ENABLED) === 1,
    nextRunAt: dbTimestampToIso(r.NEXT_RUN_AT),
    lastRunAt: dbTimestampToIso(r.LAST_RUN_AT),
    lastStatus: (r.LAST_STATUS as ScheduleStatus) ?? 'NEVER',
    lastError: (r.LAST_ERROR as string) ?? null,
    failureCount: Number(r.FAILURE_COUNT ?? 0),
    version: Number(r.VERSION ?? 1),
  };
};

/** Scheduled runs in Db2 for i (QF_SCHEDULES) and the scheduler lease (QF_LOCKS). */
export class ScheduleRepository {
  private readonly table: string;
  private readonly reports: string;
  private readonly locks: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.schedules);
    this.reports = q(schema, T.reports);
    this.locks = q(schema, T.locks);
  }

  private from() {
    return `${this.table} S JOIN ${this.reports} R ON R.REPORT_ID = S.REPORT_ID`;
  }

  async get(id: string): Promise<Schedule> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.from()} WHERE S.SCHEDULE_ID = ?`,
      [id],
    );
    if (!rows[0]) throw new AppError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found.');
    return toSchedule(rows[0]);
  }

  async listForReport(reportId: string): Promise<Schedule[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.from()} WHERE S.REPORT_ID = ? ORDER BY S.CREATED_AT`,
      [reportId],
    );
    return rows.map(toSchedule);
  }

  /** Schedules on reports the user owns, or that the user created. */
  async listForUser(userId: string): Promise<Schedule[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.from()} WHERE R.OWNER_ID = ? OR S.CREATED_BY = ? ORDER BY R.REPORT_NAME_KEY, S.CREATED_AT`,
      [userId, userId],
    );
    return rows.map(toSchedule);
  }

  async create(
    reportId: string,
    by: string,
    input: ScheduleInput,
    nextRunAt: Date | null,
  ): Promise<Schedule> {
    const id = randomUUID();
    await this.db.update(
      `INSERT INTO ${this.table} (SCHEDULE_ID, REPORT_ID, CREATED_BY, CRON_EXPR, TIMEZONE, RECIPIENTS, PARAMS_JSON, IS_ENABLED,
          NEXT_RUN_AT, LAST_STATUS, FAILURE_COUNT, VERSION, CREATED_AT, UPDATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEVER', 0, 1, ${NOW_UTC}, ${NOW_UTC})`,
      [
        id,
        reportId,
        by,
        input.cron,
        input.timezone,
        input.recipients.join(','),
        JSON.stringify(input.parameters ?? {}),
        input.enabled ? 1 : 0,
        nextRunAt ? toDbTimestamp(nextRunAt) : null,
      ],
    );
    return this.get(id);
  }

  async update(
    id: string,
    input: ScheduleInput,
    nextRunAt: Date | null,
    version?: number,
  ): Promise<Schedule> {
    const params: (string | number | null)[] = [
      input.cron,
      input.timezone,
      input.recipients.join(','),
      JSON.stringify(input.parameters ?? {}),
      input.enabled ? 1 : 0,
      nextRunAt ? toDbTimestamp(nextRunAt) : null,
      id,
    ];
    let vc = '';
    if (version !== undefined) {
      vc = ' AND VERSION = ?';
      params.push(version);
    }
    const n = await this.db.update(
      `UPDATE ${this.table}
          SET CRON_EXPR = ?, TIMEZONE = ?, RECIPIENTS = ?, PARAMS_JSON = ?, IS_ENABLED = ?, NEXT_RUN_AT = ?,
              FAILURE_COUNT = CASE WHEN IS_ENABLED = 0 THEN 0 ELSE FAILURE_COUNT END,
              VERSION = VERSION + 1, UPDATED_AT = ${NOW_UTC}
        WHERE SCHEDULE_ID = ?${vc}`,
      params,
    );
    if (n === 0) {
      await this.get(id);
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'This schedule was changed elsewhere. Reload and try again.',
      );
    }
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const n = await this.db.update(`DELETE FROM ${this.table} WHERE SCHEDULE_ID = ?`, [id]);
    if (n === 0) throw new AppError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found.');
  }

  async due(now: Date, limit = 10): Promise<Schedule[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.from()}
        WHERE S.IS_ENABLED = 1 AND S.NEXT_RUN_AT <= ?
        ORDER BY S.NEXT_RUN_AT FETCH FIRST ${Math.max(1, Math.min(limit, 100))} ROWS ONLY`,
      [toDbTimestamp(now)],
    );
    return rows.map(toSchedule);
  }

  /**
   * Atomically claim one due run by advancing NEXT_RUN_AT from the value we read.
   * Only one instance's UPDATE can match, so a run is never executed twice.
   */
  async claim(s: Schedule, next: Date | null, now: Date): Promise<boolean> {
    if (!s.nextRunAt) return false;
    const n = await this.db.update(
      `UPDATE ${this.table} SET NEXT_RUN_AT = ?, LAST_RUN_AT = ?, LAST_STATUS = 'RUNNING'
        WHERE SCHEDULE_ID = ? AND IS_ENABLED = 1 AND NEXT_RUN_AT = ?`,
      [
        next ? toDbTimestamp(next) : null,
        toDbTimestamp(now),
        s.id,
        toDbTimestamp(new Date(s.nextRunAt)),
      ],
    );
    return n === 1;
  }

  async recordResult(
    id: string,
    r: { status: 'SUCCEEDED' | 'FAILED'; error: string | null; failures: number; disable: boolean },
  ) {
    await this.db.update(
      `UPDATE ${this.table}
          SET LAST_STATUS = ?, LAST_ERROR = ?, FAILURE_COUNT = ?, IS_ENABLED = CASE WHEN ? = 1 THEN 0 ELSE IS_ENABLED END,
              UPDATED_AT = ${NOW_UTC}
        WHERE SCHEDULE_ID = ?`,
      [r.status, r.error ? r.error.slice(0, 1000) : null, r.failures, r.disable ? 1 : 0, id],
    );
  }

  /** Acquire or renew the named lease. Returns true when this instance holds it. */
  async acquireLease(name: string, holder: string, now: Date, ttlMs: number): Promise<boolean> {
    const until = toDbTimestamp(new Date(now.getTime() + ttlMs));
    const n = await this.db.update(
      `UPDATE ${this.locks} SET HOLDER = ?, EXPIRES_AT = ? WHERE LOCK_NAME = ? AND (HOLDER = ? OR EXPIRES_AT < ?)`,
      [holder, until, name, holder, toDbTimestamp(now)],
    );
    if (n === 1) return true;
    try {
      await this.db.update(
        `INSERT INTO ${this.locks} (LOCK_NAME, HOLDER, EXPIRES_AT) VALUES (?, ?, ?)`,
        [name, holder, until],
      );
      return true;
    } catch {
      return false; // another instance holds an unexpired lease (duplicate key)
    }
  }

  async releaseLease(name: string, holder: string) {
    await this.db.update(`DELETE FROM ${this.locks} WHERE LOCK_NAME = ? AND HOLDER = ?`, [
      name,
      holder,
    ]);
  }
}
