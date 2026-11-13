// Dev-only: folder report sharing screenshots (v19) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-folder-report-share.mjs [baseUrl] [outDir]
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

// 1. The demo user shares "Ops Review" and its reports (view only); Pat's report is skipped.
const demo = await signIn('demo', 'demo-password-123');
await demo.getByRole('button', { name: 'Manage folders' }).click();
await demo.getByRole('button', { name: 'Share Ops Review' }).click();
await demo.getByText(/won't be shared/).waitFor();
await shot(demo, 'v19-folder-report-share-dialog');
await demo.keyboard.press('Escape');
await demo.waitForTimeout(400);
await demo.keyboard.press('Escape');

// 2. The report's own share dialog lists the access that comes through the folder.
await demo.goto(`${base}/`);
await demo.locator('[data-testid="report-tile"]').first().waitFor();
await demo.getByRole('button', { name: 'Share Low Inventory' }).click();
await demo.getByRole('table', { name: 'Access through folders' }).waitFor();
await shot(demo, 'v19-folder-report-share-report-dialog');

// 3. Sam (folder Editor, reports shared view only) sees the demo user's reports in the folder.
const sam = await signIn('sam', 'sam-demo-password');
await sam
  .getByRole('combobox', { name: 'Folder' })
  .selectOption({ label: 'Ops Review (Demo User)' });
await sam.getByRole('heading', { level: 2, name: /^Ops Review/ }).waitFor();
await shot(sam, 'v19-folder-report-share-viewer');

await browser.close();
