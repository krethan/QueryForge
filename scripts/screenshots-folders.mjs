// Dev-only: folders and favorites screenshots (v11) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-folders.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByText('Open Orders by Region').first().waitFor();

// folders
await page.getByRole('button', { name: 'Manage folders' }).click();
const manage = page.getByRole('dialog', { name: 'Manage folders' });
for (const name of ['Finance', 'Sales', 'Warehouse']) {
  await manage.getByLabel('New folder name').fill(name);
  await manage.getByRole('button', { name: 'Create folder' }).click();
  await manage.getByText(name, { exact: true }).waitFor();
}
await shot('v11-manage-folders');
await manage.getByRole('button', { name: 'Close' }).first().click();

// stars
for (const name of ['Revenue by Region (chart)', 'GL Balances (exact decimals)'])
  await page.getByRole('button', { name: `Star ${name}`, exact: true }).click();

// move a report into a folder (capture the dialog)
const move = async (report, folder, capture) => {
  await page
    .getByRole('button', { name: `Move ${report} to a folder` })
    .first()
    .click();
  const dlg = page.getByRole('dialog', { name: `Move "${report}"` });
  await dlg.getByLabel('Folder').selectOption({ label: folder });
  if (capture) await shot(capture);
  await dlg.getByRole('button', { name: 'Move', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
};
await move('Open Orders by Region', 'Sales', 'v11-move-to-folder');
await move('October Sales Summary', 'Sales');
await move('Revenue by Region (chart)', 'Sales');
await move('GL Balances (exact decimals)', 'Finance');
await move('Daily Revenue (chart)', 'Finance');
await move('Low Inventory', 'Warehouse');

await page.reload();
await page.getByRole('heading', { name: /^Favorites/ }).waitFor();
await shot('v11-dashboard-favorites', { fullPage: true });

await page.locator('#group-by-folder_label').click();
await shot('v11-folder-grouped', { fullPage: true });
await page.locator('#group-by-folder_label').click();

await page.getByLabel('Folder', { exact: true }).selectOption({ label: 'Sales' });
await shot('v11-folder-view', { fullPage: true });

await browser.close();
