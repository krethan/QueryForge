// Dev-only: Report Builder filter/grouping screenshots (v7) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-builder.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};
const check = (scope, name) => scope.getByText(name, { exact: true }).click();

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();

await page.goto(`${base}/report-builder`);
await page.getByRole('searchbox', { name: 'Search tables' }).fill('ORDERS');
await page.getByText('DEMOLIB.ORDERS', { exact: true }).click();
await page.getByRole('checkbox', { name: /^REGION/ }).waitFor();
await check(page, 'REGION');

// filters: a fixed amount filter and an ask-when-run date filter
await page.getByRole('button', { name: 'Add filter', exact: true }).click();
const f1 = page.getByRole('group', { name: /filter 1/ });
await f1.getByLabel('Column').selectOption('AMOUNT');
await f1.getByLabel('Condition').selectOption({ label: 'at least' });
await f1.getByLabel('Value').fill('100');
await page.getByRole('button', { name: 'Add filter', exact: true }).click();
const f2 = page.getByRole('group', { name: /filter 2/ });
await f2.getByLabel('Column').selectOption('ORDER_DATE');
await f2.getByLabel('Condition').selectOption({ label: 'at least' });
await check(f2, 'Ask when run');
await f2.getByLabel('Prompt').fill('Orders since');
await f2.getByLabel(/Default/).fill('2026-01-01');
await page.locator('.qf-builder__filters').scrollIntoViewIfNeeded();
await page.locator('.qf-builder__filters').screenshot({ path: `${out}/v7-filters.png` });
console.log(`${out}/v7-filters.png`);

// grouping with totals, sorted by a total
await page.getByRole('button', { name: 'Add total', exact: true }).click();
const t1 = page.getByRole('group', { name: 'Total 1' });
await t1.getByLabel('Column name').fill('Orders');
await page.getByRole('button', { name: 'Add total', exact: true }).click();
const t2 = page.getByRole('group', { name: 'Total 2' });
await t2.getByLabel('Function').selectOption('SUM');
await t2.getByLabel('Of').selectOption({ label: 'AMOUNT' });
await t2.getByLabel('Column name').fill('Revenue');
await page.getByRole('button', { name: 'Add sort column' }).click();
await page.getByLabel('Sort 1 column').selectOption({ label: 'Revenue' });
await page.getByLabel('Direction').first().selectOption('DESC');
await page.locator('.qf-builder__grouping').scrollIntoViewIfNeeded();
await page.locator('.qf-builder__grouping').screenshot({ path: `${out}/v7-grouping.png` });
console.log(`${out}/v7-grouping.png`);

const preview = page.getByRole('region', { name: 'SQL preview' });
await preview.getByText(/GROUP BY/).waitFor();
await preview.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await preview.screenshot({ path: `${out}/v7-sql-preview.png` });
console.log(`${out}/v7-sql-preview.png`);

await page.getByRole('button', { name: 'Run report' }).click();
const dlg = page.getByRole('dialog', { name: 'Report parameters' });
await dlg.getByLabel(/Orders since/).fill('2025-01-01');
await shot('v7-ask-when-run');
await dlg.getByRole('button', { name: 'Run' }).click();
await page.getByRole('table', { name: 'Query results' }).waitFor();
await page.getByRole('region', { name: 'Results' }).scrollIntoViewIfNeeded();
await shot('v7-grouped-results');

await page.getByRole('button', { name: 'Save as report' }).click();
const save = page.getByRole('dialog', { name: 'Save as report' });
await save.getByLabel('Report name').fill('Revenue by Region (builder)');
await save.getByRole('button', { name: /^Save/ }).click();
await page.waitForURL(/\/reports\/[^/]+$/);
await page.getByRole('button', { name: 'Open in Report Builder' }).click();
await page.getByTestId('builder-source').waitFor();
await page
  .getByRole('region', { name: 'SQL preview' })
  .getByText(/GROUP BY/)
  .waitFor();
await shot('v7-reopen-builder', { fullPage: true });

await browser.close();
