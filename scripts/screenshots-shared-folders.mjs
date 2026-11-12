// Dev-only: shared folder screenshots (v17) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-shared-folders.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function signIn(username, password) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByRole('heading', { level: 1, name: 'Dashboard' }).waitFor();
  await page.locator('[data-testid="report-tile"]').first().waitFor();
  return page;
}
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};

// 1. The demo user (owner of "Month-end Pack"; admin, so Pat's shared "Sales Team" shows as Admin).
const demo = await signIn('demo', 'demo-password-123');
await demo.getByRole('switch', { name: /Group by folder/ }).click({ force: true });
await demo.getByRole('heading', { level: 2, name: /^Month-end Pack/ }).waitFor();
await shot(demo, 'v17-shared-folders-owner', { fullPage: true });

// 2. Sharing the folder from Manage folders.
await demo.getByRole('button', { name: 'Manage folders' }).click();
await demo.getByRole('button', { name: 'Share Month-end Pack' }).click();
await demo.getByText('Group: finance').waitFor();
await shot(demo, 'v17-shared-folders-share-dialog');

// 3. Sam (finance group, Viewer): sees the folder but only the report shared with finance.
const sam = await signIn('sam', 'sam-demo-password');
await sam
  .getByRole('combobox', { name: 'Folder' })
  .selectOption({ label: 'Month-end Pack (Demo User)' });
await sam.getByRole('heading', { level: 2, name: /^Month-end Pack/ }).waitFor();
await shot(sam, 'v17-shared-folders-viewer');

await browser.close();
