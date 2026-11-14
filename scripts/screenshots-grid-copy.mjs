// Dev-only: results grid copy and column resizing screenshot (v28) from the in-memory demo
// (`npm run demo`). Usage: node scripts/screenshots-grid-copy.mjs [baseUrl] [outDir]
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
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
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

await page.goto(`${base}/reports/new`);
await page.locator('.cm-content').click();
await page.keyboard.type(
  'SELECT ORDER_ID, CUSTOMER, REGION, ORDER_DATE, AMOUNT, STATUS, NOTE\nFROM DEMOLIB.ORDERS\nORDER BY ORDER_ID',
);
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Run', exact: true }).click();
const grid = page.getByRole('grid', { name: 'Query results' });
await grid.waitFor();

// widen CUSTOMER with the keyboard, then select ORDER_ID..AMOUNT on rows 2-6 and copy
await page.getByRole('separator', { name: 'Resize column CUSTOMER' }).focus();
await page.keyboard.press('Shift+ArrowRight');
await grid.locator('[data-cell="1:0"]').click();
await grid.locator('[data-cell="5:4"]').click({ modifiers: ['Shift'] });
await page.keyboard.press('ControlOrMeta+c');
await page.getByText(/Copied 5 rows × 5 columns/).waitFor();
const copied = await page.evaluate(() => navigator.clipboard.readText());
console.log(JSON.stringify(copied));

// show the results header, toolbar, status line and the open Copy menu
await page.locator('.qf-results-meta').evaluate((el) => {
  el.scrollIntoView({ block: 'start' });
  el.ownerDocument.defaultView?.scrollBy(0, -64);
});
await page.getByRole('button', { name: 'Copy', exact: true }).click();
await page.getByRole('menuitemcheckbox', { name: 'Include column headers' }).waitFor();
await shot('v28-grid-copy');

await browser.close();
