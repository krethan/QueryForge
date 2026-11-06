// Dev-only: v13 rolling date-preset screenshots against the in-memory demo.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:3077';
const out = process.argv[3] ?? '/workspace/screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
};
await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();
await page.goto(`${base}/report-builder`);
await page.getByRole('searchbox', { name: 'Search tables' }).fill('ORDERS');
await page.getByText('DEMOLIB.ORDERS', { exact: true }).click();
await page.getByRole('checkbox', { name: /^ORDER_ID/ }).waitFor();
for (const c of ['ORDER_ID', 'CUSTOMER', 'ORDER_DATE', 'AMOUNT'])
  await page.getByText(c, { exact: true }).first().click();
await page.getByRole('button', { name: 'Add filter' }).click();
const row = page.getByRole('group', { name: 'Filter 1' });
await row.getByLabel('Column').selectOption({ label: 'ORDER_DATE' });
await row.getByLabel('Condition').selectOption('BETWEEN');
await row.getByLabel('Date range (fixed, or default if asked)').selectOption('LAST_N_DAYS');
await row.getByLabel('Number of days (includes today)').fill('30');
await row.getByLabel('Ask when run').check({ force: true });
await page
  .locator('.qf-filters, .qf-builder__filters')
  .first()
  .scrollIntoViewIfNeeded()
  .catch(() => {});
await shot('v13-date-filter-last-n-days');
await page.getByRole('button', { name: 'Run report', exact: true }).click();
await page.getByRole('region', { name: 'Results' }).waitFor();
await page.getByRole('region', { name: 'Results' }).scrollIntoViewIfNeeded();
await shot('v13-date-preset-result');
await page.getByRole('button', { name: 'Save as report', exact: true }).click();
const save = page.getByRole('dialog');
await save.getByLabel('Report name').fill('Orders, last 30 days (rolling)');
await save.getByRole('button', { name: /^Save/ }).click();
await page.waitForURL(/\/reports\/[^/]+$/);
await page.getByRole('button', { name: 'Run', exact: true }).click();
await shot('v13-date-ask-when-run');
// captured above
await browser.close();
