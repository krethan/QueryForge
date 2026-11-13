// Dev-only: scheduled report delivery screenshots (v18) from the in-memory demo (`npm run demo`).
// The demo uses an in-memory mailer: nothing is ever sent. Usage:
//   node scripts/screenshots-scheduled.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3005';
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log(`${out}/${name}.png`);
};

await page.goto(`${base}/login`);
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password', { exact: true }).fill('demo-password-123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('heading', { level: 1, name: 'Dashboard' }).waitFor();

// 1. All schedules: cadence, time zone, recipients, next and last run, pause/resume.
await page.goto(`${base}/schedules`);
await page.getByText('Every Monday at 07:00').waitFor();
await shot('v18-scheduled-list', { fullPage: true });

// 2. Delivery history of the weekly schedule.
await page
  .getByTestId('schedule-row')
  .filter({ hasText: 'Every Monday at 07:00' })
  .getByRole('button', { name: 'Delivery history' })
  .click();
await page.getByText(/Run now by/).waitFor();
await shot('v18-scheduled-history');
await page
  .locator('.cds--modal.is-visible')
  .getByRole('button', { name: /close/i })
  .first()
  .click();
await page.locator('.cds--modal.is-visible').waitFor({ state: 'detached' });

// 3. From a report: its schedules, then the editor for a new monthly schedule.
await page.getByRole('link', { name: 'Orders by Region and Date' }).first().click();
await page.getByRole('button', { name: 'Schedule', exact: true }).click();
await page.getByRole('heading', { name: 'Scheduled delivery' }).waitFor();
await page.getByText('Every Monday at 07:00').waitFor();
await shot('v18-scheduled-report-dialog');
await page.getByRole('button', { name: 'New schedule' }).click();
await page.getByRole('heading', { name: 'New schedule' }).waitFor();
await page.getByLabel('Repeat').selectOption('MONTHLY');
await page.getByLabel('Day of the month').selectOption('LAST');
await page.getByLabel('Time of day').fill('06:30');
await page.getByText('Monthly on the last day at 06:30').waitFor();
await shot('v18-scheduled-editor');

await browser.close();
