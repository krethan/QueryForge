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
await browser.close();
