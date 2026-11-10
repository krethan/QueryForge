// Dev-only: dashboard tile rearranging screenshots (v16) from the in-memory demo (`npm run demo`).
// Usage: node scripts/screenshots-tile-order.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};
const slot = (name) =>
  page
    .locator('[data-testid="tile-slot"]', {
      has: page.getByRole('heading', { level: 3, name, exact: true }),
    })
    .first();
const order = () =>
  page.locator('[data-section="mine"] [data-testid="tile-slot"] h3').allTextContents();

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('heading', { name: 'Open Orders by Region' }).first().waitFor();
console.log('before:', await order());
await shot('v16-tile-order-before');

// Drag "Low Inventory" onto the first tile, capturing the drop indicator mid-drag.
const names = await order();
const src = slot('Low Inventory');
const dst = slot(names[0]);
const s = await src.locator('h3').boundingBox();
const d = await dst.boundingBox();
await page.mouse.move(s.x + 20, s.y + 8);
await page.mouse.down();
await page.mouse.move(s.x + 40, s.y + 20, { steps: 5 });
await page.mouse.move(d.x + 30, d.y + d.height / 2, { steps: 15 });
await shot('v16-tile-order-mid-drag');
await page.mouse.up();
await page.waitForTimeout(800);
console.log('after drop:', await order());

// Reload: the order comes back from the server.
await page.reload();
await page.getByRole('heading', { name: 'Open Orders by Region' }).first().waitFor();
console.log('after reload:', await order());
await shot('v16-tile-order-after-reload');

await browser.close();
