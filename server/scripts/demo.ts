/**
 * DEV-ONLY DEMO MODE — `npm run demo` (from the repo root).
 *
 * Starts QueryForge entirely in memory: the metadata store and the Mapepire SQL job are the
 * test fakes from test/helpers, so it never opens a network connection to any IBM i system.
 * All data is obviously fictional. It ignores .env, refuses NODE_ENV=production, and binds to
 * 127.0.0.1 only. It is never enabled by `npm start` or `npm run dev`.
 *
 * SSO, LDAP and e-mail are in-memory fakes too (test/helpers/fake-auth.ts and MemoryMailer):
 * "Sign in with SSO" signs in a fictional user without contacting any identity provider,
 * the directory login accepts dave / directory-pass, and scheduled e-mails are only kept in
 * memory (logged to the console), never sent.
 */
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import bcrypt from 'bcryptjs';
import { ReportRepository } from '../src/reports/reports.js';
import { FakeMetadataDb } from '../test/helpers/fake-metadata-db.js';
import { col, fakeFactory, type Scripted } from '../test/helpers/fake-mapepire.js';
import { fileURLToPath } from 'node:url';
import { FakeLdap, FakeOidc } from '../test/helpers/fake-auth.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { validateCron } from '../src/scheduler/cron.js';
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
  GROUP_MAP: 'Finance-Readers=finance;Sales-Team=sales;QF Admins=qf-admins',
  ADMIN_GROUPS: 'qf-admins',
  SCHEDULER_ENABLED: 'true',
  SCHEDULE_RECIPIENT_DOMAINS: 'example.com',
  SCHEDULE_DEFAULT_TIMEZONE: 'America/Edmonton',
  SMTP_HOST: 'smtp.demo.invalid', // never contacted: MemoryMailer is injected below
  SMTP_FROM: 'queryforge-demo@example.com',
} as NodeJS.ProcessEnv);

const customers = [
  'Acme Widgets (FAKE)',
  'Globex Demo Co',
  'Initech Sample',
  'Umbrella Test Ltd',
  'Hooli Example',
];
const regions = ['North', 'South', 'East', 'West'];

/** Fake QSYS2 catalog content for the Report Builder (DEMOLIB has no real catalog). */
const catalogTables = [
  {
    schema: 'DEMOLIB',
    name: 'ORDERS',
    type: 'T',
    text: 'Customer orders (fake)',
    columns: [
      ['ORDER_ID', 'INTEGER', 4, 10, 0, 'N', 'Order number'],
      ['CUSTOMER', 'VARCHAR', 40, null, null, 'Y', 'Customer name'],
      ['REGION', 'CHAR', 5, null, null, 'Y', 'Sales region'],
      ['ORDER_DATE', 'DATE', 4, null, null, 'Y', 'Order date'],
      ['AMOUNT', 'DECIMAL', 11, 11, 2, 'Y', 'Order total'],
      ['STATUS', 'VARCHAR', 10, null, null, 'Y', 'OPEN, SHIPPED or BILLED'],
      ['NOTE', 'VARCHAR', 60, null, null, 'Y', 'Free-text note'],
    ],
  },
  {
    schema: 'DEMOLIB',
    name: 'CUSTOMERS',
    type: 'T',
    text: 'Sample customers (fake)',
    columns: [
      ['CUSTNO', 'INTEGER', 4, 10, 0, 'N', 'Customer number'],
      ['NAME', 'VARCHAR', 40, null, null, 'Y', 'Customer name'],
      ['REGION', 'CHAR', 5, null, null, 'Y', 'Sales region'],
      ['CREDIT_LIMIT', 'DECIMAL', 11, 11, 2, 'Y', 'Credit limit'],
      ['LAST_ORDER', 'DATE', 4, null, null, 'Y', 'Date of last order'],
    ],
  },
  {
    schema: 'DEMOLIB',
    name: 'INVENTORY',
    type: 'P',
    text: 'Stock on hand (legacy physical file, fake)',
    columns: [
      ['ITEM', 'CHAR', 8, null, null, 'N', 'Item code'],
      ['DESCRIPTION', 'VARCHAR', 40, null, null, 'Y', 'Item description'],
      ['ON_HAND', 'INTEGER', 4, 10, 0, 'Y', 'Units on hand'],
      ['REORDER_POINT', 'INTEGER', 4, 10, 1, 'Y', 'Reorder threshold'],
    ],
  },
  {
    schema: 'DEMOLIB',
    name: 'OPEN_ORDERS',
    type: 'V',
    text: 'Orders not yet shipped (view, fake)',
    columns: [
      ['ORDER_ID', 'INTEGER', 4, 10, 0, 'N', 'Order number'],
      ['CUSTOMER', 'VARCHAR', 40, null, null, 'Y', 'Customer name'],
      ['AMOUNT', 'DECIMAL', 11, 11, 2, 'Y', 'Order total'],
    ],
  },
  {
    schema: 'DEMOLIB',
    name: 'LEDGER',
    type: 'T',
    text: 'General ledger (fake)',
    columns: [
      ['ENTRY_ID', 'BIGINT', 8, 19, 0, 'N', 'Ledger entry'],
      ['ACCOUNT', 'CHAR', 6, null, null, 'N', 'Account code'],
      ['BALANCE', 'DECIMAL', 16, 31, 2, 'Y', 'Balance'],
      ['FX_RATE', 'DECIMAL', 8, 9, 6, 'Y', 'Exchange rate'],
    ],
  },
  {
    schema: 'DEMOLIB',
    name: 'ORDER_LINES',
    type: 'T',
    text: 'Order detail lines (fake)',
    columns: [
      ['LINE_ID', 'INTEGER', 4, 10, 0, 'N', 'Line number'],
      ['ORDER_ID', 'INTEGER', 4, 10, 0, 'N', 'Order number'],
      ['ITEM', 'CHAR', 8, null, null, 'N', 'Item code'],
      ['QTY', 'INTEGER', 4, 10, 0, 'Y', 'Quantity'],
      ['EXTENDED', 'DECIMAL', 13, 13, 2, 'Y', 'Extended price'],
    ],
  },
];

function catalogScript(s: string, parameters?: unknown[]): Scripted | null {
  if (!s.includes('QSYS2.SYSTABLES') && !s.includes('QSYS2.SYSCOLUMNS')) return null;
  // The fake job does not evaluate predicates, so apply the bound values here.
  const bound = (parameters ?? []).map((p) => String(p ?? '').toUpperCase());
  if (s.includes('QSYS2.SYSCOLUMNS')) {
    const wanted = catalogTables.find((t) => t.schema === bound[0] && t.name === bound[1]);
    return {
      columns: [
        col('COLUMN_NAME', 'VARCHAR', 128),
        col('DATA_TYPE', 'VARCHAR', 8),
        col('LENGTH', 'INTEGER'),
        col('NUMERIC_PRECISION', 'INTEGER'),
        col('NUMERIC_SCALE', 'INTEGER'),
        col('IS_NULLABLE', 'CHAR', 1),
        col('COLUMN_TEXT', 'VARCHAR', 50),
        col('ORDINAL_POSITION', 'INTEGER'),
      ],
      rows: (wanted ? [wanted] : catalogTables).flatMap((t) =>
        t.columns.map((c, i) => [c[0], c[1], c[2], c[3], c[4], c[5], c[6], i + 1]),
      ),
    };
  }
  return {
    columns: [
      col('TABLE_SCHEMA', 'VARCHAR', 128),
      col('TABLE_NAME', 'VARCHAR', 128),
      col('TABLE_TYPE', 'CHAR', 1),
      col('TABLE_TEXT', 'VARCHAR', 50),
      col('TABLE_OWNER', 'VARCHAR', 128),
    ],
    rows: catalogTables
      .filter((t) => {
        const exact = bound.filter((p) => p === t.schema || p === t.name);
        const like = bound
          .filter((p) => p.startsWith('%') && p.endsWith('%'))
          .map((p) => p.slice(1, -1));
        if (exact.length && !exact.includes(t.schema) && !exact.includes(t.name)) return false;
        if (like.length && !like.some((n) => t.name.includes(n) || t.schema.includes(n)))
          return false;
        return true;
      })
      .map((t) => [t.schema, t.name, t.type, t.text, 'DEMOUSER']),
  };
}

/** Column names in a `SELECT "A", "B"\nFROM …` list, in order (empty for other statements). */
function selectList(sql: string): string[] {
  const m = /^SELECT\s+([\s\S]+?)\s*\nFROM\s/i.exec(sql);
  if (!m) return [];
  return [...m[1].matchAll(/"((?:[^"]|"")*)"/g)].map((x) => x[1].replace(/""/g, '"'));
}

/**
 * The fake job does not parse SQL, so apply the parts of a Report Builder statement
 * that matter for a believable demo: the SELECT list and the ORDER BY direction.
 */
function shaped(s: Scripted, sql: string): Scripted {
  const names = selectList(sql);
  if (!names.length) return s;
  const idx = names.map((n) => s.columns.findIndex((c) => c.name === n));
  if (idx.some((i) => i < 0)) return s;
  let rows = s.rows.map((r) => idx.map((i) => r[i]));
  const order = /\nORDER BY\s+([\s\S]+)$/i.exec(sql);
  if (order) {
    const keys = [...order[1].matchAll(/"((?:[^"]|"")*)"\s+(ASC|DESC)/gi)].map((x) => ({
      index: names.indexOf(x[1].replace(/""/g, '"')),
      dir: x[2].toUpperCase() === 'DESC' ? -1 : 1,
    }));
    const usable = keys.filter((k) => k.index >= 0);
    if (usable.length)
      rows = [...rows].sort((a, b) => {
        for (const k of usable) {
          const x = a[k.index];
          const y = b[k.index];
          if (x === y) continue;
          // NULLs last in both directions, like Db2 for i's default
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          const c =
            typeof x === 'number' && typeof y === 'number'
              ? x - y
              : String(x).localeCompare(String(y));
          if (c) return c * k.dir;
        }
        return 0;
      });
  }
  return { ...s, columns: idx.map((i) => s.columns[i]), rows };
}

function script(sql: string, parameters?: unknown[]): Scripted {
  const s = sql.toUpperCase();
  if (s === '__CONNECT__' || s.includes('SYSIBM.SYSDUMMY1'))
    return { columns: [col('X', 'INTEGER')], rows: [[1]] };
  const catalog = catalogScript(s, parameters);
  if (catalog) return catalog;
  return shaped(dataScript(sql), sql);
}

function dataScript(sql: string): Scripted {
  const s = sql.toUpperCase();
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
  if (s.includes('.LEDGER')) {
    // DECIMAL(31,2) and BIGINT values beyond 2^53, delivered as exact strings the way
    // @ibm/mapepire-js 1.0.2 does on Node.js 22+ (JSON.parse source-text access).
    return {
      columns: [
        col('ENTRY_ID', 'BIGINT', 19),
        col('ACCOUNT', 'CHAR', 6),
        col('BALANCE', 'DECIMAL', 31, 2),
        col('FX_RATE', 'DECIMAL', 9, 6),
      ],
      rows: Array.from({ length: 8 }, (_, i) => [
        `90071992547409${String(91 + i * 3).padStart(2, '0')}`,
        `GL${String(1000 + i * 10)}`,
        i % 3 === 0
          ? `${i % 2 ? '-' : ''}1234567890123456789${i}.${String(i * 7).padStart(2, '0')}`
          : `${(i + 1) * 1050}.25`,
        (1 + i / 8).toFixed(6),
      ]),
    };
  }
  if (s.includes('.ORDER_LINES')) {
    return {
      columns: [
        col('LINE_ID', 'INTEGER'),
        col('ORDER_ID', 'INTEGER'),
        col('ITEM', 'CHAR', 8),
        col('QTY', 'INTEGER'),
        col('EXTENDED', 'DECIMAL', 13, 2),
      ],
      rows: Array.from({ length: 1200 }, (_, i) => [
        i + 1,
        50001 + (i % 64),
        `SKU-${String((i % 12) + 1).padStart(4, '0')}`,
        (i % 9) + 1,
        (((i * 131) % 9000) / 3 + 5).toFixed(2),
      ]),
      delayMs: 60,
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
  seed.push(
    {
      name: 'GL Balances (exact decimals)',
      category: 'Finance',
      description: 'DECIMAL(31,2) and BIGINT values kept exact end to end',
      sql: 'SELECT ENTRY_ID, ACCOUNT, BALANCE, FX_RATE\nFROM DEMOLIB.LEDGER\nORDER BY ENTRY_ID',
    },
    {
      name: 'All Order Lines (1,200 rows)',
      category: 'Operations',
      description: 'Large result: loaded page by page from a server cursor',
      sql: 'SELECT LINE_ID, ORDER_ID, ITEM, QTY, EXTENDED\nFROM DEMOLIB.ORDER_LINES\nORDER BY LINE_ID',
    },
  );
  const created = [];
  for (const r of seed) created.push(await reports.create(user.id, r));
  const parameterized = await reports.create(user.id, {
    name: 'Orders by Region and Date',
    category: 'Sales',
    description: 'Parameterized: values are bound as Mapepire ? markers',
    sql: 'SELECT ORDER_ID, CUSTOMER, REGION, ORDER_DATE, AMOUNT, STATUS\nFROM DEMOLIB.ORDERS\nWHERE REGION = ?\n  AND ORDER_DATE >= ?\n  AND AMOUNT >= ?\nORDER BY ORDER_DATE DESC',
    parameters: [
      {
        name: 'region',
        label: 'Region',
        type: 'list',
        required: true,
        defaultValue: 'North',
        options: regions.map((value) => ({ value })),
      },
      {
        name: 'since',
        label: 'Orders since',
        type: 'date',
        required: true,
        defaultValue: '2026-10-01',
      },
      {
        name: 'minAmount',
        label: 'Minimum amount',
        type: 'decimal',
        required: false,
        defaultValue: '0',
      },
    ],
  });

  // a second (fictional) user who owns reports shared with the demo user
  metadataDb.addUser({
    id: 'u-pat',
    username: 'pat',
    displayName: 'Pat Analyst (fake)',
    hash: await bcrypt.hash('pat-demo-password', 10),
  });
  metadataDb.addUser({
    id: 'u-sam',
    username: 'sam',
    displayName: 'Sam Finance (fake)',
    hash: await bcrypt.hash('sam-demo-password', 10),
  });
  metadataDb.addGroup('u-demo', 'sales', 'LOCAL');
  metadataDb.addGroup('u-sam', 'finance', 'LOCAL');
  const patOwned = [
    await reports.create('u-pat', {
      name: 'Regional Pipeline (Pat)',
      category: 'Sales',
      description: 'Shared with the sales group as EDITOR',
      sql: 'SELECT REGION, COUNT(*) AS ORDERS, SUM(AMOUNT) AS TOTAL\nFROM DEMOLIB.ORDERS\nGROUP BY REGION',
    }),
    await reports.create('u-pat', {
      name: 'Inventory Watchlist (Pat)',
      category: 'Operations',
      description: 'Shared with Demo User as VIEWER',
      sql: 'SELECT ITEM, DESCRIPTION, ON_HAND, REORDER_POINT\nFROM DEMOLIB.INVENTORY',
    }),
  ];

  const mailer = new MemoryMailer();
  const origSend = mailer.send.bind(mailer);
  mailer.send = async (m) => {
    const r = await origSend(m);
    console.log(
      `[demo mail — not sent] to=${m.to.join(',')} subject="${m.subject}" attachments=${m.attachments.map((a) => a.filename).join(',')}`,
    );
    return r;
  };

  const { factory } = fakeFactory(script);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { app, access, schedules } = createApp({
    cfg,
    metadataDb,
    jobFactory: factory,
    staticDir: path.resolve(here, '../../web/dist'),
    oidc: new FakeOidc('Contoso SSO (demo fake)', {
      source: 'OIDC',
      externalId: 'https://idp.demo.invalid|sub-carol',
      username: 'carol@example.com',
      displayName: 'Carol SSO (fake)',
      email: 'carol@example.com',
      groups: ['Finance-Readers'],
    }),
    ldap: new FakeLdap('Corporate directory (demo fake)'),
    mailer,
  });
  const exists = async (id: string) => metadataDb.users.has(id);
  await access.replaceShares(
    created[1],
    'u-demo',
    [
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
      { type: 'USER', id: 'u-pat', role: 'EDITOR' },
    ],
    exists,
  );
  // a little sharing history for the audit panel
  await access.replaceShares(
    created[1],
    'u-demo',
    [
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
      { type: 'USER', id: 'u-pat', role: 'VIEWER' },
      { type: 'USER', id: 'u-sam', role: 'EDITOR' },
    ],
    exists,
  );
  await access.replaceShares(
    created[1],
    'u-demo',
    [
      { type: 'GROUP', id: 'finance', role: 'VIEWER' },
      { type: 'USER', id: 'u-pat', role: 'VIEWER' },
    ],
    exists,
  );
  await access.replaceShares(
    patOwned[0],
    'u-pat',
    [{ type: 'GROUP', id: 'sales', role: 'EDITOR' }],
    exists,
  );
  await access.replaceShares(
    patOwned[1],
    'u-pat',
    [{ type: 'USER', id: 'u-demo', role: 'VIEWER' }],
    exists,
  );
  const weekly = {
    cron: '0 7 * * 1',
    timezone: 'America/Edmonton',
    recipients: ['sales-leads@example.com', 'ops@example.com'],
    parameters: { region: 'West', since: '2026-10-01' },
    enabled: true,
  };
  await schedules.create(
    parameterized.id,
    'u-demo',
    weekly,
    validateCron(weekly.cron, weekly.timezone, 15)[0],
  );
  const daily = {
    cron: '30 6 * * 1-5',
    timezone: 'America/Edmonton',
    recipients: ['finance@example.com'],
    parameters: {},
    enabled: false,
  };
  await schedules.create(
    created[1].id,
    'u-demo',
    daily,
    validateCron(daily.cron, daily.timezone, 15)[0],
  );

  app.listen(PORT, '127.0.0.1', () => {
    console.log(
      `QueryForge DEMO (in-memory, no IBM i) on ${origin}  — login: demo / demo-password-123 (LDAP fake: dave / directory-pass; SSO button signs in a fake user)`,
    );
  });
}
void main();
