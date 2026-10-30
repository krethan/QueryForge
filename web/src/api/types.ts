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
  /** Saved Report Builder definition ({version, spec}); null for SQL-only reports. */
  builderDef?: BuilderDef | null;
  /** Server re-validation of `builderDef` against the current catalog. */
  builder?: { valid: boolean; error?: string };
  /** Saved chart settings (migration 005); null when the report has no chart. */
  chartDef?: ChartDef | null;
  /** Why stored chart settings were ignored (tampered / outdated JSON). */
  chartError?: string;
}
export interface BuilderDef {
  version: 1;
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
export type AccessRole = 'OWNER' | 'EDITOR' | 'VIEWER';

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
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
}

export type ScheduleStatus = 'NEVER' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export interface Schedule {
  id: string;
  reportId: string;
  reportName?: string;
  createdBy: string;
  cron: string;
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
  cron: string;
  timezone: string;
  recipients: string[];
  parameters: ParameterValues;
  enabled: boolean;
  version?: number;
}
export interface ScheduleSettings {
  enabled: boolean;
  mailConfigured: boolean;
  recipientDomains: string[];
  maxRecipients: number;
  minIntervalMinutes: number;
  defaultTimezone: string;
  maxFailures: number;
}

export interface PageResponse {
  cursorId: string;
  rows: Cell[][];
  rowCount: number;
  hasMore: boolean;
  truncated: boolean;
  expiresAt?: string;
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
  events: ShareAuditEvent[];
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
}

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
export interface ReportFilter {
  table?: string;
  column: string;
  op: FilterOp;
  value?: string | number | null;
  value2?: string | number | null;
  values?: (string | number)[];
  /** "Ask when run": becomes a report parameter (BETWEEN: NAME_FROM / NAME_TO). */
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
}

export interface ReportBuilderRun extends RunResponse {
  builder?: { name: string; sql: string };
}
