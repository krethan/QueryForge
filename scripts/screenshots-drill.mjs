// Dev-only: drill-down screenshots from the in-memory demo (`npm run demo` must be running).
// Usage: node scripts/screenshots-drill.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();
const list = await (await page.request.get(`${base}/api/reports`)).json();
const byName = (n) => list.reports.find((r) => r.name === n);

// 1. chart before a click, 2. drilled detail after clicking the West bar
const rev = byName('Revenue by Region (chart)');
await page.goto(`${base}/reports/${rev.id}`);
await page.getByRole('button', { name: 'Run', exact: true }).click();
await page.locator('[data-testid="qf-chart"] path.bar').first().waitFor({ timeout: 20000 });
await shot('v9-chart-before-click');
const bars = page.locator('[data-testid="qf-chart"] path.bar');
const n = await bars.count();
let clicked = false;
for (let i = 0; i < n && !clicked; i++) {
  const label = (await bars.nth(i).getAttribute('aria-label')) ?? '';
  if (/west/i.test(label) || i === n - 1) {
    await bars.nth(i).click({ force: true });
    clicked = true;
  }
}
await page.getByTestId('drill-panel').locator('tbody tr').first().waitFor({ timeout: 20000 });
await shot('v9-drill-detail-breadcrumb');
await page.getByTestId('drill-panel').getByRole('button', { name: 'Back' }).click();

// 3. drill from a grouped table row
await page.getByTestId('drill-row').nth(1).click();
await page.getByTestId('drill-panel').locator('tbody tr').first().waitFor({ timeout: 20000 });
await shot('v9-drill-from-table-row');
await page.keyboard.press('Escape');

// 4. drill-target settings (SQL report -> Orders by Region and Date), then a nested target drill
const sqlRep = byName('Region Totals (SQL, drill target)');
await page.goto(`${base}/reports/${sqlRep.id}`);
await page.getByRole('button', { name: 'Run', exact: true }).click();
await page.getByTestId('drill-row').first().waitFor({ timeout: 20000 });
await page.getByTestId('drill-settings').scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
await shot('v9-drill-target-settings');
await page.getByTestId('drill-row').first().click();
await page.getByTestId('drill-panel').locator('tbody tr').first().waitFor({ timeout: 20000 });
await shot('v9-drill-to-target-report');

await browser.close();
