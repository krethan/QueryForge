export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class DbError extends AppError {
  constructor(
    message: string,
    public readonly sqlState?: string,
    public readonly sqlCode?: number,
    code = 'DB_ERROR',
    status = 400,
  ) {
    super(status, code, message, { sqlState, sqlCode });
  }
}

const SECRET_PATTERNS = [/password\s*[=:]\s*\S+/gi, /pwd\s*[=:]\s*\S+/gi];

/**
 * Produce an error message safe to show to end users and to persist in
 * execution history: strips credentials, Java stack frames and trims length.
 */
export function sanitizeErrorMessage(raw: unknown, max = 1000): string {
  let msg = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : 'Unknown error';
  for (const p of SECRET_PATTERNS) msg = msg.replace(p, '[redacted]');
  msg = msg
    .split('\n')
    .filter((l) => !/^\s+at\s+\S/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

/** Extract SQLSTATE / SQLCODE from Mapepire errors (thrown error objects or failed responses). */
export function toDbError(err: unknown, fallbackCode = 'DB_ERROR'): DbError {
  if (err instanceof DbError) return err;
  const anyErr = err as { sql_state?: string; sql_rc?: number; error?: string; message?: string };
  let message = sanitizeErrorMessage(anyErr?.error ?? anyErr?.message ?? err);
  let sqlState = anyErr?.sql_state && anyErr.sql_state !== '00000' ? anyErr.sql_state : undefined;
  let sqlCode =
    typeof anyErr?.sql_rc === 'number' && anyErr.sql_rc !== 0 ? anyErr.sql_rc : undefined;
  // @ibm/mapepire-js 1.0.x throws `new Error([error, sql_state, sql_rc].join(", "))`
  const m = /^(.*), ([0-9A-Z]{5}), (-?\d+)$/s.exec(message);
  if (m) {
    message = m[1];
    sqlState ??= m[2] !== '00000' ? m[2] : undefined;
    sqlCode ??= Number(m[3]) || undefined;
  }
  const conn =
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|socket|websocket|certificate|self[- ]signed/i.test(
      message,
    );
  if (conn) return new DbError(message, sqlState, sqlCode, 'CONNECTION_ERROR', 503);
  if (sqlState?.startsWith('42501') || sqlCode === -551 || sqlCode === -552)
    return new DbError(message, sqlState, sqlCode, 'NOT_AUTHORIZED', 403);
  return new DbError(message, sqlState, sqlCode, fallbackCode, 400);
}
