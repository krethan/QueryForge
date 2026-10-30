import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q } from '../db/schema.js';
import { AppError, DbError } from '../util/errors.js';
import { dbTimestampToIso } from '../util/time.js';
import {
  countMarkers,
  parameterListSchema,
  parseStoredParameters,
  type ParameterDef,
} from './parameters.js';

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
  parameters: ParameterDef[];
  /** Parsed Report Builder definition (migration 004), or null for SQL-only reports. */
  builderDef: unknown | null;
}

export type AccessRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export interface AccessibleReport extends Report {
  access: AccessRole;
  ownerName?: string;
}

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v && v.trim() ? v.trim() : null));

export const reportInputSchema = z
  .object({
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
    parameters: parameterListSchema,
  })
  .superRefine((r, ctx) => {
    const n = countMarkers(r.sql);
    if (n !== r.parameters.length)
      ctx.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: `The SQL has ${n} parameter marker(s) (?) but ${r.parameters.length} parameter(s) are defined.`,
      });
  });
export type ReportInput = Omit<z.infer<typeof reportInputSchema>, 'parameters'> & {
  parameters?: ParameterDef[];
  /** Validated builder definition; stored as JSON in BUILDER_DEF. */
  builderDef?: unknown | null;
};

export const reportUpdateSchema = z.intersection(
  reportInputSchema,
  z.object({ version: z.number().int().positive().optional() }),
);

export type SortKey = 'name' | 'created' | 'lastRun' | 'updated';
const SORT_SQL: Record<SortKey, string> = {
  name: 'REPORT_NAME_KEY ASC',
  created: 'CREATED_AT DESC',
  lastRun: 'LAST_EXECUTED_AT DESC NULLS LAST, REPORT_NAME_KEY ASC',
  updated: 'UPDATED_AT DESC',
};

const COLS = `REPORT_ID, OWNER_ID, REPORT_NAME, DESCRIPTION, CATEGORY, SQL_TEXT, VERSION, CREATED_AT, UPDATED_AT,
  LAST_EXECUTED_AT, LAST_STATUS, LAST_ROW_COUNT, LAST_DURATION_MS, PARAMETERS_JSON, BUILDER_DEF`;

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
  parameters: parseStoredParameters(r.PARAMETERS_JSON),
  builderDef: parseBuilderDef(r.BUILDER_DEF),
});

function parseBuilderDef(raw: unknown): unknown | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null; // a corrupt definition only disables "Open in Report Builder"
  }
}

const paramsJson = (p: ParameterDef[] | undefined) => (p?.length ? JSON.stringify(p) : null);
const builderJson = (d: unknown) => (d === null || d === undefined ? null : JSON.stringify(d));
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
    private readonly schema: string,
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

  /** Unscoped read by id. Callers MUST authorise via AccessService before returning data. */
  async findById(id: string): Promise<Report | null> {
    const rows = await this.db.query<Row>(`SELECT ${COLS} FROM ${this.table} WHERE REPORT_ID = ?`, [
      id,
    ]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  /** Reports shared with the user directly or through one of their groups (never their own). */
  async listShared(userId: string, groups: string[]): Promise<AccessibleReport[]> {
    const shares = q(this.schema, T.shares);
    const users = q(this.schema, T.users);
    const params: string[] = [userId, userId];
    let groupClause = '';
    if (groups.length) {
      groupClause = ` OR (S.PRINCIPAL_TYPE = 'GROUP' AND S.PRINCIPAL_ID IN (${groups.map(() => '?').join(', ')}))`;
      params.push(...groups);
    }
    const rows = await this.db.query<Row>(
      `SELECT ${COLS.split(',')
        .map((c) => `R.${c.trim()}`)
        .join(', ')}, S.SHARE_ROLE, U.DISPLAY_NAME AS OWNER_NAME
         FROM ${this.table} R
         JOIN ${shares} S ON S.REPORT_ID = R.REPORT_ID
         JOIN ${users} U ON U.USER_ID = R.OWNER_ID
        WHERE R.OWNER_ID <> ? AND ((S.PRINCIPAL_TYPE = 'USER' AND S.PRINCIPAL_ID = ?)${groupClause})
        ORDER BY R.REPORT_NAME_KEY ASC`,
      params,
    );
    const byId = new Map<string, AccessibleReport>();
    for (const r of rows) {
      const rep = toReport(r);
      const access: AccessRole = r.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER';
      const prev = byId.get(rep.id);
      if (!prev || (prev.access === 'VIEWER' && access === 'EDITOR'))
        byId.set(rep.id, { ...rep, access, ownerName: String(r.OWNER_NAME ?? '') });
    }
    return [...byId.values()];
  }

  async create(ownerId: string, input: ReportInput): Promise<Report> {
    const id = randomUUID();
    try {
      await this.db.update(
        `INSERT INTO ${this.table} (REPORT_ID, OWNER_ID, REPORT_NAME, REPORT_NAME_KEY, DESCRIPTION, CATEGORY, SQL_TEXT,
            PARAMETERS_JSON, BUILDER_DEF, VERSION, CREATED_AT, UPDATED_AT, LAST_STATUS)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ${NOW_UTC}, ${NOW_UTC}, 'NEVER')`,
        [
          id,
          ownerId,
          input.name,
          nameKey(input.name),
          input.description,
          input.category,
          input.sql,
          paramsJson(input.parameters),
          builderJson(input.builderDef),
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
      paramsJson(input.parameters),
      builderJson(input.builderDef),
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
            SET REPORT_NAME = ?, REPORT_NAME_KEY = ?, DESCRIPTION = ?, CATEGORY = ?, SQL_TEXT = ?, PARAMETERS_JSON = ?, BUILDER_DEF = ?,
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
