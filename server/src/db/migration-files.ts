import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/migrations, resolved from this file in both src/ (tsx) and dist/ (build). */
export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

export interface MigrationFile {
  version: number;
  file: string;
  statements: string[];
}

/** Read every `NNN_*.sql` migration in order with `{{SCHEMA}}` replaced by `schema`. */
export function loadMigrations(schema: string, dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      version: Number(file.slice(0, 3)),
      file,
      statements: splitStatements(
        readFileSync(join(dir, file), 'utf8').replaceAll('{{SCHEMA}}', schema),
      ),
    }));
}

/** Split a migration script on top-level semicolons, ignoring those inside strings, delimited identifiers and comments. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      cur += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      cur += ' ';
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === ch && text[j + 1] !== ch))
        j += text[j] === ch ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The migration bookkeeping table, created by the migration runner rather than by a migration file. */
export const VERSION_TABLE = 'QF_SCHEMA_VERSION';

export const versionTableDdl = (schema: string) =>
  `CREATE TABLE ${schema}.${VERSION_TABLE} (VERSION INTEGER NOT NULL PRIMARY KEY, FILE_NAME VARCHAR(200) NOT NULL, APPLIED_AT TIMESTAMP NOT NULL)`;
