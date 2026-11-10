// Dev-only: calculated-field screenshots (v10) from the in-memory demo (`npm run demo` must be running).
// Usage: node scripts/screenshots-calc.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const save = async (loc, name) => {
  await loc.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await loc.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('heading', { name: 'Open Orders by Region' }).first().waitFor();

await page.goto(`${base}/report-builder`);
await page.getByRole('searchbox', { name: 'Search tables' }).fill('ORDER_LINES');
await page.getByText('DEMOLIB.ORDER_LINES', { exact: true }).click();
await page.getByRole('checkbox', { name: /^ITEM/ }).waitFor();
for (const c of ['ITEM', 'QTY', 'UNIT_PRICE'])
  await page.getByText(c, { exact: true }).first().click();

// 1. editor mid-edit: an unfinished expression shows the server's error with a caret
const panel = page.getByRole('region', { name: 'Calculated fields' });
await page.getByRole('button', { name: 'Add calculated field' }).click();
const row = panel.getByRole('group').first();
await row.getByLabel('Name').fill('Line total');
await row.getByLabel('Expression').fill('COALESCE(QTY, 0) * ');
await row
  .getByText(/Expected/)
  .first()
  .waitFor({ timeout: 10000 });
await save(panel, 'v10-calc-editor-error');
await row.getByLabel('Expression').fill('COALESCE(QTY, 0) * UNIT_PRICE');
await row.getByText(/Result:/).waitFor({ timeout: 10000 });
await row.getByText('Show as a column', { exact: true }).click();
await save(panel, 'v10-calc-editor-valid');

// 2. results with the calculated column, sorted by it
await page.getByRole('button', { name: 'Add sort column' }).click();
await page.getByLabel('Sort 1 column').selectOption({ label: 'ƒ Line total' });
await page.getByRole('button', { name: 'Run report' }).click();
await page.getByRole('table', { name: 'Query results' }).waitFor();
await save(page.getByRole('region', { name: 'Results' }), 'v10-calc-results');
await save(page.getByRole('region', { name: 'SQL preview' }), 'v10-calc-sql-preview');

// 3. group by ITEM with a total of the calculated field
for (const c of ['QTY', 'UNIT_PRICE']) await page.getByText(c, { exact: true }).first().click();
await row.getByText('Show as a column', { exact: true }).click();
await page.getByRole('button', { name: 'Add total', exact: true }).click();
const t1 = page.getByRole('group', { name: 'Total 1' });
await t1.getByLabel('Function').selectOption('SUM');
await t1.getByLabel('Of').selectOption({ label: 'ƒ Line total' });
await t1.getByLabel('Column name').fill('Revenue');
if (!(await page.getByLabel('Sort 1 column').count()))
  await page.getByRole('button', { name: 'Add sort column' }).click();
await page.getByLabel('Sort 1 column').selectOption({ label: 'Revenue' });
await save(page.locator('.qf-builder__grouping'), 'v10-calc-grouping');
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Run report' }).click();
await page.getByRole('table', { name: 'Query results' }).waitFor();
await page.waitForTimeout(800);

// 4. chart of the grouped calculated total
await page
  .getByRole('tab', { name: 'Chart' })
  .click()
  .catch(() => page.getByText('Chart', { exact: true }).click());
await page.locator('[data-testid="qf-chart"]').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);
await save(page.getByRole('region', { name: 'Results' }), 'v10-calc-grouped-chart');

await browser.close();
