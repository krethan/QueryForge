/**
 * Statement policy for the verification kit. Every statement the kit sends goes through a
 * ConfinedJob: reads (SELECT / VALUES / WITH) are always allowed; anything else is allowed only when
 * the run was started with a write flag, and only when every object it names lives in the
 * disposable library. This is enforced in code, not just documented.
 */
import type { QueryOptions } from '@ibm/mapepire-js';
import type { JobFactory, QueryLike, SqlJobLike } from '../../src/db/types.js';

export interface WritePolicy {
  /** False for the default read-only run. */
  writesAllowed: boolean;
  /** The disposable library every write must target. */
  schema?: string;
}

export interface StatementLogEntry {
  identity: string;
  kind: 'read' | 'write';
  sql: string;
}

export class PolicyViolation extends Error {}

/** Remove string literals and comments so keywords inside them are not mistaken for SQL. */
export function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

export function isReadStatement(sql: string): boolean {
  const s = stripLiterals(sql).trim().toUpperCase();
  if (s.includes(';')) return false;
  if (!/^(SELECT|VALUES|WITH)\b/.test(s)) return false;
  // A WITH could front a data-change statement; a SELECT could be SELECT ... FROM FINAL TABLE (INSERT ...).
  return !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|LABEL|COMMENT|CALL|RENAME|TRUNCATE)\b/.test(
    s,
  );
}

const OBJ = '([A-Z][A-Z0-9_#@$]*)(?:\\.([A-Z][A-Z0-9_#@$]*))?';
/** Patterns that name the object a write acts on (and any object it references). */
const TARGETS = [
  new RegExp(
    `\\bCREATE\\s+(?:UNIQUE\\s+(?:WHERE\\s+NOT\\s+NULL\\s+)?)?(?:TABLE|INDEX|VIEW)\\s+${OBJ}`,
    'g',
  ),
  new RegExp(`\\bALTER\\s+TABLE\\s+${OBJ}`, 'g'),
  new RegExp(`\\bLABEL\\s+ON\\s+(?:TABLE|INDEX|CONSTRAINT|COLUMN)\\s+${OBJ}`, 'g'),
  new RegExp(`\\bINSERT\\s+INTO\\s+${OBJ}`, 'g'),
  new RegExp(`\\bUPDATE\\s+(?!SET\\b)${OBJ}`, 'g'),
  new RegExp(`\\bDELETE\\s+FROM\\s+${OBJ}`, 'g'),
  new RegExp(`\\bMERGE\\s+INTO\\s+${OBJ}`, 'g'),
  new RegExp(`\\bREFERENCES\\s+${OBJ}`, 'g'),
  new RegExp(`\\b(?:GRANT|REVOKE)\\s+[A-Z ,]+?\\s+ON\\s+(?:TABLE\\s+)?${OBJ}`, 'g'),
  new RegExp(`\\bINDEX\\s+[A-Z0-9_#@$.]+\\s+ON\\s+${OBJ}`, 'g'),
];

/**
 * Throw unless a non-read statement only touches objects in `schema`. Unqualified targets are
 * refused too, because their library would depend on the job's library list.
 */
export function assertConfined(sql: string, schema: string): void {
  const s = stripLiterals(sql).replace(/\s+/g, ' ').trim().toUpperCase();
  if (s.includes(';')) throw new PolicyViolation('Multiple statements are not allowed.');
  if (/^(COMMIT|ROLLBACK)$/.test(s)) return;
  const schemaStmt = /^(CREATE|DROP) SCHEMA ([A-Z][A-Z0-9_#@$]*)( CASCADE| RESTRICT)?$/.exec(s);
  if (schemaStmt) {
    if (schemaStmt[2] !== schema)
      throw new PolicyViolation(
        `Refusing ${schemaStmt[1]} SCHEMA ${schemaStmt[2]}: only ${schema} is allowed.`,
      );
    return;
  }
  if (!/^(CREATE|ALTER|LABEL|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE)\b/.test(s))
    throw new PolicyViolation(`Refusing a statement the kit does not issue: ${s.slice(0, 80)}`);
  if (/\b(DROP TABLE|DROP INDEX|DROP VIEW|DROP SCHEMA|TRUNCATE)\b/.test(s))
    throw new PolicyViolation('Refusing a DROP of an individual object.');
  let found = 0;
  for (const re of TARGETS) {
    for (const m of s.matchAll(re)) {
      found++;
      const lib = m[2] ? m[1] : undefined;
      if (lib !== schema)
        throw new PolicyViolation(
          `Refusing to write ${m[2] ? `${m[1]}.${m[2]}` : m[1]}: writes are confined to ${schema}.`,
        );
    }
  }
  if (!found)
    throw new PolicyViolation(`Could not tell which object this writes: ${s.slice(0, 80)}`);
}

export function checkStatement(sql: string, policy: WritePolicy): 'read' | 'write' {
  if (isReadStatement(sql)) return 'read';
  if (!policy.writesAllowed || !policy.schema)
    throw new PolicyViolation(
      'This run is read-only; only SELECT and VALUES statements are allowed (use --apply-migrations for a disposable library).',
    );
  assertConfined(sql, policy.schema);
  return 'write';
}

/** SqlJobLike wrapper that applies the policy to every statement and logs it. */
export class ConfinedJob implements SqlJobLike {
  constructor(
    private readonly inner: SqlJobLike,
    private readonly policy: WritePolicy,
    private readonly identity: string,
    private readonly log: StatementLogEntry[],
  ) {}

  private gate(sql: string) {
    const kind = checkStatement(sql, this.policy);
    this.log.push({ identity: this.identity, kind, sql: sql.replace(/\s+/g, ' ').trim() });
  }
  connect(...args: Parameters<SqlJobLike['connect']>) {
    return this.inner.connect(...args);
  }
  query<T>(sql: string, opts?: QueryOptions): QueryLike<T> {
    this.gate(sql);
    return this.inner.query<T>(sql, opts);
  }
  execute<T>(sql: string, opts?: QueryOptions) {
    this.gate(sql);
    return this.inner.execute<T>(sql, opts);
  }
  get endTransaction(): SqlJobLike['endTransaction'] {
    const inner = this.inner;
    return inner.endTransaction ? (type) => inner.endTransaction!(type) : undefined;
  }
  close() {
    return this.inner.close();
  }
}

export const confinedFactory =
  (
    factory: JobFactory,
    policy: WritePolicy,
    identity: string,
    log: StatementLogEntry[],
  ): JobFactory =>
  (options) =>
    new ConfinedJob(factory(options), policy, identity, log);
