// Dev-only: pivot report screenshots (v12) from the in-memory demo (`npm run demo` must be running).
// Usage: node scripts/screenshots-pivot.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();

// 1. builder setup: rows REGION, columns STATUS, Sum of AMOUNT
await page.goto(`${base}/report-builder`);
await page.getByRole('searchbox', { name: 'Search tables' }).fill('ORDERS');
await page.getByText('DEMOLIB.ORDERS', { exact: true }).click();
await page.getByRole('checkbox', { name: /^REGION/ }).waitFor();
await page.locator('#qf-pivot-toggle_label').click();
await page.getByLabel('Row field').selectOption({ label: 'REGION' });
await page.getByLabel('Column field').selectOption({ label: 'STATUS' });
await page.getByLabel('of', { exact: true }).selectOption({ label: 'AMOUNT' });
await page
  .getByRole('region', { name: 'SQL preview' })
  .getByText(/GROUP BY/)
  .waitFor();
const pivotPanel = page.getByTestId('builder-pivot');
await pivotPanel.scrollIntoViewIfNeeded();
await shot('v12-pivot-setup');

// 2. result with row, column and grand totals
await page.getByRole('button', { name: 'Run report' }).click();
await page.getByTestId('pivot-table').waitFor({ timeout: 20000 });
await page.getByRole('region', { name: 'Pivot results' }).scrollIntoViewIfNeeded();
await shot('v12-pivot-result-totals');

// save, then drill from a cell on the saved report
await page.getByRole('button', { name: 'Save as report' }).click();
const dlg = page.getByRole('dialog', { name: 'Save as report' });
await dlg.getByLabel('Report name').fill('Revenue by Region and Status (pivot)');
await dlg.getByRole('button', { name: /^Save/ }).click();
await page.waitForURL(/\/reports\/[^/]+$/);
const id = page.url().split('/').pop();
await page.getByRole('button', { name: 'Run', exact: true }).click();
await page.getByTestId('pivot-table').waitFor({ timeout: 20000 });
await page.getByTestId('pivot-table').locator('button.qf-pivot-cell').first().click();
await page.getByTestId('drill-panel').locator('tbody tr').first().waitFor({ timeout: 20000 });
await shot('v12-pivot-cell-drill');
await page.keyboard.press('Escape');

// 4. stacked bar chart drawn from the grouped rows
await page
  .getByRole('tab', { name: 'Both' })
  .click()
  .catch(async () => {
    await page.getByText('Both', { exact: true }).click();
  });
await page.locator('[data-testid="qf-chart"]').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);
await shot('v12-pivot-chart', { fullPage: true });

// Excel export in the pivot layout (same request the button sends)
const csrf = (await page.context().cookies()).find((c) => c.name === 'qf_csrf')?.value;
const res = await page.request.post(`${base}/api/reports/${id}/pivot/export`, {
  headers: { 'X-CSRF-Token': csrf ?? '', Origin: base },
  data: {},
});
console.log('export', res.status());
writeFileSync(`${out}/v12-pivot-export.xlsx`, await res.body());
await browser.close();
