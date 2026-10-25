// Dev-only: capture UI screenshots from the in-memory demo (`npm run demo` must be running).
// Usage: node scripts/screenshots.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await shot('01-login');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();
// run two reports so tiles show last-run details
for (const name of ['Open Orders by Region', 'Customer Credit Limits']) {
  await page.goto(`${base}/`);
  const tile = page.locator('.qf-tile', { hasText: name });
  await tile.getByRole('button', { name: /run/i }).first().click();
  await page.getByRole('table').waitFor();
}
await page.goto(`${base}/`);
await page.getByText('Low Inventory').first().waitFor();
await shot('02-dashboard');

await page.goto(`${base}/reports/new`);
await page.locator('.cm-content').click();
await page.keyboard.type(
  "SELECT ORDER_ID, CUSTOMER, REGION, ORDER_DATE, AMOUNT, STATUS, NOTE\nFROM DEMOLIB.ORDERS\nWHERE REGION IN ('North', 'East')\nORDER BY ORDER_DATE DESC",
);
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Run', exact: true }).click();
await page.getByRole('table').waitFor();
await shot('03-editor-results');

await page.getByRole('button', { name: /save as report/i }).click();
await page.getByLabel('Report name').fill('North & East Orders');
await page
  .getByLabel(/description/i)
  .first()
  .fill('Demo orders for two regions (fake data)');
await shot('04-save-modal');
await page.keyboard.press('Escape');

await page.goto(`${base}/datasource`);
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: /test connection/i }).click();
await page.getByText(/OK ·/).first().waitFor();
await shot('05-data-source');

// ---- v2: parameters, sharing, schedules ----
await page.goto(`${base}/`);
const shared = page.getByRole('heading', { name: 'Shared with me' });
await shared.waitFor();
await shared.scrollIntoViewIfNeeded();
await shot('v2-dashboard-shared');

await page.goto(`${base}/`);
await page
  .locator('.qf-tile', { hasText: 'Orders by Region and Date' })
  .getByRole('button', { name: /run/i })
  .first()
  .click();
const dialog = page.getByRole('dialog');
await dialog
  .getByLabel(/Region/)
  .first()
  .waitFor();
await dialog
  .getByLabel(/Region/)
  .first()
  .selectOption('West');
await dialog.getByLabel(/Minimum amount/).fill('250');
await shot('v2-run-params');
await page.keyboard.press('Escape');

await page.goto(`${base}/`);
await page.getByRole('button', { name: 'Share Customer Credit Limits' }).click();
await page
  .getByRole('dialog')
  .getByText(/finance/i)
  .first()
  .waitFor();
await shot('v2-share-dialog');
await page.keyboard.press('Escape');

await page.goto(`${base}/schedules`);
await page.getByRole('button', { name: 'Edit schedule' }).first().click();
await page.getByText(/Next runs/).waitFor();
await shot('v2-schedule-editor');

await browser.close();
