import type { ChartDef } from '../utils/chartData';
import type {
  AuthProviders,
  DataSourceInfo,
  DrillDef,
  DrillInfo,
  DrillMeta,
  DrillRequest,
  DrillTargetOption,
  ParameterDef,
  ParameterValues,
  PivotRun,
  Schedule,
  ScheduleCadence,
  ScheduleDelivery,
  ScheduleInput,
  ScheduleRecipientOption,
  ScheduleRunResult,
  ScheduleSettings,
  FolderReportGrant,
  FolderShareReports,
  FolderSharing,
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
  CalcValidation,
  RunResponse,
  SchemaColumnsResponse,
  SchemaTablesResponse,
  User,
  Folder,
  Formatting,
  ReportPrefs,
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

/** X-QF-Chart: 'included' | 'none' | URI-encoded reason the chart was left out. */
function chartHeader(v: string | null): { included: boolean; note?: string } {
  if (!v || v === 'none') return { included: false };
  if (v === 'included') return { included: true };
  try {
    return { included: false, note: decodeURIComponent(v) };
  } catch {
    return { included: false, note: v };
  }
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
  listFolders: () => json<{ folders: Folder[] }>('GET', '/folders').then((r) => r.folders),
  createFolder: (name: string) =>
    json<{ folder: Folder }>('POST', '/folders', { name }).then((r) => r.folder),
  renameFolder: (id: string, name: string) =>
    json<{ folder: Folder }>('PUT', `/folders/${id}`, { name }).then((r) => r.folder),
  /** Deletes the folder; its reports become Unfiled (reports are never deleted). */
  deleteFolder: (id: string) => json<{ moved: number }>('DELETE', `/folders/${id}`),
  /** Who a folder is shared with (owner, or admin read-only). */
  getFolderShares: (id: string) =>
    json<{ shares: Share[] }>('GET', `/folders/${id}/shares`).then((r) => r.shares),
  /** Replace a folder's shares (owner only); leaves the "share the reports" option alone. */
  putFolderShares: (id: string, shares: Share[]) =>
    json<{ shares: Share[] }>('PUT', `/folders/${id}/shares`, {
      shares: shares.map(({ type, id: sid, role }) => ({ type, id: sid, role })),
    }).then((r) => r.shares),
  /** A folder's shares, its "share the reports" option and which reports that covers. */
  getFolderSharing: (id: string) => json<FolderSharing>('GET', `/folders/${id}/shares`),
  /**
   * Replace a folder's shares and set whether its reports are shared too (owner only). The
   * server decides which reports that covers: only your own, placed there by you.
   */
  putFolderSharing: (id: string, shares: Share[], shareReports: FolderShareReports) =>
    json<FolderSharing>('PUT', `/folders/${id}/shares`, {
      shares: shares.map(({ type, id: sid, role }) => ({ type, id: sid, role })),
      shareReports,
    }),
  /** Put a report you can see into a folder you can edit. */
  addToFolder: (folderId: string, reportId: string) =>
    json<{ folder: Folder }>('POST', `/folders/${folderId}/reports`, { reportId }).then(
      (r) => r.folder,
    ),
  /** Take a report out of a folder you can edit, for everyone (the report is not deleted). */
  removeFromFolder: (folderId: string, reportId: string) =>
    json<{ folder: Folder }>('DELETE', `/folders/${folderId}/reports/${reportId}`).then(
      (r) => r.folder,
    ),
  /** Save a shared folder's order; reports you cannot see keep their place. */
  saveFolderOrder: (folderId: string, reportIds: string[]) =>
    json<{ folder: Folder }>('PUT', `/folders/${folderId}/order`, { reportIds }).then(
      (r) => r.folder,
    ),
  /** Change the caller's own folder and/or star for a report. */
  setReportPrefs: (id: string, change: Partial<ReportPrefs>) =>
    json<{ prefs: ReportPrefs }>('PUT', `/reports/${id}/prefs`, change).then((r) => r.prefs),
  /**
   * Save the caller's dashboard tile order. The server keeps only reports the caller can see
   * and returns the stored list.
   */
  saveTileOrder: (reportIds: string[]) =>
    json<{ reportIds: string[] }>('PUT', '/dashboard/tile-order', { reportIds }).then(
      (r) => r.reportIds,
    ),
  /** Forget the caller's tile order (back to the default name order). */
  resetTileOrder: () =>
    json<{ reportIds: string[] }>('DELETE', '/dashboard/tile-order').then((r) => r.reportIds),
  getReport: (id: string) =>
    json<{ report: Report; builder?: Report['builder']; drill?: DrillInfo }>(
      'GET',
      `/reports/${id}`,
    ).then((r) => ({
      ...r.report,
      ...(r.builder ? { builder: r.builder } : {}),
      ...(r.drill ? { drill: r.drill } : {}),
    })),
  /** Runs the detail rows behind a clicked chart element or grouped row. */
  drill: (id: string, req: DrillRequest, signal?: AbortSignal) =>
    json<RunResponse & { drill: DrillMeta }>('POST', `/reports/${id}/drill`, req, signal),
  drillTargets: (id: string) =>
    json<{ targets: DrillTargetOption[] }>('GET', `/reports/${id}/drill-targets`).then(
      (r) => r.targets,
    ),
  setReportDrill: (id: string, drillDef: DrillDef | null) =>
    json<{ report: Report; drill: DrillInfo }>('PUT', `/reports/${id}/drill`, { drillDef }).then(
      (r) => ({ ...r.report, drill: r.drill }),
    ),
  createReport: (input: ReportInput) =>
    json<{ report: Report }>('POST', '/reports', input).then((r) => r.report),
  updateReport: (id: string, input: ReportInput) =>
    json<{ report: Report }>('PUT', `/reports/${id}`, input).then((r) => r.report),
  setReportChart: (id: string, chartDef: ChartDef | null) =>
    json<{ report: Report }>('PUT', `/reports/${id}/chart`, { chartDef }).then((r) => r.report),
  setReportFormatting: (id: string, formatting: Formatting | null) =>
    json<{ report: Report }>('PUT', `/reports/${id}/formatting`, { formatting }).then(
      (r) => r.report,
    ),
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
  /** A report's own shares plus the read-only access it gets through its owner's folders. */
  getReportSharing: (id: string) =>
    json<{ shares: Share[]; folderGrants?: FolderReportGrant[] }>(
      'GET',
      `/reports/${id}/shares`,
    ).then((r) => ({ shares: r.shares, folderGrants: r.folderGrants ?? [] })),
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
  previewSchedule: (when: { cron?: string; cadence?: ScheduleCadence }, timezone: string) =>
    json<{ upcoming: string[]; cron: string; description: string }>('POST', '/schedules/preview', {
      ...when,
      timezone,
    }),
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
    json<{ result: ScheduleRunResult; schedule: Schedule }>('POST', `/schedules/${id}/run`),
  pauseSchedule: (id: string, version?: number) =>
    json<{ schedule: Schedule }>('POST', `/schedules/${id}/pause`, { version }).then(
      (r) => r.schedule,
    ),
  resumeSchedule: (id: string, version?: number) =>
    json<{ schedule: Schedule }>('POST', `/schedules/${id}/resume`, { version }).then(
      (r) => r.schedule,
    ),
  scheduleDeliveries: (id: string) =>
    json<{ deliveries: ScheduleDelivery[] }>('GET', `/schedules/${id}/deliveries`).then(
      (r) => r.deliveries,
    ),
  scheduleRecipients: (reportId: string) =>
    json<{ recipients: ScheduleRecipientOption[] }>(
      'GET',
      `/reports/${reportId}/schedule-recipients`,
    ).then((r) => r.recipients),
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
  /** Report Builder: check one calculated-field expression against the report's tables. */
  validateCalc: (
    body: {
      schema: string;
      table: string;
      alias?: string;
      joins: { schema: string; table: string; alias?: string }[];
      expression: string;
    },
    signal?: AbortSignal,
  ) => json<CalcValidation>('POST', '/schema/calc/validate', body, signal),
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
  runReportBuilder: (
    spec: ReportSpec,
    executionId: string,
    signal?: AbortSignal,
    values?: ParameterValues,
  ) =>
    json<ReportBuilderRun>(
      'POST',
      '/schema/run',
      { ...spec, executionId, ...(values ? { values } : {}) },
      signal,
    ),

  /** Pivot: the server builds the grouped SQL and reshapes it; the browser sends no SQL. */
  runPivot: (
    spec: ReportSpec,
    executionId: string,
    signal?: AbortSignal,
    values?: ParameterValues,
  ) =>
    json<PivotRun>(
      'POST',
      '/schema/pivot',
      { ...spec, executionId, ...(values ? { values } : {}) },
      signal,
    ),
  runReportPivot: (
    id: string,
    executionId: string,
    signal?: AbortSignal,
    values?: ParameterValues,
  ) =>
    json<PivotRun>(
      'POST',
      `/reports/${id}/pivot`,
      { executionId, ...(values ? { values } : {}) },
      signal,
    ),

  dataSource: (check = false) =>
    json<DataSourceInfo>('GET', `/datasource${check ? '?check=1' : ''}`),

  /** Downloads a server-generated XLSX file. */
  async exportXlsx(src: {
    sql?: string;
    reportId?: string;
    name?: string;
    parameters?: ParameterDef[];
    values?: ParameterValues;
    /** Chart to draw on the workbook's Chart sheet (defaults to the report's saved chart). */
    chart?: ChartDef | null;
  }) {
    return download(await raw('POST', '/export', src));
  },
  /** Downloads a pivot in its on-screen layout (values only). */
  async exportPivot(
    src:
      | { reportId: string; values?: ParameterValues }
      | { spec: ReportSpec; name?: string; values?: ParameterValues },
  ) {
    if ('reportId' in src)
      return download(
        await raw(
          'POST',
          `/reports/${src.reportId}/pivot/export`,
          src.values ? { values: src.values } : {},
        ),
      );
    return download(
      await raw('POST', '/schema/pivot/export', {
        ...src.spec,
        ...(src.name ? { name: src.name } : {}),
        ...(src.values ? { values: src.values } : {}),
      }),
    );
  },
  /** Downloads the drilled detail rows as XLSX. */
  async exportDrill(id: string, req: DrillRequest) {
    return download(await raw('POST', `/reports/${id}/drill/export`, req));
  },
};

async function download(res: Response) {
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
    chart: chartHeader(res.headers.get('X-QF-Chart')),
  };
}
