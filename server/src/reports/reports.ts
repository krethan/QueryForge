import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import { AppError, DbError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';

export type ExecutionStatus =
  'NEVER' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

export interface Report {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  category: string | null;
  sql: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastExecutedAt: string | null;
  lastStatus: ExecutionStatus;
  lastRowCount: number | null;
  lastDurationMs: number | null;
}

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v && v.trim() ? v.trim() : null));

export const reportInputSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, 'Report name is required')
        .max(128, 'Report name must be 128 characters or fewer'),
    ),
  description: optText(2000),
  category: optText(128),
  sql: z.string().min(1, 'SQL is required'),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

export const reportUpdateSchema = reportInputSchema.extend({
  version: z.number().int().positive().optional(),
});

export type SortKey = 'name' | 'created' | 'lastRun' | 'updated';
const SORT_SQL: Record<SortKey, string> = {
  name: 'REPORT_NAME_KEY ASC',
  created: 'CREATED_AT DESC',
  lastRun: 'LAST_EXECUTED_AT DESC NULLS LAST, REPORT_NAME_KEY ASC',
  updated: 'UPDATED_AT DESC',
};

const COLS = `REPORT_ID, OWNER_ID, REPORT_NAME, DESCRIPTION, CATEGORY, SQL_TEXT, VERSION, CREATED_AT, UPDATED_AT,
  LAST_EXECUTED_AT, LAST_STATUS, LAST_ROW_COUNT, LAST_DURATION_MS`;

type Row = Record<string, unknown>;
const toReport = (r: Row): Report => ({
  id: String(r.REPORT_ID),
  ownerId: String(r.OWNER_ID),
  name: String(r.REPORT_NAME),
  description: (r.DESCRIPTION as string) ?? null,
  category: (r.CATEGORY as string) ?? null,
  sql: String(r.SQL_TEXT ?? ''),
  version: Number(r.VERSION),
  createdAt: dbTimestampToIso(r.CREATED_AT),
  updatedAt: dbTimestampToIso(r.UPDATED_AT),
  lastExecutedAt: dbTimestampToIso(r.LAST_EXECUTED_AT),
  lastStatus: (r.LAST_STATUS as ExecutionStatus) ?? 'NEVER',
  lastRowCount:
    r.LAST_ROW_COUNT === null || r.LAST_ROW_COUNT === undefined ? null : Number(r.LAST_ROW_COUNT),
  lastDurationMs:
    r.LAST_DURATION_MS === null || r.LAST_DURATION_MS === undefined
      ? null
      : Number(r.LAST_DURATION_MS),
});

const nameKey = (name: string) => name.trim().toUpperCase();
const isDuplicate = (e: unknown) =>
  e instanceof DbError && (e.sqlState === '23505' || e.sqlCode === -803);

export const NOT_FOUND = () => new AppError(404, 'REPORT_NOT_FOUND', 'Report not found.');

/**
 * Saved-report persistence. Every statement is parameterised and every read or
 * write is scoped by OWNER_ID so one user can never see or change another's reports.
 */
export class ReportRepository {
  readonly table: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
  ) {
    this.table = q(schema, T.reports);
  }

  async list(
    ownerId: string,
    opts: { search?: string; sort?: SortKey; category?: string } = {},
  ): Promise<Report[]> {
    const where = ['OWNER_ID = ?'];
    const params: (string | number)[] = [ownerId];
    if (opts.search?.trim()) {
      where.push(`REPORT_NAME_KEY LIKE ? ESCAPE '\\'`);
      params.push(`%${nameKey(opts.search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (opts.category?.trim()) {
      where.push('CATEGORY = ?');
      params.push(opts.category.trim());
    }
    const order = SORT_SQL[opts.sort ?? 'name'] ?? SORT_SQL.name;
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.table} WHERE ${where.join(' AND ')} ORDER BY ${order}`,
      params,
    );
    return rows.map(toReport);
  }

  async get(ownerId: string, id: string): Promise<Report> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM ${this.table} WHERE REPORT_ID = ? AND OWNER_ID = ?`,
      [id, ownerId],
    );
    if (!rows[0]) throw NOT_FOUND();
    return toReport(rows[0]);
  }

  async create(ownerId: string, input: ReportInput): Promise<Report> {
    const id = randomUUID();
    try {
      await this.db.update(
        `INSERT INTO ${this.table} (REPORT_ID, OWNER_ID, REPORT_NAME, REPORT_NAME_KEY, DESCRIPTION, CATEGORY, SQL_TEXT,
            VERSION, CREATED_AT, UPDATED_AT, LAST_STATUS)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ${NOW_UTC}, ${NOW_UTC}, 'NEVER')`,
        [
          id,
          ownerId,
          input.name,
          nameKey(input.name),
          input.description,
          input.category,
          input.sql,
        ],
      );
    } catch (e) {
      if (isDuplicate(e))
        throw new AppError(
          409,
          'DUPLICATE_NAME',
          `You already have a report named "${input.name}".`,
        );
      throw e;
    }
    return this.get(ownerId, id);
  }

  async update(
    ownerId: string,
    id: string,
    input: ReportInput & { version?: number },
  ): Promise<Report> {
    const params: (string | number | null)[] = [
      input.name,
      nameKey(input.name),
      input.description,
      input.category,
      input.sql,
      id,
      ownerId,
    ];
    let versionClause = '';
    if (input.version !== undefined) {
      versionClause = ' AND VERSION = ?';
      params.push(input.version);
    }
    let n: number;
    try {
      n = await this.db.update(
        `UPDATE ${this.table}
            SET REPORT_NAME = ?, REPORT_NAME_KEY = ?, DESCRIPTION = ?, CATEGORY = ?, SQL_TEXT = ?,
                VERSION = VERSION + 1, UPDATED_AT = ${NOW_UTC}
          WHERE REPORT_ID = ? AND OWNER_ID = ?${versionClause}`,
        params,
      );
    } catch (e) {
      if (isDuplicate(e))
        throw new AppError(
          409,
          'DUPLICATE_NAME',
          `You already have a report named "${input.name}".`,
        );
      throw e;
    }
    if (n === 0) {
      await this.get(ownerId, id); // throws 404 when not owned / missing
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'This report was changed elsewhere. Reload it and try again.',
      );
    }
    return this.get(ownerId, id);
  }

  async delete(ownerId: string, id: string): Promise<void> {
    const n = await this.db.update(
      `DELETE FROM ${this.table} WHERE REPORT_ID = ? AND OWNER_ID = ?`,
      [id, ownerId],
    );
    if (n === 0) throw NOT_FOUND();
  }
}
