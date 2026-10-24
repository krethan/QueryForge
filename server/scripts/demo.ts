/**
 * DEV-ONLY DEMO MODE — `npm run demo` (from the repo root).
 *
 * Starts QueryForge entirely in memory: the metadata store and the Mapepire SQL job are the
 * test fakes from test/helpers, so it never opens a network connection to any IBM i system.
 * All data is obviously fictional. It ignores .env, refuses NODE_ENV=production, and binds to
 * 127.0.0.1 only. It is never enabled by `npm start` or `npm run dev`.
 */
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import bcrypt from 'bcryptjs';
import { ReportRepository } from '../src/reports/reports.js';
import { FakeMetadataDb } from '../test/helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from '../test/helpers/fake-mapepire.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.NODE_ENV === 'production') {
  console.error('Demo mode is development-only and refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const PORT = Number(process.env.DEMO_PORT ?? 3005);
const origin = `http://127.0.0.1:${PORT}`;
const cfg = loadConfig({
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  APP_ORIGIN: origin,
  MAPEPIRE_HOST: 'demo.invalid', // never contacted: the fake job factory below is used instead
  IBMI_DISPLAY_NAME: 'DEMO (in-memory fake — no IBM i)',
  REPORT_DB_USER: 'DEMORPT',
  REPORT_DB_PASSWORD: 'demo-not-a-secret',
  REPORT_DEFAULT_SCHEMA: 'DEMOLIB',
  META_DB_USER: 'DEMOAPP',
  META_DB_PASSWORD: 'demo-not-a-secret',
  META_SCHEMA: 'QFMETA',
  SESSION_SECRET: 'demo-only-session-secret-not-for-real-use-000',
  COOKIE_SECURE: 'false',
} as NodeJS.ProcessEnv);

const customers = [
  'Acme Widgets (FAKE)',
  'Globex Demo Co',
  'Initech Sample',
  'Umbrella Test Ltd',
  'Hooli Example',
];
const regions = ['North', 'South', 'East', 'West'];

function script(sql: string): Scripted {
  const s = sql.toUpperCase();
  if (s === '__CONNECT__' || s.includes('SYSIBM.SYSDUMMY1'))
    return { columns: [col('X', 'INTEGER')], rows: [[1]] };
  if (s.includes('.CUSTOMERS')) {
    return {
      columns: [
        col('CUSTNO', 'INTEGER'),
        col('NAME', 'VARCHAR', 40),
        col('REGION', 'CHAR', 5),
        col('CREDIT_LIMIT', 'DECIMAL', 11, 2),
        col('LAST_ORDER', 'DATE'),
      ],
      rows: customers.map((n, i) => [
        1000 + i,
        n,
        regions[i % 4],
        (i + 1) * 12500.5,
        i === 3 ? null : `2026-0${i + 4}-1${i}`,
      ]),
    };
  }
  if (s.includes('.INVENTORY')) {
    return {
      columns: [
        col('ITEM', 'CHAR', 8),
        col('DESCRIPTION', 'VARCHAR', 40),
        col('ON_HAND', 'INTEGER'),
        col('REORDER_POINT', 'INTEGER'),
      ],
      rows: Array.from({ length: 12 }, (_, i) => [
        `SKU-${String(i + 1).padStart(4, '0')}`,
        `Sample widget #${i + 1}`,
        (i * 37) % 90,
        25,
      ]),
    };
  }
  // Default: fake orders
  return {
    columns: [
      col('ORDER_ID', 'INTEGER'),
      col('CUSTOMER', 'VARCHAR', 40),
      col('REGION', 'CHAR', 5),
      col('ORDER_DATE', 'DATE'),
      col('AMOUNT', 'DECIMAL', 11, 2),
      col('STATUS', 'VARCHAR', 10),
      col('NOTE', 'VARCHAR', 60),
    ],
    rows: Array.from({ length: 64 }, (_, i) => [
      50001 + i,
      customers[i % customers.length],
      regions[i % 4],
      `2026-10-${String((i % 22) + 1).padStart(2, '0')}`,
      Math.round((((i * 7919) % 50000) / 7 + 19.99) * 100) / 100,
      ['OPEN', 'SHIPPED', 'BILLED'][i % 3],
      i % 5 === 0 ? null : i % 7 === 0 ? '' : 'Demo data — not real',
    ]),
    delayMs: 150,
  };
}

async function main() {
  const metadataDb = new FakeMetadataDb();
  const reports = new ReportRepository(metadataDb, cfg.metadata.schema);
  metadataDb.addUser({
    id: 'u-demo',
    username: 'demo',
    displayName: 'Demo User',
    role: 'ADMIN',
    hash: await bcrypt.hash('demo-password-123', 10),
  });
  const user = { id: 'u-demo' };
  const seed = [
    {
      name: 'Open Orders by Region',
      category: 'Sales',
      description: 'Fake orders not yet shipped',
      sql: "SELECT ORDER_ID, CUSTOMER, REGION, ORDER_DATE, AMOUNT, STATUS, NOTE\nFROM DEMOLIB.ORDERS\nWHERE STATUS = 'OPEN'\nORDER BY ORDER_DATE DESC",
    },
    {
      name: 'Customer Credit Limits',
      category: 'Finance',
      description: 'Sample customers and credit limits',
      sql: 'SELECT CUSTNO, NAME, REGION, CREDIT_LIMIT, LAST_ORDER\nFROM DEMOLIB.CUSTOMERS\nORDER BY CREDIT_LIMIT DESC',
    },
    {
      name: 'Low Inventory',
      category: 'Operations',
      description: 'Items at or below reorder point',
      sql: 'SELECT ITEM, DESCRIPTION, ON_HAND, REORDER_POINT\nFROM DEMOLIB.INVENTORY\nWHERE ON_HAND <= REORDER_POINT',
    },
    {
      name: 'October Sales Summary',
      category: 'Sales',
      description: 'Monthly totals (fake data)',
      sql: "SELECT ORDER_ID, CUSTOMER, REGION, ORDER_DATE, AMOUNT, STATUS, NOTE\nFROM DEMOLIB.ORDERS\nWHERE ORDER_DATE >= DATE('2026-10-01')",
    },
  ];
  for (const r of seed) await reports.create(user.id, r);

  const { factory } = fakeFactory(script);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { app } = createApp({
    cfg,
    metadataDb,
    jobFactory: factory,
    staticDir: path.resolve(here, '../../web/dist'),
  });
  app.listen(PORT, '127.0.0.1', () => {
    console.log(
      `QueryForge DEMO (in-memory, no IBM i) on ${origin}  — login: demo / demo-password-123`,
    );
  });
}
void main();
