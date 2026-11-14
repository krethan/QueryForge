// Dev-only: the notifications bell and panel (v26) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-notifications.mjs [baseUrl] [outDir]
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

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('heading', { level: 1, name: 'Dashboard' }).waitFor();
await page.getByRole('button', { name: /^Notifications, \d+\+? unread$/ }).click();
await page.getByRole('list', { name: 'Notifications' }).waitFor();
await shot('v26-notifications');

await browser.close();
