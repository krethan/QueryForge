import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:3078';
const out = process.argv[3] ?? '/home/swilliams/qf-shots/formatting';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(`${out}/${name}.png`);
};
await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();
const csrf = () =>
  page
    .context()
    .cookies()
    .then((cs) => cs.find((c) => c.name === 'qf_csrf')?.value);
const headers = async () => ({
  'X-CSRF-Token': await csrf(),
  Origin: base,
  'Content-Type': 'application/json',
});
const req = async (method, url, data) =>
  page.request[method](`${base}/api${url}`, { headers: await headers(), data });
const reports = await (await page.request.get(`${base}/api/reports`)).json();
const raw = reports.reports.find((r) => r.name === 'Open Orders by Region');
const grouped = reports.reports.find((r) => r.name === 'Revenue by Region (chart)');
await req('put', `/reports/${raw.id}/formatting`, {
  formatting: {
    version: 1,
    rules: [
      { column: 'AMOUNT', op: '>', value: '200', color: 'green', scope: 'cell' },
      { column: 'AMOUNT', op: '<', value: '100', color: 'red', scope: 'cell' },
      { column: 'REGION', op: 'contains', value: 'North', color: 'yellow', scope: 'row' },
    ],
  },
});
await page.goto(`${base}/reports/${raw.id}?run=1`);
await page.getByRole('region', { name: 'Results' }).waitFor();
await page.getByRole('region', { name: 'Results' }).scrollIntoViewIfNeeded();
await shot('v14-formatting-normal-results');
await page.getByRole('button', { name: 'Conditional formatting' }).click();
await page.getByRole('dialog').waitFor();
await shot('v14-formatting-editor');
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
await req('put', `/reports/${grouped.id}/formatting`, {
  formatting: {
    version: 1,
    rules: [
      { column: 'REVENUE', op: '>', value: '500', color: 'green', scope: 'cell' },
      { column: 'REGION', op: '=', value: 'North', color: 'blue', scope: 'row' },
    ],
  },
});
await page.goto(`${base}/reports/${grouped.id}?run=1`);
await page.getByRole('region', { name: 'Results' }).waitFor();
await page.getByRole('tab', { name: 'Table', exact: true }).click();
await page.getByRole('region', { name: 'Results' }).scrollIntoViewIfNeeded();
await shot('v14-formatting-grouped-results');
const spec = {
  version: 3,
  spec: {
    schema: 'DEMOLIB',
    table: 'ORDERS',
    columns: [],
    calculated: [{ id: 'DOUBLE_AMOUNT', name: 'Double Amount', expression: 'AMOUNT * 2' }],
    pivot: {
      rows: [{ table: 'T1', column: 'REGION' }],
      column: { table: 'T1', column: 'STATUS' },
      value: { fn: 'SUM', table: '@CALC', column: 'DOUBLE_AMOUNT' },
    },
  },
};
const saved = await req('post', '/reports', {
  name: 'Colored pivot (demo)',
  sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1',
  builderDef: spec,
});
const savedJson = await saved.json();
if (!saved.ok()) throw new Error(await saved.text());
await req('put', `/reports/${savedJson.report.id}/formatting`, {
  formatting: {
    version: 1,
    rules: [
      { column: 'PIVOT_VALUE', op: '>', value: '250', color: 'green', scope: 'cell' },
      { column: 'REGION', op: '=', value: 'East', color: 'purple', scope: 'row' },
    ],
  },
});
await page.goto(`${base}/reports/${savedJson.report.id}`);
await page.getByRole('button', { name: 'Run', exact: true }).click();
await page.getByTestId('pivot-table').waitFor();
await page.getByRole('region', { name: 'Pivot results' }).scrollIntoViewIfNeeded();
await shot('v14-formatting-pivot-results');
const xlsx = await req('post', '/export', { reportId: raw.id });
writeFileSync(`${out}/v14-formatting-export.xlsx`, await xlsx.body());
console.log('Excel export HTTP', xlsx.status());
await browser.close();
