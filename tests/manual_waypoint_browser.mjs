import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createWaypointFixture, onRequestPost } from './waypoint_fixture.mjs';

const fixture = await createWaypointFixture();
const ui = await readFile('src/LatLong_Ui.html', 'utf8');
const built = await readFile('public/app/index.html', 'utf8');
const styles = [...built.matchAll(new RegExp('<style[^>]*>[^]*?</style>', 'gi'))].map(match => match[0]).join('');
const shim = await readFile('public/cloudflare-shim.js', 'utf8');
const requests = [];
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/rpc') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push(JSON.parse(body).method);
      const response = await onRequestPost({ env: { DB: fixture.DB }, request: new Request(`http://${req.headers.host}/api/rpc`, {
        method: 'POST', headers: req.headers, body
      }) });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.end(await response.text());
    } else if (req.url === '/cloudflare-shim.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(shim);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8">${styles}<script src="/cloudflare-shim.js"></script></head><body><section class="view-section active">${ui}</section><script>window.initLatlongManager();</script></body></html>`);
    }
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});
await new Promise(resolve => server.listen(0, 'localhost', resolve));
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], dialogs = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
try {
  await page.goto(`http://localhost:${server.address().port}`);
  await page.locator('#awq-login-email').fill('tester@example.com');
  await page.locator('#awq-login-password').fill('correct horse battery staple');
  await page.locator('#awq-login-form button').click();
  await expect(page.locator('#awq-login-gate')).toHaveCount(0);
  await page.evaluate(() => window.initLatlongManager());
  await expect(page.locator('#ll-list')).toContainText('No waypoints found.');
  await page.locator('#ll-routeId').fill('ROUTE-A');
  await page.locator('#ll-paste').fill('WADD S 08 44.8 E 115 10.2');
  await page.locator('#ll-preview-btn').click();
  await expect(page.locator('#ll-preview-count')).toHaveText('(1)');
  await expect(page.locator('#ll-preview-meta')).not.toContainText('undefined');
  await page.locator('#ll-paste').fill('WADD S 08 44.8 E 115 10.2\nMAMAD S 08 45.0 E 115 27.9');
  await page.locator('#ll-save-btn').click();
  await expect(page.locator('#ll-kpi-total')).toHaveText('2');
  assert.match(dialogs.at(-1), /Save 2 waypoints/);
  assert.equal(requests.filter(method => method === 'latlongSaveBulk').length, 1);
  await page.locator('#ll-routeId').fill('ROUTE-B');
  await page.locator('#ll-mode').selectOption('append');
  await page.locator('#ll-save-btn').click();
  await expect(page.locator('#ll-kpi-total')).toHaveText('4');
  const twoColumnRoute = 'AAAA N 1 01.0 E 1 01.0 BBBB N 2 02.0 E 2 02.0\nCCCC N 3 03.0 E 3 03.0 DDDD N 4 04.0 E 4 04.0';
  await page.locator('#ll-routeId').fill('ROUTE-COLUMN');
  await page.locator('#ll-order').selectOption('row');
  await page.locator('#ll-paste').fill(twoColumnRoute);
  await page.locator('#ll-save-btn').click();
  await expect(page.locator('#ll-kpi-total')).toHaveText('8');
  await page.locator('#ll-order').selectOption('column');
  await page.locator('#ll-mode').selectOption('merge');
  await page.locator('#ll-save-btn').click();
  const routeColumnItems = page.locator('.ll-item').filter({ hasText: '(ROUTE-COLUMN)' });
  await expect(routeColumnItems).toHaveCount(4);
  await expect(routeColumnItems.nth(0).locator('.ll-wpt')).toHaveText('AAAA (ROUTE-COLUMN)');
  await expect(routeColumnItems.nth(1).locator('.ll-wpt')).toHaveText('CCCC (ROUTE-COLUMN)');
  await expect(routeColumnItems.nth(2).locator('.ll-wpt')).toHaveText('BBBB (ROUTE-COLUMN)');
  await expect(routeColumnItems.nth(3).locator('.ll-wpt')).toHaveText('DDDD (ROUTE-COLUMN)');
  await page.locator('#ll-routeId').fill('ROUTE-A');
  await page.locator('#ll-mode').selectOption('merge');
  await page.locator('#ll-paste').fill('WADD S 08 40.0 E 115 10.2\nVTK N 01 24.9 E 104 01.3');
  await page.locator('#ll-save-btn').click();
  await expect(page.locator('#ll-kpi-total')).toHaveText('9');
  const routeA = page.locator('.ll-item').filter({ hasText: 'WADD (ROUTE-A)' });
  const routeB = page.locator('.ll-item').filter({ hasText: 'WADD (ROUTE-B)' });
  await expect(routeA).toContainText('S 08 40.0');
  await expect(routeB).toContainText('S 08 44.8');
  await page.getByRole('button', { name: 'REFRESH', exact: true }).click();
  await expect(routeA).toContainText('S 08 40.0');
  await routeA.locator('button').click();
  await expect(page.locator('#ll-kpi-total')).toHaveText('8');
  await expect(routeB).toHaveCount(1);
  await page.locator('#ll-paste').fill('invalid input');
  await page.locator('#ll-save-btn').click();
  await expect(page.locator('.ll-toast')).toContainText('No valid waypoints');
  await expect(page.locator('#ll-save-btn')).toBeEnabled();
  await expect(page.locator('#ll-kpi-total')).toHaveText('8');
  await page.screenshot({ path: join(tmpdir(), 'awq-waypoint-qa.png'), fullPage: true });
  await page.locator('#ll-clear-btn').click();
  await expect(page.locator('#ll-kpi-total')).toHaveText('0');
  assert.deepEqual(errors, []);
  console.log('Browser QA passed: real login, preview, row-to-column MERGE ordering, replace, append, merge, refresh/read-back, row delete, validation and clear; one write per click; no page errors.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  fixture.database.close();
}
