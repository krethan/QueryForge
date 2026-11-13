import type { ChartDef } from '../utils/chartData';
export type ColumnKind =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'text'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'boolean'
  | 'binary'
  | 'lob'
  | 'xml'
  | 'other';

export interface ResultColumn {
  key: string;
  name: string;
  label: string;
  type: string;
  kind: ColumnKind;
  precision: number;
  scale: number;
  nullable: boolean;
  /** Server runtime could not guarantee exact digits for this column (Node < 22). */
  precisionAtRisk?: boolean;
}

export type BinaryCell = { $binary: true; size: number | null };
export type FormatColor =
  'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'gray';
export interface FormatRule {
  column: string;
  op: '>' | '>=' | '<' | '<=' | '=' | '<>' | 'between' | 'contains' | 'is null';
  value?: string | number | null;
  value2?: string | number | null;
  color: FormatColor;
  scope: 'cell' | 'row';
}
export interface Formatting {
  version: 1;
  rules: FormatRule[];
}
export interface FormatStyle {
  color: FormatColor;
  scope: 'cell' | 'row';
}
export const FORMAT_COLORS: { id: FormatColor; bg: string; fg: string }[] = [
  { id: 'red', bg: '#fff1f1', fg: '#a2191f' },
  { id: 'orange', bg: '#fff2e8', fg: '#8a3800' },
  { id: 'yellow', bg: '#fcf4d6', fg: '#684e00' },
  { id: 'green', bg: '#defbe6', fg: '#0e6027' },
  { id: 'teal', bg: '#d9f4f2', fg: '#005d5d' },
  { id: 'blue', bg: '#edf5ff', fg: '#0043ce' },
  { id: 'purple', bg: '#f6f0ff', fg: '#6929c4' },
  { id: 'gray', bg: '#e0e0e0', fg: '#161616' },
];
export const colorStyle = (color: FormatColor) => {
  const c = FORMAT_COLORS.find((c) => c.id === color)!;
  return { backgroundColor: c.bg, color: c.fg };
};

export type Cell = string | number | boolean | null | BinaryCell;

export interface RunResponse {
  executionId: string;
  columns: ResultColumn[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  dataSource: string;
  /** More rows can be fetched through `cursor`. */
  hasMore?: boolean;
  formatting?: Formatting;
  formatStyles?: (FormatStyle | null)[][];
  cursor?: { id: string; expiresAt: string; pageSize: number };
  /** More rows exist but the server could not keep a cursor open (limit reached). */
  pagingUnavailable?: boolean;
  report?: {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    sql: string;
    version: number;
    parameters?: ParameterDef[];
  };
  /** Parameter values actually bound (after defaults). */
  parameters?: ParameterValues;
}

export type ExecutionStatus =
  'NEVER' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

export interface Report {
  id: string;
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
  parameters?: ParameterDef[];
  ownerId?: string;
  ownerName?: string;
  /** The caller's access to this report. */
  access?: AccessRole;
  /** True when that access comes from a folder its owner shared together with its reports. */
  viaFolder?: boolean;
  /** Saved Report Builder definition ({version, spec}); null for SQL-only reports. */
  builderDef?: BuilderDef | null;
  /** Server re-validation of `builderDef` against the current catalog. */
  builder?: { valid: boolean; error?: string };
  /** Saved chart settings (migration 005); null when the report has no chart. */
  chartDef?: ChartDef | null;
  /** Why stored chart settings were ignored (tampered / outdated JSON). */
  chartError?: string;
  /** Saved drill target settings; null when none. */
  drillDef?: DrillDef | null;
  formatting?: Formatting | null;
  formattingError?: string;
  drillError?: string;
  hasDatePresets?: boolean;
  /** Drill-down options for the caller (GET /reports/:id only). */
  drill?: DrillInfo;
  /** The viewing user's own folder for this report (null = Unfiled; GET /reports only). */
  folderId?: string | null;
  /** Whether the viewing user starred this report (GET /reports only). */
  favorite?: boolean;
  /**
   * The viewing user's saved dashboard tile position (0 = first), or null when they have not
   * placed this report yet (GET /reports only; migration 008).
   */
  tilePos?: number | null;
}

/**
 * A report folder (migration 006), possibly shared (migration 009). The extra fields come
 * from GET /folders; older callers and tests may leave them out.
 */
export interface Folder {
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  ownerId?: string;
  ownerName?: string;
  /** The caller's role on the folder. ADMIN is editor-equivalent, never the owner. */
  access?: AccessRole;
  /** True when the folder is shared with anyone (always true for folders shared with you). */
  shared?: boolean;
  /**
   * Migration 011: when set, the owner also shares their own reports in the folder with the
   * people it is shared with, at most at this role. Null or missing: reports are not shared.
   */
  shareReports?: FolderShareReports;
  /** Reports in the folder that the caller can see, in the folder's order. */
  reportIds?: string[];
}
export interface ReportPrefs {
  folderId: string | null;
  favorite: boolean;
}
export interface BuilderDef {
  /**
   * 1 = original; 2 = may contain calculated fields; 3 = may contain a pivot.
   * Older versions are still read unchanged.
   */
  version: 1 | 2 | 3;
  spec: ReportSpec;
}

export interface ExecutionRecord {
  id: string;
  reportId: string | null;
  kind: 'RUN' | 'EXPORT' | 'SCHEDULE';
  parameters?: ParameterValues | null;
  scheduleId?: string | null;
  status: Exclude<ExecutionStatus, 'NEVER'>;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  rowCount: number | null;
  truncated: boolean;
  sqlState: string | null;
  errorMessage: string | null;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'USER' | 'ADMIN';
  authSource?: AuthSource;
}

export interface DataSourceInfo {
  name: string;
  host: string;
  port: number;
  tlsVerification: boolean;
  customCa: boolean;
  reportingUser: string;
  defaultSchema: string | null;
  libraries: string[];
  naming: string;
  metadataSchema: string;
  limits: Record<string, number>;
  activeExecutions: number;
  checks?: Record<string, { ok: boolean; ms: number; error?: string }>;
}

export interface ReportInput {
  name: string;
  description?: string | null;
  category?: string | null;
  sql: string;
  parameters?: ParameterDef[];
  version?: number;
  /** Report Builder definition; the server regenerates `sql` and `parameters` from it. */
  builderDef?: BuilderDef | null;
  /** Chart settings to save with a new report (existing reports use setReportChart). */
  chartDef?: ChartDef | null;
}

export type AuthSource = 'LOCAL' | 'OIDC' | 'LDAP';
export type AccessRole = 'OWNER' | 'EDITOR' | 'VIEWER' | 'ADMIN';

export type ParameterType = 'string' | 'integer' | 'decimal' | 'date' | 'list';
export interface ParameterDef {
  name: string;
  label: string;
  type: ParameterType;
  required: boolean;
  defaultValue: string | null;
  options?: { value: string; label?: string }[];
  /** A Report Builder filter value: bound like any parameter but never prompted for. */
  fixed?: boolean;
  /** Report Builder text match: the value is escaped and wrapped in % on the server. */
  match?: 'contains' | 'startsWith' | 'endsWith';
  /** Rolling date metadata; the server resolves the stored preset for every run. */
  datePreset?: DatePresetSpec | null;
}
/** Parameters a user is asked for (fixed Report Builder values are not). */
export const promptable = (defs: ParameterDef[] | undefined) =>
  (defs ?? []).filter((d) => !d.fixed);
export type ParameterValues = Record<string, string | number | null>;

export interface AuthProviders {
  local: boolean;
  oidc: { label: string; startUrl: string } | null;
  ldap: { label: string } | null;
}

export interface Share {
  type: 'USER' | 'GROUP';
  id: string;
  role: 'VIEWER' | 'EDITOR';
  displayName?: string;
}
/** A folder's "also share the reports" option: the most a recipient gets, or null (off). */
export type FolderShareReports = 'VIEWER' | 'EDITOR' | null;
/** Why a report in a folder is not shared through it. */
export type FolderReportSkipReason = 'NOT_OWNER' | 'ADDED_BY_OTHER';
/** GET/PUT /folders/:id/shares (owner; admins may read). */
export interface FolderSharing {
  shares: Share[];
  shareReports: FolderShareReports;
  /** The reports in the folder the caller can see: shared (or would be) through it, or skipped. */
  reports: {
    included: { id: string; name: string }[];
    skipped: { id: string; name: string; ownerName: string; reason: FolderReportSkipReason }[];
  };
}
/** Access to a report that comes from one of its owner's folders (read-only on the report). */
export interface FolderReportGrant {
  folderId: string;
  folderName: string;
  type: 'USER' | 'GROUP';
  id: string;
  role: 'VIEWER' | 'EDITOR';
  displayName?: string;
}
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
}

export type ScheduleStatus = 'NEVER' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type ScheduleFrequency = 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY';
/** Friendly cadence; the server stores it as a cron expression in the schedule's time zone. */
export interface ScheduleCadence {
  frequency: ScheduleFrequency;
  /** "HH:MM", 24-hour, in the schedule's time zone */
  time: string;
  /** 0 = Sunday ... 6 = Saturday (WEEKLY) */
  weekday?: number;
  /** 1-28 or 'LAST' (MONTHLY) */
  dayOfMonth?: number | 'LAST';
}
export interface Schedule {
  id: string;
  reportId: string;
  reportName?: string;
  createdBy: string;
  cron: string;
  /** null for a custom cron schedule */
  cadence: ScheduleCadence | null;
  /** e.g. "Every Monday at 07:00" */
  description: string;
  timezone: string;
  recipients: string[];
  parameters: ParameterValues;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleStatus;
  lastError: string | null;
  failureCount: number;
  version: number;
}
export interface ScheduleInput {
  /** Send either a cadence or (advanced) a cron expression. */
  cadence?: ScheduleCadence;
  cron?: string;
  timezone: string;
  recipients: string[];
  parameters: ParameterValues;
  enabled: boolean;
  version?: number;
}
export interface ScheduleDelivery {
  id: string;
  scheduleId: string;
  reportId: string;
  trigger: 'SCHEDULE' | 'MANUAL';
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
/** Someone who can open the report and has an e-mail address. */
export interface ScheduleRecipientOption {
  userId: string;
  displayName: string;
  email: string;
  owner: boolean;
  allowedDomain: boolean;
}
export interface ScheduleRunResult {
  status: 'SUCCEEDED' | 'FAILED';
  error?: string | null;
  deliveredTo?: string[];
  skipped?: string[];
}
export interface ScheduleSettings {
  enabled: boolean;
  mailConfigured: boolean;
  recipientDomains: string[];
  maxRecipients: number;
  minIntervalMinutes: number;
  defaultTimezone: string;
  datePresetTimezone: string;
  maxFailures: number;
}

export interface PageResponse {
  cursorId: string;
  rows: Cell[][];
  rowCount: number;
  hasMore: boolean;
  truncated: boolean;
  expiresAt?: string;
  formatStyles?: (FormatStyle | null)[][];
}

export interface ShareAuditEvent {
  id: string;
  reportId: string;
  action: 'GRANT' | 'CHANGE' | 'REVOKE';
  principalType: 'USER' | 'GROUP';
  principalId: string;
  principalName?: string;
  oldRole: 'VIEWER' | 'EDITOR' | null;
  newRole: 'VIEWER' | 'EDITOR' | null;
  actorId: string;
  actorName?: string;
  occurredAt: string;
}
export interface ReportAccess {
  owner: { id: string; displayName: string };
  shares: Share[];
  /** Access through folders shared with their reports (migration 011). */
  folderGrants?: FolderReportGrant[];
  events: ShareAuditEvent[];
}

/**
 * One row of a folder's sharing history. principalType REPORTS (migration 012) is the owner's
 * "also share the reports in this folder" option: oldRole / newRole are its level before and
 * after, null meaning off.
 */
export interface FolderShareAuditEvent {
  id: string;
  folderId: string;
  action: 'GRANT' | 'CHANGE' | 'REVOKE';
  principalType: 'USER' | 'GROUP' | 'REPORTS';
  principalId: string;
  principalName?: string;
  oldRole: 'VIEWER' | 'EDITOR' | null;
  newRole: 'VIEWER' | 'EDITOR' | null;
  actorId: string;
  actorName?: string;
  occurredAt: string;
}
/** GET /folders/:id/access: owner or admin only. */
export interface FolderAccess {
  owner: { id: string; displayName: string };
  shares: Share[];
  shareReports: FolderShareReports;
  events: FolderShareAuditEvent[];
  hasMore: boolean;
}
/** GET /folders/:id/audit: one page of the history, newest first. */
export interface FolderAuditPage {
  events: FolderShareAuditEvent[];
  hasMore: boolean;
  limit: number;
  offset: number;
}
/** One deleted folder (migration 013). Only app admins can read these. */
export interface FolderDeletion {
  id: string;
  folderId: string;
  folderName: string;
  ownerId: string;
  ownerName?: string;
  actorId: string;
  actorName?: string;
  shareCount: number;
  placedCount: number;
  filedCount: number;
  reportsRole: 'VIEWER' | 'EDITOR' | null;
  deletedAt: string;
}
/** GET /admin/folder-deletions: one page, newest first. */
export interface FolderDeletionPage {
  deletions: FolderDeletion[];
  hasMore: boolean;
  limit: number;
  offset: number;
}
/** GET /admin/folder-deletions/:folderId/audit: a deleted folder's sharing history, newest first. */
export interface DeletedFolderAuditPage {
  deletion: FolderDeletion;
  events: FolderShareAuditEvent[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

// ---- Report Builder (catalog-driven SELECT) ----
export type CatalogTableType = 'T' | 'P' | 'V' | 'L' | 'A' | 'M' | string;

export interface SchemaTable {
  schema: string;
  name: string;
  /** QSYS2.SYSTABLES.TABLE_TYPE: T table, P physical file, V view, L logical file, A alias, M MQT. */
  type: CatalogTableType;
  typeLabel: string;
  text: string | null;
}

export interface SchemaTablesResponse {
  tables: SchemaTable[];
  /** More matches exist than the server returned for this page. */
  truncated: boolean;
  cachedAt: string;
  maxTables: number;
}

export interface SchemaColumn {
  name: string;
  type: string;
  /** e.g. VARCHAR(40), DECIMAL(11, 2) — display only. */
  displayType: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  text: string | null;
  ordinal: number;
}

export interface SchemaColumnsResponse {
  schema: string;
  table: string;
  type: CatalogTableType;
  text: string | null;
  cachedAt: string;
  columns: SchemaColumn[];
}

export type SortDirection = 'ASC' | 'DESC';

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';

/** `left` is a table already in the report (by alias); `right` is a column of the joined table. */
export interface JoinCondition {
  left: { table: string; column: string };
  right: { column: string };
}

export interface ReportJoin {
  schema: string;
  table: string;
  /** Omitted: the server uses the position (T2, T3, …). */
  alias?: string;
  type: JoinType;
  on: JoinCondition[];
}

/** A column of any table in the report; no `table` means the base table. */
export interface ReportColumnRef {
  table?: string;
  column: string;
}

/** Report Builder input: names only — the server builds and validates the SQL. */
export interface ReportSpec {
  schema: string;
  table: string;
  alias?: string;
  joins?: ReportJoin[];
  columns: (string | ReportColumnRef)[];
  sort?: { table?: string; column?: string; aggregate?: string; direction: SortDirection }[];
  filters?: (ReportFilter | ReportFilterGroup)[];
  filterLogic?: FilterLogic;
  groupBy?: ReportColumnRef[];
  aggregates?: ReportAggregate[];
  having?: ReportHaving[];
  /** Named calculated fields; referenced elsewhere as { table: '@CALC', column: id }. */
  calculated?: CalculatedField[];
  /** Pivot / crosstab layout (builder definition version 3). */
  pivot?: PivotDef;
}

export type PivotFn = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';
export interface PivotDef {
  rows: ReportColumnRef[];
  column: ReportColumnRef;
  value: { fn: PivotFn; table?: string; column?: string | null };
}
export type PivotKey = string | number | null;
export interface PivotField {
  name: string;
  label: string;
  kind: ColumnKind;
  scale: number;
}
/** Server-pivoted grid (POST /schema/pivot, /reports/:id/pivot). */
export interface PivotResult {
  rowFields: PivotField[];
  columnField: PivotField;
  value: { fn: PivotFn; label: string; kind: ColumnKind; scale: number };
  columns: { label: string; value: PivotKey }[];
  rows: { keys: PivotKey[]; labels: string[]; cells: Cell[]; present: boolean[]; total: Cell }[];
  columnTotals: Cell[];
  grandTotal: Cell;
  groupCount: number;
  exact: boolean;
  long: { columns: ResultColumn[]; rows: Cell[][] };
}
/** Rule targets: normal/grouped/calculated output names, or aggregate output name (PIVOT_VALUE) on a pivot. */
export interface PivotRun {
  pivot: PivotResult;
  executionId: string;
  completedAt: string;
  durationMs: number;
  parameters?: Record<string, string | number | null>;
  dataSource?: string;
  builder: { name: string; sql: string };
  warnings?: string[];
  formatting?: Formatting;
  formatStyles?: (FormatStyle | null)[][];
  report?: { id: string; name: string };
}

/** Pseudo table for calculated-field references. */
export const CALC_TABLE = '@CALC';
export type CalcType = 'integer' | 'decimal' | 'char' | 'date' | 'timestamp';
export interface CalculatedField {
  /** Stable identifier (letters, digits, _), unique in the report. */
  id: string;
  /** Output column name. */
  name: string;
  /** Expression in the calculated-field language (never SQL from the browser). */
  expression: string;
  /** Result type inferred by the server (ignored on input). */
  type?: CalcType;
}
export type CalcValidation =
  | { ok: true; type: CalcType; hint: string; sql: string; columns: string[] }
  | { ok: false; error: { message: string; position: number | null } };

export type FilterLogic = 'AND' | 'OR';
export type FilterOp =
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | 'BETWEEN'
  | 'IN'
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'IS_NULL'
  | 'IS_NOT_NULL';
export type DatePresetType =
  | 'TODAY'
  | 'YESTERDAY'
  | 'THIS_WEEK'
  | 'LAST_WEEK'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'THIS_QUARTER'
  | 'LAST_QUARTER'
  | 'YTD'
  | 'LAST_YEAR'
  | 'LAST_N_DAYS';
export interface DatePresetSpec {
  preset: DatePresetType;
  n?: number;
}
/** '' = Custom literal date. */
export const DATE_PRESET_CHOICES: { value: string; text: string }[] = [
  { value: '', text: 'Custom' },
  { value: 'TODAY', text: 'Today' },
  { value: 'YESTERDAY', text: 'Yesterday' },
  { value: 'THIS_WEEK', text: 'This week' },
  { value: 'LAST_WEEK', text: 'Last week' },
  { value: 'THIS_MONTH', text: 'This month' },
  { value: 'LAST_MONTH', text: 'Last month' },
  { value: 'THIS_QUARTER', text: 'This quarter' },
  { value: 'LAST_QUARTER', text: 'Last quarter' },
  { value: 'YTD', text: 'Year to date' },
  { value: 'LAST_YEAR', text: 'Last year' },
  { value: 'LAST_N_DAYS', text: 'Last N days' },
];
/** Decodes the server-persisted opaque preset without inspecting SQL. */
export function parseDatePresetValue(
  value: string | null | undefined,
): { choice: string; n?: number } | null {
  if (!value?.startsWith('$preset:')) return null;
  try {
    const p = JSON.parse(value.slice(8)) as { preset?: string; n?: number };
    return p.preset && DATE_PRESET_CHOICES.some((c) => c.value === p.preset)
      ? { choice: p.preset, ...(p.n ? { n: p.n } : {}) }
      : null;
  } catch {
    return null;
  }
}

export interface ReportFilter {
  table?: string;
  column: string;
  op: FilterOp;
  value?: string | number | null;
  value2?: string | number | null;
  values?: (string | number)[];
  /** "Ask when run": becomes a report parameter (BETWEEN: NAME_FROM / NAME_TO). */
  /** Rolling range (only valid for date fields); the server binds its bounds. */
  preset?: DatePresetSpec | null;
  ask?: {
    name: string;
    label: string;
    defaultValue?: string | number | null;
    defaultValue2?: string | number | null;
  } | null;
}
export interface ReportFilterGroup {
  logic: FilterLogic;
  filters: ReportFilter[];
}
export type AggregateFn = 'COUNT' | 'COUNT_DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
export interface ReportAggregate {
  fn: AggregateFn;
  table?: string;
  column?: string | null;
  name?: string;
}
export type HavingOp = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'BETWEEN';
export interface ReportHaving {
  aggregate: string;
  op: HavingOp;
  value: string | number | null;
  value2?: string | number | null;
}

export interface JoinSuggestion {
  source: 'foreign-key' | 'column-name';
  constraint?: string;
  label: string;
  on: JoinCondition[];
}

export interface ReportSqlPreview {
  sql: string;
  name: string;
  schema: string;
  table: string;
  /** Joined reports only: final aliases (base first) and type warnings. */
  aliases?: string[];
  warnings?: string[];
  /** Bound values in marker order: fixed filter values and "Ask when run" parameters. */
  parameters?: ParameterDef[];
  /** Calculated fields with their server-inferred types. */
  calculated?: CalculatedField[];
}

export interface ReportBuilderRun extends RunResponse {
  builder?: { name: string; sql: string };
}

// ---- drill-down ----
export type DrillValue = string | number | null;
export type DrillKeys = Record<string, DrillValue>;
export interface DrillDef {
  version: 1;
  targetReportId: string;
  mapping: { field: string; parameter: string }[];
}
/** What a report offers for drill-down (from GET /reports/:id). */
export interface DrillInfo {
  /** Builder reports: group fields that can be drilled into automatically. */
  builder: { fields: string[] } | null;
  /** A configured drill target the caller can run. */
  target: { id: string; name: string; fields: string[] } | null;
  targetUnavailable: boolean;
}
export interface DetailColumn {
  table: string;
  column: string;
  label?: string;
  type?: string;
}
export type DrillMeta =
  | {
      mode: 'builder';
      sourceId: string;
      sourceName: string;
      label: string;
      applied: { field: string; value: DrillValue }[];
      columns: DetailColumn[];
      available: DetailColumn[];
    }
  | {
      mode: 'target';
      sourceId: string;
      sourceName: string;
      label: string;
      applied: { field: string; value: DrillValue }[];
      target: { id: string; name: string };
      values: ParameterValues;
      next: DrillInfo;
    };
export interface DrillRequest {
  keys: DrillKeys;
  mode?: 'builder' | 'target';
  values?: ParameterValues;
  columns?: { table: string; column: string }[];
  executionId?: string;
}
export interface DrillTargetOption {
  id: string;
  name: string;
  parameters: { name: string; label?: string; type: string }[];
}
