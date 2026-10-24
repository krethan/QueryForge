/**
 * Apply Db2 for i metadata migrations through Mapepire.
 *   npm run migrate                    apply pending migrations
 *   npm run migrate -- --create-schema also CREATE SCHEMA <META_SCHEMA> (needs authority)
 *   npm run migrate -- --print         print SQL only, connect to nothing
 * Connects as MIGRATE_DB_USER/MIGRATE_DB_PASSWORD when set, otherwise as META_DB_USER.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/config.js';
import { openJob, metadataJdbcOptions } from '../src/db/mapepire.js';
import { T, NOW_UTC } from '../src/db/schema.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const args = new Set(process.argv.slice(2));

export function loadMigrations(schema: string) {
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

async function main() {
  const cfg = loadConfig();
  const schema = cfg.metadata.schema;
  const migrations = loadMigrations(schema);
  const versionDdl = `CREATE TABLE ${schema}.${T.version} (VERSION INTEGER NOT NULL PRIMARY KEY, FILE_NAME VARCHAR(200) NOT NULL, APPLIED_AT TIMESTAMP NOT NULL)`;

  if (args.has('--print')) {
    if (args.has('--create-schema')) console.log(`CREATE SCHEMA ${schema};\n`);
    console.log(`${versionDdl};\n`);
    for (const m of migrations) {
      console.log(`-- ${m.file}`);
      for (const s of m.statements) console.log(`${s};\n`);
    }
    return;
  }

  const identity = process.env.MIGRATE_DB_USER
    ? { user: process.env.MIGRATE_DB_USER, password: process.env.MIGRATE_DB_PASSWORD ?? '' }
    : cfg.metadata;
  const grantTo =
    identity.user.toUpperCase() !== cfg.metadata.user.toUpperCase()
      ? cfg.metadata.user.toUpperCase()
      : null;
  const job = await openJob(cfg, identity, { ...metadataJdbcOptions(cfg), libraries: [] });
  try {
    const exists = async (table: string) =>
      ((
        await job.execute<{ N: number }>(
          'SELECT COUNT(*) AS N FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
          { parameters: [schema, table] },
        )
      ).data[0]?.N ?? 0) > 0;

    if (args.has('--create-schema')) {
      const s = await job.execute<{ N: number }>(
        'SELECT COUNT(*) AS N FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = ?',
        { parameters: [schema] },
      );
      if ((s.data[0]?.N ?? 0) === 0) {
        console.log(`Creating schema ${schema}`);
        await job.execute(`CREATE SCHEMA ${schema}`);
      }
    }
    if (!(await exists(T.version))) {
      console.log(`Creating ${schema}.${T.version}`);
      await job.execute(versionDdl);
    }
    const applied = new Set(
      (
        await job.execute<{ VERSION: number }>(`SELECT VERSION FROM ${schema}.${T.version}`)
      ).data.map((r) => Number(r.VERSION)),
    );
    for (const m of migrations) {
      if (applied.has(m.version)) {
        console.log(`= ${m.file} (already applied)`);
        continue;
      }
      console.log(`+ ${m.file}`);
      for (const stmt of m.statements) await job.execute(stmt);
      await job.execute(
        `INSERT INTO ${schema}.${T.version} (VERSION, FILE_NAME, APPLIED_AT) VALUES (?, ?, ${NOW_UTC})`,
        {
          parameters: [m.version, m.file],
        },
      );
    }
    for (const table of [T.users, T.reports, T.executions, T.version]) {
      await job
        .execute(`REVOKE ALL ON ${schema}.${table} FROM PUBLIC`)
        .catch((e) => console.warn(`REVOKE ${table}: ${e.message}`));
      if (grantTo) {
        const privs = table === T.version ? 'SELECT' : 'SELECT, INSERT, UPDATE, DELETE';
        await job.execute(`GRANT ${privs} ON ${schema}.${table} TO ${grantTo}`);
      }
    }
    console.log('Migrations complete.');
  } finally {
    await job.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`Migration failed: ${e.message}`);
    process.exit(1);
  });
}
