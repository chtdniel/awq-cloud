import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const publicRoot = join(process.cwd(), 'public');
const mimeTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.svg': 'image/svg+xml' };
const server = createServer(function(request, response) {
  var relativePath = request.url === '/' ? 'index.html' : request.url.replace(/^\//, '').split('?')[0];
  var filePath = normalize(join(publicRoot, relativePath));
  if (!filePath.startsWith(publicRoot) || !statSync(filePath, { throwIfNoEntry: false })) {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
});

await new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const baseUrl = 'http://127.0.0.1:' + port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

function readinessPayload() {
  return {
    ok: true,
    generatedAtUtc: new Date().toISOString(),
    dof: { status: 'READY', value: '20260917', timestampUtc: new Date().toISOString() },
    notam: { status: 'READY', value: '', timestampUtc: new Date().toISOString(), ageMinutes: 0 },
    taf: { status: 'READY', value: '1', timestampUtc: new Date().toISOString(), ageMinutes: 0 }
  };
}

async function verifyScenario(name, initiallyLoggedIn) {
  const page = await browser.newPage();
  let loggedIn = initiallyLoggedIn;
  let readinessCalls = 0;
  let dashboardCalls = 0;
  const pageErrors = [];
  page.on('pageerror', function(error) { pageErrors.push(error.message); });
  await page.route('**/api/rpc', async function(route) {
    const method = route.request().postDataJSON().method;
    if (method === 'authMe') {
      if (!loggedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required.' } });
      return route.fulfill({ json: { data: { user: 'tester@example.com', tier: 'admin' } } });
    }
    if (method === 'authLogin') {
      loggedIn = true;
      return route.fulfill({ json: { data: { user: { email: 'tester@example.com', role: 'admin' } } } });
    }
    if (method === 'authLogout') {
      loggedIn = false;
      return route.fulfill({ json: { data: { ok: true } } });
    }
    if (method === 'getFlightDashboardData') {
      dashboardCalls += 1;
      if (!loggedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required.' } });
      return route.fulfill({ json: { data: { flights: [], acList: [], airportTimezones: {} } } });
    }
    if (!loggedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required.' } });
    if (method === 'getOperationalReadiness') {
      readinessCalls += 1;
      return route.fulfill({ json: { data: readinessPayload() } });
    }
    return route.fulfill({ json: { data: {} } });
  });

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  if (!initiallyLoggedIn) {
    await page.locator('#awq-login-gate').waitFor();
    assert.equal(await page.locator('#dispatcher-reminder').evaluate(function(dialog) { return dialog.open; }), false, name + ': readiness dialog is hidden before login');
    assert.equal(readinessCalls, 0, name + ': readiness is not requested before login');
    assert.equal(dashboardCalls, 0, name + ': dashboard is not requested before login');
    await page.locator('#awq-login-email').fill('tester@example.com');
    await page.locator('#awq-login-password').fill('test-only-password');
    await page.locator('#awq-login-form').press('Enter');
    await page.locator('#awq-user-bar').waitFor();
  }
  await page.locator('#sys-db-status').filter({ hasText: 'CONNECTED' }).waitFor();
  assert.equal(await page.locator('#flight-tbody').getByText('DATABASE CONNECTION ERROR').count(), 0, name + ': no stale authentication error remains after login');
  await page.locator('#dispatcher-reminder[open]').waitFor();
  assert.equal(readinessCalls, 1, name + ': readiness is requested exactly once after authentication');
  if (!initiallyLoggedIn) {
    await page.locator('#cmAck').check();
    await page.locator('#readiness-continue').click();
    await page.locator('#dispatcher-reminder[open]').waitFor({ state: 'hidden' });
    await page.locator('#awq-account-toggle').click();
    await page.locator('#awq-logout').click();
    await page.locator('#awq-login-gate').waitFor();
    await page.locator('#awq-login-email').fill('tester@example.com');
    await page.locator('#awq-login-password').fill('test-only-password');
    await page.locator('#awq-login-form').press('Enter');
    await page.locator('#dispatcher-reminder[open]').waitFor();
    assert.equal(readinessCalls, 2, name + ': readiness opens again after a later successful login');
  }
  assert.deepEqual(pageErrors, [], name + ': no page errors');
  await page.close();
}

try {
  await verifyScenario('new login', false);
  await verifyScenario('restored session', true);
  console.log('PASS: anonymous startup sends no dashboard/readiness request; login reaches CONNECTED and opens Operational Readiness.');
} finally {
  await browser.close();
  await new Promise(function(resolve) { server.close(resolve); });
}
