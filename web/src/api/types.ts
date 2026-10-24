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
  report?: {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    sql: string;
    version: number;
  };
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
}

export interface ExecutionRecord {
  id: string;
  reportId: string | null;
  kind: 'RUN' | 'EXPORT';
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
  version?: number;
}
