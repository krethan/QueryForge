import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q, toDbTimestamp } from '../db/schema.js';
import { parameterValuesSchema } from '../reports/parameters.js';
import { AppError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';
import {
  cadenceSchema,
  cadenceToCron,
  cronToCadence,
  describeCadence,
  type Cadence,
} from './cadence.js';

export type ScheduleStatus = 'NEVER' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export interface Schedule {
  id: string;
  reportId: string;
  reportName?: string;
  createdBy: string;
  cron: string;
  /** The friendly cadence the cron expression came from, or null for a custom cron schedule. */
  cadence: Cadence | null;
  /** Plain-English cadence, e.g. "Every Monday at 07:00" (in `timezone`). */
  description: string;
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

/**
 * Request body for creating or replacing a schedule. Send either a friendly `cadence`
 * (daily / weekdays / weekly / monthly at a time) or, for advanced use, a raw 5-field `cron`.
 */
export const scheduleBodySchema = z.object({
  cadence: cadenceSchema.optional(),
  cron: z.string().trim().min(1).max(128).optional(),
  timezone: z.string().trim().min(1).max(64),
  recipients: z.array(z.string().max(320)).max(100),
  parameters: parameterValuesSchema,
  enabled: z.boolean().default(true),
});
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

/** Normalised schedule input: the cadence is resolved to the cron expression that is stored. */
export interface ScheduleInput {
  cron: string;
  timezone: string;
  recipients: string[];
  parameters: Record<string, string | number | null>;
  enabled: boolean;
}

export function normaliseScheduleBody(b: ScheduleBody): ScheduleInput {
  if (b.cadence && b.cron)
    throw new AppError(
      400,
      'INVALID_CADENCE',
      'Send either a cadence or a cron expression, not both.',
    );
  if (!b.cadence && !b.cron)
    throw new AppError(400, 'INVALID_CADENCE', 'Choose how often the report should be delivered.');
  return {
    cron: b.cadence ? cadenceToCron(b.cadence) : b.cron!,
    timezone: b.timezone,
    recipients: b.recipients,
    parameters: b.parameters ?? {},
    enabled: b.enabled,
  };
}

export type DeliveryTrigger = 'SCHEDULE' | 'MANUAL';
export interface ScheduleDelivery {
  id: string;
  scheduleId: string;
  reportId: string;
  trigger: DeliveryTrigger;
  requestedBy: string | null;
  requestedByName?: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: 'SUCCEEDED' | 'FAILED';
  rowCount: number | null;
  deliveredTo: string[];
  skipped: string[];
  error: string | null;
}
export interface NewDelivery {
  scheduleId: string;
  reportId: string;
  trigger: DeliveryTrigger;
  requestedBy: string | null;
  startedAt: Date;
  finishedAt: Date;
  status: 'SUCCEEDED' | 'FAILED';
  rowCount: number | null;
  deliveredTo: string[];
  skipped: string[];
  error: string | null;
}

/** Join a list into a VARCHAR(4000) column without cutting an address in half. */
const joinList = (xs: string[], max = 4000) => {
  let out = '';
  for (const x of xs) {
    const next = out ? `${out},${x}` : x;
    if (next.length > max) break;
    out = next;
  }
  return out || null;
};
const splitList = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const COLS = `S.SCHEDULE_ID, S.REPORT_ID, S.CREATED_BY, S.CRON_EXPR, S.TIMEZONE, S.RECIPIENTS, S.PARAMS_JSON, S.IS_ENABLED,
  S.NEXT_RUN_AT, S.LAST_RUN_AT, S.LAST_STATUS, S.LAST_ERROR, S.FAILURE_COUNT, S.VERSION, R.REPORT_NAME`;

type Row = Record<string, unknown>;
const sharesTable = (reports: string) => reports.replace(/\.[^.]+$/, `.${T.shares}`);

const toSchedule = (r: Row): Schedule => {
  let parameters: Schedule['parameters'] = {};
  try {
    parameters = r.PARAMS_JSON ? JSON.parse(String(r.PARAMS_JSON)) : {};
  } catch {
    parameters = {};
  }
  const cron = String(r.CRON_EXPR);
  const cadence = cronToCadence(cron);
  return {
    id: String(r.SCHEDULE_ID),
    reportId: String(r.REPORT_ID),
    reportName: r.REPORT_NAME ? String(r.REPORT_NAME) : undefined,
    createdBy: String(r.CREATED_BY),
    cron,
    cadence,
    description: describeCadence(cadence, cron),
    timezone: String(r.TIMEZONE),
    recipients: splitList(r.RECIPIENTS),
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
  private readonly deliveries: string;
  private readonly users: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.schedules);
    this.reports = q(schema, T.reports);
    this.locks = q(schema, T.locks);
    this.deliveries = q(schema, T.scheduleDeliveries);
    this.users = q(schema, T.users);
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

  /**
   * Only schedules whose report remains accessible through the shared access model.
   * `viaFolders` are the report IDs the caller reaches through folders shared with their
   * reports (migration 011), already worked out by FolderReportGrants.
   */
  async listForUser(
    userId: string,
    groups: string[] = [],
    admin = false,
    viaFolders: string[] = [],
  ): Promise<Schedule[]> {
    const shares = sharesTable(this.reports);
    const ids = viaFolders.slice(0, 1000);
    const auth = admin
      ? ''
      : ` WHERE R.OWNER_ID = ? OR (S.CREATED_BY = ? AND R.OWNER_ID = ?) OR EXISTS (
          SELECT 1 FROM ${shares} X WHERE X.REPORT_ID = R.REPORT_ID AND
          ((X.PRINCIPAL_TYPE = 'USER' AND X.PRINCIPAL_ID = ?) OR
           (X.PRINCIPAL_TYPE = 'GROUP' AND X.PRINCIPAL_ID IN (${groups.length ? groups.map(() => '?').join(', ') : "''"}))))${
             ids.length ? ` OR R.REPORT_ID IN (${ids.map(() => '?').join(', ')})` : ''
           }`;
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.from()}${auth} ORDER BY R.REPORT_NAME_KEY, S.CREATED_AT`,
      admin ? [] : [userId, userId, userId, userId, ...groups, ...ids],
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

  /**
   * Pause or resume. Resuming starts again from the next occurrence after now (missed runs are
   * not replayed) and clears the consecutive-failure counter.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
    nextRunAt: Date | null,
    version?: number,
  ): Promise<Schedule> {
    const params: (string | number | null)[] = [
      enabled ? 1 : 0,
      nextRunAt ? toDbTimestamp(nextRunAt) : null,
      enabled ? 1 : 0,
      id,
    ];
    let vc = '';
    if (version !== undefined) {
      vc = ' AND VERSION = ?';
      params.push(version);
    }
    const n = await this.db.update(
      `UPDATE ${this.table}
          SET IS_ENABLED = ?, NEXT_RUN_AT = ?, FAILURE_COUNT = CASE WHEN ? = 1 THEN 0 ELSE FAILURE_COUNT END,
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

  /** Record one finished delivery attempt (QF_SCHEDULE_DELIVERIES, migration 010). */
  async recordDelivery(d: NewDelivery): Promise<string> {
    const id = randomUUID();
    await this.db.update(
      `INSERT INTO ${this.deliveries} (DELIVERY_ID, SCHEDULE_ID, REPORT_ID, RUN_TRIGGER, REQUESTED_BY, STARTED_AT, FINISHED_AT,
          STATUS, RESULT_ROWS, DELIVERED_TO, SKIPPED_TO, ERROR_MESSAGE)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        d.scheduleId,
        d.reportId,
        d.trigger,
        d.requestedBy,
        toDbTimestamp(d.startedAt),
        toDbTimestamp(d.finishedAt),
        d.status,
        d.rowCount,
        joinList(d.deliveredTo),
        joinList(d.skipped),
        d.error ? d.error.slice(0, 1000) : null,
      ],
    );
    return id;
  }

  /** Delivery history for one schedule, newest first. */
  async listDeliveries(scheduleId: string, limit = 25): Promise<ScheduleDelivery[]> {
    const n = Math.max(1, Math.min(Math.floor(limit) || 25, 100));
    const rows = await this.db.query<Row>(
      `SELECT D.DELIVERY_ID, D.SCHEDULE_ID, D.REPORT_ID, D.RUN_TRIGGER, D.REQUESTED_BY, D.STARTED_AT, D.FINISHED_AT,
              D.STATUS, D.RESULT_ROWS, D.DELIVERED_TO, D.SKIPPED_TO, D.ERROR_MESSAGE, U.DISPLAY_NAME AS REQUESTED_BY_NAME
         FROM ${this.deliveries} D LEFT JOIN ${this.users} U ON U.USER_ID = D.REQUESTED_BY
        WHERE D.SCHEDULE_ID = ? ORDER BY D.STARTED_AT DESC, D.DELIVERY_ID FETCH FIRST ${n} ROWS ONLY`,
      [scheduleId],
    );
    return rows.map((r) => ({
      id: String(r.DELIVERY_ID),
      scheduleId: String(r.SCHEDULE_ID),
      reportId: String(r.REPORT_ID),
      trigger: r.RUN_TRIGGER === 'MANUAL' ? 'MANUAL' : 'SCHEDULE',
      requestedBy: r.REQUESTED_BY ? String(r.REQUESTED_BY) : null,
      requestedByName: r.REQUESTED_BY_NAME ? String(r.REQUESTED_BY_NAME) : undefined,
      startedAt: dbTimestampToIso(r.STARTED_AT),
      finishedAt: dbTimestampToIso(r.FINISHED_AT),
      status: r.STATUS === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      rowCount:
        r.RESULT_ROWS === null || r.RESULT_ROWS === undefined ? null : Number(r.RESULT_ROWS),
      deliveredTo: splitList(r.DELIVERED_TO),
      skipped: splitList(r.SKIPPED_TO),
      error: r.ERROR_MESSAGE ? String(r.ERROR_MESSAGE) : null,
    }));
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
    r: {
      status: 'SUCCEEDED' | 'FAILED';
      error: string | null;
      failures: number;
      disable: boolean;
      /** When the run started (also set by "Run now", which is not claimed by the tick). */
      ranAt: Date;
    },
  ) {
    await this.db.update(
      `UPDATE ${this.table}
          SET LAST_STATUS = ?, LAST_ERROR = ?, FAILURE_COUNT = ?, IS_ENABLED = CASE WHEN ? = 1 THEN 0 ELSE IS_ENABLED END,
              LAST_RUN_AT = ?, UPDATED_AT = ${NOW_UTC}
        WHERE SCHEDULE_ID = ?`,
      [
        r.status,
        r.error ? r.error.slice(0, 1000) : null,
        r.failures,
        r.disable ? 1 : 0,
        toDbTimestamp(r.ranAt),
        id,
      ],
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
