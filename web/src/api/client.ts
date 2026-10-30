import type {
  AuthProviders,
  DataSourceInfo,
  ParameterDef,
  ParameterValues,
  Schedule,
  ScheduleInput,
  ScheduleSettings,
  Share,
  UserSummary,
  ExecutionRecord,
  PageResponse,
  ReportAccess,
  Report,
  JoinSuggestion,
  ReportBuilderRun,
  ReportInput,
  ReportSpec,
  ReportSqlPreview,
  RunResponse,
  SchemaColumnsResponse,
  SchemaTablesResponse,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public sqlState?: string,
    public sqlCode?: number,
    public position?: number,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const m = /(?:^|;\s*)qf_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function raw(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the Uncle Bob server. Check your network connection.',
    );
  }
  if (!res.ok) {
    let err: {
      code?: string;
      message?: string;
      sqlState?: string;
      sqlCode?: number;
      position?: number;
      fields?: Record<string, string>;
    } = {};
    try {
      err = ((await res.json()) as { error?: typeof err }).error ?? {};
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized();
    throw new ApiError(
      res.status,
      err.code ?? 'HTTP_' + res.status,
      err.message ?? res.statusText,
      err.sqlState,
      err.sqlCode,
      err.position,
      err.fields,
    );
  }
  return res;
}

async function json<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await raw(method, path, body, signal);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function filenameFrom(res: Response, fallback: string) {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="([^"]+)"/i.exec(cd);
  return plain ? plain[1] : fallback;
}

export const api = {
  login: (username: string, password: string, method: 'local' | 'ldap' = 'local') =>
    json<{ user: User; expiresAt: string }>('POST', '/auth/login', { username, password, method }),
  logout: () => json<void>('POST', '/auth/logout'),
  me: () => json<{ user: User; groups: string[]; expiresAt: string }>('GET', '/auth/me'),
  providers: () => json<AuthProviders>('GET', '/auth/providers'),

  listReports: (params: { search?: string; sort?: string } = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    return json<{ reports: Report[] }>('GET', `/reports${q.size ? `?${q}` : ''}`).then(
      (r) => r.reports,
    );
  },
  /** Owned reports plus reports shared with the caller (directly or through a group). */
  listAllReports: (params: { search?: string; sort?: string } = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    return json<{ reports: Report[]; shared?: Report[] }>(
      'GET',
      `/reports${q.size ? `?${q}` : ''}`,
    ).then((r) => ({ owned: r.reports, shared: r.shared ?? [] }));
  },
  getReport: (id: string) =>
    json<{ report: Report }>('GET', `/reports/${id}`).then((r) => r.report),
  createReport: (input: ReportInput) =>
    json<{ report: Report }>('POST', '/reports', input).then((r) => r.report),
  updateReport: (id: string, input: ReportInput) =>
    json<{ report: Report }>('PUT', `/reports/${id}`, input).then((r) => r.report),
  deleteReport: (id: string) => json<void>('DELETE', `/reports/${id}`),
  reportHistory: (id: string) =>
    json<{ executions: ExecutionRecord[] }>('GET', `/reports/${id}/history`).then(
      (r) => r.executions,
    ),
  history: () =>
    json<{ executions: ExecutionRecord[] }>('GET', '/history').then((r) => r.executions),

  execute: (
    sql: string,
    executionId: string,
    signal?: AbortSignal,
    params?: { parameters: ParameterDef[]; values: ParameterValues },
  ) =>
    json<RunResponse>(
      'POST',
      '/query/execute',
      params?.parameters.length ? { sql, executionId, ...params } : { sql, executionId },
      signal,
    ),
  executeReport: (
    id: string,
    executionId: string,
    signal?: AbortSignal,
    values?: ParameterValues,
  ) =>
    json<RunResponse>(
      'POST',
      `/reports/${id}/execute`,
      values ? { executionId, values } : { executionId },
      signal,
    ),

  nextPage: (cursorId: string, signal?: AbortSignal) =>
    json<PageResponse>('POST', `/results/${encodeURIComponent(cursorId)}/next`, {}, signal),
  closeCursor: (cursorId: string) =>
    json<void>('DELETE', `/results/${encodeURIComponent(cursorId)}`).catch(() => undefined),
  getAccess: (id: string) => json<ReportAccess>('GET', `/reports/${id}/access`),

  getShares: (id: string) =>
    json<{ shares: Share[] }>('GET', `/reports/${id}/shares`).then((r) => r.shares),
  putShares: (id: string, shares: Share[]) =>
    json<{ shares: Share[] }>('PUT', `/reports/${id}/shares`, {
      shares: shares.map(({ type, id: sid, role }) => ({ type, id: sid, role })),
    }).then((r) => r.shares),
  searchUsers: (search: string) =>
    json<{ users: UserSummary[] }>('GET', `/users?search=${encodeURIComponent(search)}`).then(
      (r) => r.users,
    ),
  groups: () => json<{ groups: string[] }>('GET', '/groups').then((r) => r.groups),

  scheduleSettings: () => json<ScheduleSettings>('GET', '/schedules/settings'),
  previewSchedule: (cron: string, timezone: string) =>
    json<{ upcoming: string[] }>('POST', '/schedules/preview', { cron, timezone }).then(
      (r) => r.upcoming,
    ),
  listSchedules: () =>
    json<{ schedules: Schedule[]; settings: ScheduleSettings }>('GET', '/schedules'),
  reportSchedules: (reportId: string) =>
    json<{ schedules: Schedule[]; settings: ScheduleSettings }>(
      'GET',
      `/reports/${reportId}/schedules`,
    ),
  createSchedule: (reportId: string, input: ScheduleInput) =>
    json<{ schedule: Schedule }>('POST', `/reports/${reportId}/schedules`, input).then(
      (r) => r.schedule,
    ),
  updateSchedule: (id: string, input: ScheduleInput) =>
    json<{ schedule: Schedule }>('PUT', `/schedules/${id}`, input).then((r) => r.schedule),
  deleteSchedule: (id: string) => json<void>('DELETE', `/schedules/${id}`),
  runScheduleNow: (id: string) =>
    json<{ result: { status: 'SUCCEEDED' | 'FAILED'; error?: string | null }; schedule: Schedule }>(
      'POST',
      `/schedules/${id}/run`,
    ),
  cancel: (executionId: string) =>
    json<{ cancelled: boolean }>('POST', `/query/${executionId}/cancel`),

  /** Report Builder: bounded, searchable list of tables/views the reporting profile can read. */
  schemaTables: (search = '', limit?: number) => {
    const q = new URLSearchParams();
    if (search.trim()) q.set('search', search.trim());
    if (limit) q.set('limit', String(limit));
    return json<SchemaTablesResponse>('GET', `/schema/tables${q.size ? `?${q}` : ''}`);
  },
  /** Report Builder: column metadata for one catalogued table. */
  schemaColumns: (schema: string, table: string) =>
    json<SchemaColumnsResponse>(
      'GET',
      `/schema/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/columns`,
    ),
  /** Report Builder: the SELECT the server built for this selection (no execution). */
  previewReportSql: (spec: ReportSpec, signal?: AbortSignal) =>
    json<ReportSqlPreview>('POST', '/schema/sql', spec, signal),
  /** Report Builder: suggested ON conditions for joining a table to the ones already added. */
  joinSuggestions: (
    tables: { alias: string; schema: string; table: string }[],
    schema: string,
    table: string,
  ) =>
    json<{ suggestions: JoinSuggestion[] }>('POST', '/schema/join-suggestions', {
      tables,
      schema,
      table,
    }),
  /** Report Builder: build + execute server-side, returning the standard paged result. */
  runReportBuilder: (spec: ReportSpec, executionId: string, signal?: AbortSignal) =>
    json<ReportBuilderRun>('POST', '/schema/run', { ...spec, executionId }, signal),

  dataSource: (check = false) =>
    json<DataSourceInfo>('GET', `/datasource${check ? '?check=1' : ''}`),

  /** Downloads a server-generated XLSX file. */
  async exportXlsx(src: {
    sql?: string;
    reportId?: string;
    name?: string;
    parameters?: ParameterDef[];
    values?: ParameterValues;
  }) {
    const res = await raw('POST', '/export', src);
    const blob = await res.blob();
    const name = filenameFrom(res, 'report.xlsx');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return {
      filename: name,
      rowCount: Number(res.headers.get('X-QF-Row-Count') ?? 0),
      truncated: res.headers.get('X-QF-Truncated') === 'true',
    };
  },
};
