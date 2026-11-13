/**
 * Apply Db2 for i metadata migrations through Mapepire.
 *   npm run migrate                    apply pending migrations
 *   npm run migrate -- --create-schema also CREATE SCHEMA <META_SCHEMA> (needs authority)
 *   npm run migrate -- --print         print SQL only, connect to nothing
 * Connects as MIGRATE_DB_USER/MIGRATE_DB_PASSWORD when set, otherwise as META_DB_USER.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/config.js';
import { openJob, metadataJdbcOptions, readAllRows } from '../src/db/mapepire.js';
import { loadMigrations, versionTableDdl } from '../src/db/migration-files.js';
import { T, NOW_UTC } from '../src/db/schema.js';

export { loadMigrations, splitStatements } from '../src/db/migration-files.js';

const args = new Set(process.argv.slice(2));

async function main() {
  const cfg = loadConfig();
  const schema = cfg.metadata.schema;
  const migrations = loadMigrations(schema);
  const versionDdl = versionTableDdl(schema);

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
      // every applied version, not just the first 100 that job.execute() returns
      (
        await readAllRows<{ VERSION: number }>(job, `SELECT VERSION FROM ${schema}.${T.version}`)
      ).map((r) => Number(r.VERSION)),
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
    for (const table of Object.values(T)) {
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
