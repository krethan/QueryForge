import { LexError, tokenize, type Token } from './lexer.js';

export interface ValidationOptions {
  /** Accept `?` markers (bound by Mapepire; the caller checks them against parameter definitions). */
  allowParameterMarkers?: boolean;
  maxLength: number;
  /** Schemas/libraries (upper case) that reporting SQL may never reference. */
  protectedSchemas: string[];
  /** Unqualified object names (upper case) that are reserved for application metadata. */
  protectedObjects?: string[];
}

export type ValidationResult =
  { ok: true; sql: string } | { ok: false; code: string; message: string; position?: number };

/** Statements / clauses that modify data, schema, authority or transaction state. */
const PROHIBITED_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'TRUNCATE',
  'DROP',
  'ALTER',
  'CREATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'CALL',
  'LOCK',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'DECLARE',
  'PREPARE',
  'EXECUTE',
  'INTO',
  'REFRESH',
  'CONNECT',
  'DISCONNECT',
  'ALLOCATE',
  'ASSOCIATE',
  'TRANSFER',
  'SIGNAL',
  'RESIGNAL',
]);

/**
 * Built-in Db2 for i / SYSTOOLS routines with side effects (CL execution, IFS
 * writes, outbound HTTP, e-mail, job/system changes). Matched only when used as a
 * function call (`NAME(`), with or without a schema qualifier.
 */
const PROHIBITED_ROUTINES = [
  /^QCMDEXC$/,
  /^QCMDCHK$/,
  /^IFS_WRITE/,
  /^IFS_COPY/,
  /^IFS_MOVE/,
  /^IFS_DELETE/,
  /^HTTP/,
  /^SEND_EMAIL$/,
  /^GENERATE_SPREADSHEET$/,
  /^GENERATE_PDF$/,
  /^CHANGE_/,
  /^SET_/,
  /^RESET_/,
  /^ADD_/,
  /^REMOVE_/,
  /^DELETE_/,
  /^END_JOB/,
  /^CANCEL_/,
  /^SYSTEM$/,
  /^LPRINTF$/,
  /^MESSAGE_QUEUE_SEND/,
  /^SEND_MESSAGE/,
  /^DATA_QUEUE_SEND/,
  /^SEND_DATA_QUEUE/,
  /^CLEAR_DATA_QUEUE/,
  /^QSYS_/,
];

const ALLOWED_FIRST = new Set(['SELECT', 'WITH', 'VALUES']);

const fail = (code: string, message: string, position?: number): ValidationResult => ({
  ok: false,
  code,
  message,
  position,
});

/**
 * Validate a user-supplied reporting statement. This is a defence-in-depth layer:
 * the reporting IBM i profile's object authority and the JDBC `access=read only`
 * property remain the real enforcement boundary.
 */
export function validateReportingSql(input: string, opts: ValidationOptions): ValidationResult {
  if (typeof input !== 'string' || input.trim() === '')
    return fail('EMPTY_SQL', 'Enter a SQL query.');
  if (input.length > opts.maxLength)
    return fail(
      'SQL_TOO_LONG',
      `Query exceeds the maximum length of ${opts.maxLength} characters.`,
    );
  if (input.includes('\u0000'))
    return fail('INVALID_CHARACTERS', 'Query contains a NUL character.');

  let all: Token[];
  try {
    all = tokenize(input);
  } catch (e) {
    if (e instanceof LexError) return fail('SQL_SYNTAX', e.message, e.position);
    throw e;
  }
  const tokens = all.filter((t) => t.type !== 'comment');
  if (tokens.length === 0) return fail('EMPTY_SQL', 'The query contains only comments.');

  // Single statement only: a semicolon is allowed only as the final token.
  let sqlEnd = input.length;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].type === 'symbol' && tokens[k].value === ';') {
      if (k !== tokens.length - 1)
        return fail(
          'MULTIPLE_STATEMENTS',
          'Only a single SQL statement may be executed.',
          tokens[k].start,
        );
      sqlEnd = tokens[k].start;
    }
  }
  const body = tokens.filter((t) => !(t.type === 'symbol' && t.value === ';'));
  if (body.length === 0) return fail('EMPTY_SQL', 'Enter a SQL query.');

  const first = body.find((t) => !(t.type === 'symbol' && t.value === '('));
  if (!first || first.type !== 'word' || !ALLOWED_FIRST.has(first.value)) {
    return fail(
      'STATEMENT_NOT_ALLOWED',
      'Only read-only queries (SELECT, WITH … SELECT, VALUES) are allowed.',
      first?.start,
    );
  }

  const protectedSchemas = new Set(opts.protectedSchemas.map((s) => s.toUpperCase()));
  const protectedObjects = new Set((opts.protectedObjects ?? []).map((s) => s.toUpperCase()));

  for (let k = 0; k < body.length; k++) {
    const t = body[k];
    const next = body[k + 1];
    const prev = body[k - 1];

    if (t.type === 'symbol' && t.value === '?' && !opts.allowParameterMarkers)
      return fail(
        'PARAMETER_MARKER',
        'Parameter markers (?) need a matching report parameter definition.',
        t.start,
      );
    if (t.type === 'symbol' && t.value === ':' && next?.type === 'word' && prev?.type !== 'number')
      return fail('HOST_VARIABLE', 'Host variables are not allowed.', t.start);

    if (t.type === 'word' || t.type === 'quoted') {
      const name = t.type === 'word' ? t.value : t.value; // quoted keeps case: "QFMETA" == QFMETA
      const isQualifier = next?.type === 'symbol' && (next.value === '.' || next.value === '/');
      const isQualified = prev?.type === 'symbol' && (prev.value === '.' || prev.value === '/');

      if (
        isQualifier &&
        protectedSchemas.has(name.toUpperCase()) &&
        (t.type === 'word' || name === name.toUpperCase())
      )
        return fail(
          'PROTECTED_OBJECT',
          `Schema ${name} is reserved for application metadata.`,
          t.start,
        );
      if (
        protectedObjects.has(name.toUpperCase()) &&
        (t.type === 'word' || name === name.toUpperCase())
      )
        return fail(
          'PROTECTED_OBJECT',
          `Object ${name} is reserved for application metadata.`,
          t.start,
        );

      if (t.type !== 'word') continue;

      // A keyword directly after a qualifier dot is an object/column name (e.g. T.UPDATE) – still blocked to stay conservative.
      if (PROHIBITED_KEYWORDS.has(t.value))
        return fail(
          'STATEMENT_NOT_ALLOWED',
          `${t.value} is not permitted in a reporting query.${isQualified ? ' Use a delimited identifier ("NAME") for columns with reserved names.' : ''}`,
          t.start,
        );
      if (
        (t.value === 'FINAL' || t.value === 'NEW' || t.value === 'OLD') &&
        next?.type === 'word' &&
        next.value === 'TABLE'
      )
        return fail(
          'STATEMENT_NOT_ALLOWED',
          'Data-change table references are not permitted.',
          t.start,
        );
      if (
        next?.type === 'symbol' &&
        next.value === '(' &&
        PROHIBITED_ROUTINES.some((r) => r.test(t.value))
      )
        return fail(
          'ROUTINE_NOT_ALLOWED',
          `Routine ${t.value} may have side effects and is not permitted.`,
          t.start,
        );
    }
  }

  // Only a trailing semicolon (and anything after it, which can only be comments/whitespace) is removed.
  const sql = input.slice(0, sqlEnd).replace(/\s+$/, '');
  return { ok: true, sql };
}
