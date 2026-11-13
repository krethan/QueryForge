/**
 * Derives the Db2 for i objects each migration should leave behind (tables, columns, constraints,
 * indexes, table labels) by parsing server/migrations. The verification kit compares this with the
 * QSYS2 catalog, so a new migration is covered without hand-maintaining a second list; any statement
 * the parser does not understand is reported in `unparsed` and fails the unit tests.
 */
import { loadMigrations, type MigrationFile } from '../../src/db/migration-files.js';

export type ConstraintType = 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
export type DeleteRule = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT';
/** QSYS2.SYSINDEXES.IS_UNIQUE: D duplicates allowed, U unique, V unique where not null. */
export type IndexUniqueRule = 'D' | 'U' | 'V';

export interface ExpectedTable {
  name: string;
  migration: number;
  label?: string;
}
export interface ExpectedColumn {
  table: string;
  name: string;
  migration: number;
}
export interface ExpectedConstraint {
  name: string;
  table: string;
  type: ConstraintType;
  migration: number;
  /** Foreign keys only (Db2 default when omitted is NO ACTION). */
  deleteRule?: DeleteRule;
  referencesTable?: string;
  /** CHECK only: every string literal in the clause, which must appear in SYSCHKCST.CHECK_CLAUSE. */
  checkLiterals?: string[];
}
export interface ExpectedIndex {
  name: string;
  table: string;
  unique: IndexUniqueRule;
  migration: number;
}
/** LABEL ON text limits from the IBM i SQL reference: object/column TEXT 50 bytes, column headings 60. */
export const LABEL_LIMIT_BYTES = { object: 50, columnText: 50, columnHeading: 60 } as const;

export interface LabelUse {
  file: string;
  target: string;
  kind: 'object' | 'columnText' | 'columnHeading';
  text: string;
  bytes: number;
}

export interface MigrationSummary {
  version: number;
  file: string;
  tables: string[];
  columns: string[];
  constraints: string[];
  droppedConstraints: string[];
  indexes: string[];
  labels: string[];
}
export interface ExpectedSchema {
  tables: ExpectedTable[];
  columns: ExpectedColumn[];
  constraints: ExpectedConstraint[];
  indexes: ExpectedIndex[];
  migrations: MigrationSummary[];
  labels: LabelUse[];
  unparsed: { file: string; statement: string }[];
}

const ID = '([A-Z][A-Z0-9_#@$]*)';
const PLACEHOLDER = 'QFX_SCHEMA';

/** Split on commas that are not inside parentheses or string literals. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'"))
        j += text[j] === "'" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const literals = (clause: string) => [...clause.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);

function parseConstraint(
  def: string,
  table: string,
  migration: number,
): ExpectedConstraint | undefined {
  const m = new RegExp(`^CONSTRAINT\\s+${ID}\\s+(.*)$`, 's').exec(def);
  if (!m) return undefined;
  const [, name, rest] = m;
  if (/^PRIMARY\s+KEY\b/.test(rest)) return { name, table, type: 'PRIMARY KEY', migration };
  if (/^UNIQUE\b/.test(rest)) return { name, table, type: 'UNIQUE', migration };
  if (/^CHECK\b/.test(rest))
    return { name, table, type: 'CHECK', migration, checkLiterals: literals(rest) };
  if (/^FOREIGN\s+KEY\b/.test(rest)) {
    const ref = new RegExp(`REFERENCES\\s+${PLACEHOLDER}\\.${ID}`).exec(rest);
    const del = /ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/.exec(rest);
    return {
      name,
      table,
      type: 'FOREIGN KEY',
      migration,
      referencesTable: ref?.[1],
      deleteRule: (del?.[1].replace(/\s+/g, ' ') ?? 'NO ACTION') as DeleteRule,
    };
  }
  return undefined;
}

const labelUse = (
  file: string,
  target: string,
  kind: LabelUse['kind'],
  text: string,
): LabelUse => ({
  file,
  target,
  kind,
  text,
  bytes: Buffer.byteLength(text, 'utf8'),
});

/** Static Db2 for i checks that need no connection: label lengths and unparsed statements. */
export function lintMigrations(schema: ExpectedSchema = expectedSchema()): string[] {
  const issues: string[] = [];
  for (const l of schema.labels) {
    const max = LABEL_LIMIT_BYTES[l.kind];
    if (l.bytes > max)
      issues.push(
        `${l.file}: LABEL ON ${l.target} is ${l.bytes} bytes; Db2 for i allows ${max} for this label.`,
      );
  }
  for (const u of schema.unparsed)
    issues.push(`${u.file}: the verification kit does not recognise: ${u.statement.slice(0, 120)}`);
  return issues;
}

/** Build the expected end state of the metadata schema after every migration has run. */
export function expectedSchema(migrations: MigrationFile[] = loadMigrations(PLACEHOLDER)) {
  const tables = new Map<string, ExpectedTable>();
  const columns = new Map<string, ExpectedColumn>();
  const constraints = new Map<string, ExpectedConstraint>();
  const indexes = new Map<string, ExpectedIndex>();
  const summaries: MigrationSummary[] = [];
  const unparsed: ExpectedSchema['unparsed'] = [];
  const labels: LabelUse[] = [];
  const S = PLACEHOLDER;

  for (const mig of migrations) {
    const sum: MigrationSummary = {
      version: mig.version,
      file: mig.file,
      tables: [],
      columns: [],
      constraints: [],
      droppedConstraints: [],
      indexes: [],
      labels: [],
    };
    for (const raw of mig.statements) {
      // Normalise whitespace outside string literals is unnecessary for these patterns; just collapse it.
      const stmt = raw.replace(/\s+/g, ' ').trim();
      const upper = stmt.toUpperCase();
      let m: RegExpExecArray | null;
      if ((m = new RegExp(`^CREATE TABLE ${S}\\.${ID} \\((.*)\\)$`, 's').exec(upper))) {
        const table = m[1];
        tables.set(table, { name: table, migration: mig.version });
        sum.tables.push(table);
        // Use the original text for the body so CHECK literals keep their case.
        const body = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
        for (const el of splitTopLevel(body)) {
          const elU = el.toUpperCase();
          if (elU.startsWith('CONSTRAINT ')) {
            const c = parseConstraint(el.replace(/^constraint/i, 'CONSTRAINT'), table, mig.version);
            if (!c) unparsed.push({ file: mig.file, statement: el });
            else {
              const fixed = { ...c, name: c.name.toUpperCase() };
              constraints.set(fixed.name, fixed);
              sum.constraints.push(fixed.name);
            }
          } else {
            const col = /^([A-Za-z][A-Za-z0-9_#@$]*)\s/.exec(el);
            if (!col) unparsed.push({ file: mig.file, statement: el });
            else {
              const name = col[1].toUpperCase();
              columns.set(`${table}.${name}`, { table, name, migration: mig.version });
            }
          }
        }
      } else if ((m = new RegExp(`^ALTER TABLE ${S}\\.${ID} ADD COLUMN ${ID}\\b`).exec(upper))) {
        columns.set(`${m[1]}.${m[2]}`, { table: m[1], name: m[2], migration: mig.version });
        sum.columns.push(`${m[1]}.${m[2]}`);
      } else if ((m = new RegExp(`^ALTER TABLE ${S}\\.${ID} DROP CONSTRAINT ${ID}$`).exec(upper))) {
        constraints.delete(m[2]);
        sum.droppedConstraints.push(m[2]);
      } else if (
        (m = new RegExp(`^ALTER TABLE ${S}\\.${ID} ADD (CONSTRAINT .*)$`, 's').exec(upper))
      ) {
        const table = m[1];
        const def = stmt.slice(upper.indexOf(' ADD CONSTRAINT ') + 5);
        const c = parseConstraint(def.replace(/^constraint/i, 'CONSTRAINT'), table, mig.version);
        if (!c) unparsed.push({ file: mig.file, statement: raw });
        else {
          constraints.set(c.name.toUpperCase(), { ...c, name: c.name.toUpperCase() });
          sum.constraints.push(c.name.toUpperCase());
        }
      } else if (
        (m = new RegExp(
          `^CREATE (UNIQUE WHERE NOT NULL |UNIQUE )?INDEX ${S}\\.${ID} ON ${S}\\.${ID}\\b`,
        ).exec(upper))
      ) {
        const unique: IndexUniqueRule = !m[1] ? 'D' : m[1].includes('WHERE') ? 'V' : 'U';
        indexes.set(m[2], { name: m[2], table: m[3], unique, migration: mig.version });
        sum.indexes.push(m[2]);
      } else if (
        (m = new RegExp(`^LABEL ON TABLE ${S}\\.${ID} IS '((?:[^']|'')*)'$`).exec(upper))
      ) {
        const t = tables.get(m[1]);
        const text = /IS '((?:[^']|'')*)'$/.exec(stmt)?.[1].replaceAll("''", "'") ?? '';
        if (t) t.label = text;
        else unparsed.push({ file: mig.file, statement: raw });
        sum.labels.push(m[1]);
        labels.push(labelUse(mig.file, m[1], 'object', text));
      } else if (
        (m = new RegExp(`^LABEL ON COLUMN ${S}\\.${ID}\\.${ID} (TEXT )?IS '((?:[^']|'')*)'$`).exec(
          upper,
        ))
      ) {
        const text = /'((?:[^']|'')*)'$/.exec(stmt)?.[1].replaceAll("''", "'") ?? '';
        labels.push(
          labelUse(mig.file, `${m[1]}.${m[2]}`, m[3] ? 'columnText' : 'columnHeading', text),
        );
        sum.labels.push(`${m[1]}.${m[2]}`);
      } else if (
        (m = new RegExp(`^LABEL ON (INDEX|CONSTRAINT) ${S}\\.${ID} IS '((?:[^']|'')*)'$`).exec(
          upper,
        ))
      ) {
        const text = /'((?:[^']|'')*)'$/.exec(stmt)?.[1].replaceAll("''", "'") ?? '';
        labels.push(labelUse(mig.file, m[2], 'object', text));
        sum.labels.push(m[2]);
      } else if ((m = new RegExp(`^DROP INDEX ${S}\\.${ID}$`).exec(upper))) {
        indexes.delete(m[1]);
      } else if ((m = new RegExp(`^DROP TABLE ${S}\\.${ID}$`).exec(upper))) {
        tables.delete(m[1]);
        for (const [k, c] of columns) if (c.table === m[1]) columns.delete(k);
        for (const [k, c] of constraints) if (c.table === m[1]) constraints.delete(k);
        for (const [k, i] of indexes) if (i.table === m[1]) indexes.delete(k);
      } else unparsed.push({ file: mig.file, statement: raw });
    }
    summaries.push(sum);
  }
  return {
    tables: [...tables.values()],
    columns: [...columns.values()],
    constraints: [...constraints.values()],
    indexes: [...indexes.values()],
    migrations: summaries,
    labels,
    unparsed,
  } satisfies ExpectedSchema;
}
