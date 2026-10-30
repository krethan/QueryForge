// Dev-only: chart screenshots from the in-memory demo (`npm run demo` must be running).
// Usage: node scripts/screenshots-charts.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();

const list = await (await page.request.get(`${base}/api/reports`)).json();
const reports = list.reports ?? list;
const byName = (n) => reports.find((r) => r.name === n);

for (const [name, file] of [
  ['Revenue by Region (chart)', 'v8-bar-revenue-by-region'],
  ['Daily Revenue (chart)', 'v8-line-daily-revenue'],
  ['Orders by Status (chart)', 'v8-donut-orders-by-status'],
]) {
  await page.goto(`${base}/reports/${byName(name).id}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.locator('[data-testid="qf-chart"]').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500); // let the lazy chart chunk draw
  await shot(file, { fullPage: true });
}

await page.goto(`${base}/`);
await page.locator('[data-testid="qf-chart"]').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500); // let the lazy chart chunk draw
await shot('v8-dashboard-chart-tiles', { fullPage: true });

// XLSX export with the chart sheet, via the API (same request the Export button sends)
const csrf = (await page.context().cookies()).find((c) => c.name === 'qf_csrf')?.value;
const id = byName('Revenue by Region (chart)').id;
const res = await page.request.post(`${base}/api/export`, {
  headers: { 'X-CSRF-Token': csrf ?? '', Origin: base },
  data: { reportId: id },
});
console.log('export', res.status(), res.headers()['x-qf-chart']);
writeFileSync(`${out}/v8-export.xlsx`, await res.body());
await browser.close();
