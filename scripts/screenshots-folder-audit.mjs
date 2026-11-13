// Dev-only: folder Access and audit screenshots (v20) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-folder-audit.mjs [baseUrl] [outDir]
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

// 1. The demo user opens "Ops Review" access and audit from Manage folders.
const demo = await signIn('demo', 'demo-password-123');
await demo.getByRole('button', { name: 'Manage folders' }).click();
await demo.getByRole('button', { name: 'Access and audit for Ops Review' }).waitFor();
await shot(demo, 'v20-folder-audit-manage');
await demo.getByRole('button', { name: 'Access and audit for Ops Review' }).click();
await demo.getByRole('list', { name: 'Sharing history' }).waitFor();
await shot(demo, 'v20-folder-audit-panel');
await demo.keyboard.press('Escape');
await demo.waitForTimeout(400);

// 2. The folder Share dialog links to the same panel.
await demo.goto(`${base}/`);
await demo.locator('[data-testid="report-tile"]').first().waitFor();
await demo.getByRole('button', { name: 'Manage folders' }).click();
await demo.getByRole('button', { name: 'Share Ops Review' }).click();
await demo.getByRole('button', { name: 'View access and audit history' }).waitFor();
await shot(demo, 'v20-folder-audit-share-dialog');

// 3. Sam is an Editor of "Ops Review": no access and audit for folders shared with him.
const sam = await signIn('sam', 'sam-demo-password');
await sam.getByRole('button', { name: 'Manage folders' }).click();
await sam.getByRole('list', { name: 'Folders shared with you' }).waitFor();
await shot(sam, 'v20-folder-audit-editor-manage');

await browser.close();
