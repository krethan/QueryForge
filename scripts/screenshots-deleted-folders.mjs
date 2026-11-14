// Dev-only: admin Deleted folders screenshots (v22, v30 search) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-deleted-folders.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
// PW_CHANNEL=msedge (or chrome) uses an installed browser, e.g. when the bundled one cannot start.
const browser = await chromium.launch(
  process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {},
);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
};

// The demo user is an app admin: the side navigation has "Deleted folders".
await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('heading', { level: 1, name: 'Dashboard' }).waitFor();
await page.getByRole('link', { name: 'Deleted folders' }).click();
await page.getByRole('table', { name: 'Deleted folders' }).waitFor();
await shot('v22-admin-deleted-folders');
await page.getByRole('button', { name: 'Sharing history for Q3 Close (old)' }).click();
await page.getByRole('list', { name: 'Sharing history' }).waitFor();
await shot('v22-admin-deleted-folder-history');
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.getByRole('list', { name: 'Sharing history' }).waitFor({ state: 'hidden' });

// v30: search and filters, applied on the server, with the total that match.
await page.getByRole('searchbox', { name: 'Search deleted folders' }).fill('close');
await page.getByText(/of \d+ deleted folders? matching your filters/).waitFor();
await shot('v30-deleted-folders-search');

await browser.close();
