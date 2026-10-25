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
}
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
