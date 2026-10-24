import type {
  DataSourceInfo,
  ExecutionRecord,
  Report,
  ReportInput,
  RunResponse,
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
      'Cannot reach the QueryForge server. Check your network connection.',
    );
  }
  if (!res.ok) {
    let err: {
      code?: string;
      message?: string;
      sqlState?: string;
      sqlCode?: number;
      position?: number;
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
  login: (username: string, password: string) =>
    json<{ user: User; expiresAt: string }>('POST', '/auth/login', { username, password }),
  logout: () => json<void>('POST', '/auth/logout'),
  me: () => json<{ user: User; expiresAt: string }>('GET', '/auth/me'),

  listReports: (params: { search?: string; sort?: string } = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    return json<{ reports: Report[] }>('GET', `/reports${q.size ? `?${q}` : ''}`).then(
      (r) => r.reports,
    );
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

  execute: (sql: string, executionId: string, signal?: AbortSignal) =>
    json<RunResponse>('POST', '/query/execute', { sql, executionId }, signal),
  executeReport: (id: string, executionId: string, signal?: AbortSignal) =>
    json<RunResponse>('POST', `/reports/${id}/execute`, { executionId }, signal),
  cancel: (executionId: string) =>
    json<{ cancelled: boolean }>('POST', `/query/${executionId}/cancel`),

  dataSource: (check = false) =>
    json<DataSourceInfo>('GET', `/datasource${check ? '?check=1' : ''}`),

  /** Downloads a server-generated XLSX file. */
  async exportXlsx(src: { sql?: string; reportId?: string; name?: string }) {
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
