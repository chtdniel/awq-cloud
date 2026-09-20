// Settings access-awareness: an admin sees the panels, a non-admin sees the
// locked notice and nothing else — never both at once. That mixed state came
// from the navbar gate and the Settings module both writing panel visibility,
// so this test asserts the DOM state after the view is activated repeatedly.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/app') pathname = '/app/index.html';
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await mkdir('test-results/settings-access', { recursive: true });

function visibleState() {
  const q = id => document.getElementById(id);
  const shown = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  return {
    locked: shown(q('settings-account-locked')),
    adminPanels: shown(q('settings-admin-panels')),
    tabs: shown(q('settings-tabs')),
    lockedLine: q('settings-locked-access') ? q('settings-locked-access').textContent : '',
    cardRole: q('settings-kpi-mode') ? q('settings-kpi-mode').textContent : '',
    cardAccess: q('settings-kpi-auth') ? q('settings-kpi-auth').textContent : ''
  };
}

async function scenario(tier, options = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const adminMethodCalls = [];
  page.on('pageerror', error => errors.push(error.message));

  const canView = tier === 'admin';
  await page.route('**/api/rpc', route => {
    const { method } = route.request().postDataJSON();
    const ok = data => route.fulfill({ json: { data } });
    if (method === 'authMe') return ok({ user: 'viewer@example.com', tier, mustChangePassword: false, profile: null });
    if (method === 'getSettingsAccessInfo') {
      return ok({ ok: true, user: 'viewer@example.com', tier, role: tier, isAuthorized: true, canView, canEdit: tier !== 'readonly', canManageUsers: tier === 'admin' });
    }
    if (method === 'getSettingsBundle') {
      if (!canView) return route.fulfill({ status: 403, json: { error: 'Forbidden: administrator access is required for this operation.', code: 'ADMIN_REQUIRED', tier } });
      return ok({ ok: true, access: { tier }, settings: { ok: true, allowed: [], raw: '', currentUser: 'viewer@example.com', accountRole: 'admin', isLegacy: true, readOnly: true, revision: 'abc' }, admins: { ok: true, admins: [], currentUser: 'viewer@example.com', revision: 'abc' }, system: { ok: true, dataSource: 'Cloudflare D1 (awq-db)', timezone: 'Asia/Makassar' }, wx: { ok: true, enabled: true, catalog: [], revision: 'abc', source: 'default' } });
    }
    if (method === 'adminListUsers') { adminMethodCalls.push(method); return ok({ users: [] }); }
    if (method === 'adminListAudit') { adminMethodCalls.push(method); return ok({ entries: [], limit: 100, pruned: 0, retention: { maxAgeDays: 180, maxRows: 5000 } }); }
    if (method === 'getOccSettings' || method === 'getSettingsAdminList' || method === 'getOccSystemSettings') {
      adminMethodCalls.push(method);
      if (!canView) return route.fulfill({ status: 403, json: { error: 'Forbidden', code: 'ADMIN_REQUIRED' } });
      return ok({ ok: true });
    }
    return ok({});
  });

  await page.goto(base + '/app');
  // The navbar gate resolves asynchronously before the tab is safe to open.
  if (options.waitForGate) await page.waitForFunction(() => window.isSettingsAdmin !== null).catch(() => {});

  if (options.activateThenReactivate) {
    // Reported flow: the authorization check resolves BEFORE the Settings view
    // is activated, so a later activation must still paint the locked state.
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document.getElementById('view-settings').classList.add('active');
      if (typeof window.settingsRefreshAll === 'function') window.settingsRefreshAll();
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      document.getElementById('view-settings').classList.remove('active');
      if (typeof window.settingsRefreshAll === 'function') window.settingsRefreshAll();
    });
    await page.waitForTimeout(250);
  } else {
    // Activate the Settings view the way the app does, twice, to expose races.
    await page.evaluate(() => {
      document.getElementById('view-settings').classList.add('active');
      if (typeof window.settingsRefreshAll === 'function') window.settingsRefreshAll();
    });
    await page.evaluate(() => {
      if (typeof window.settingsRefreshAll === 'function') window.settingsRefreshAll();
    });
    await page.waitForTimeout(400);
  }

  const state = await page.evaluate(visibleState);
  await page.screenshot({ path: `test-results/settings-access/${tier}${options.activateThenReactivate ? '-reactivated' : ''}.png` });
  await browser.close();
  return { state, errors, adminMethodCalls };
}

// Non-admin: locked notice only, no admin panels, no tabs, no admin RPCs.
for (const tier of ['registered', 'readonly']) {
  const { state, errors, adminMethodCalls } = await scenario(tier);
  assert.deepEqual(errors, [], `${tier}: no uncaught page errors`);
  assert.equal(state.locked, true, `${tier}: the locked notice must be visible`);
  assert.equal(state.adminPanels, false, `${tier}: admin panels must be hidden`);
  assert.equal(state.tabs, false, `${tier}: the tab strip must be hidden`);
  assert.ok(/UPDATE|VIEW ONLY/.test(state.lockedLine), `${tier}: locked line must state the access level, got "${state.lockedLine}"`);
  assert.equal(state.cardRole, tier.toUpperCase(), `${tier}: the access card must still name the role`);
  assert.deepEqual(adminMethodCalls, [], `${tier}: no admin RPC may be called`);
  console.log(`PASS ${tier}: locked notice only, admin panels hidden, zero admin RPC calls.`);
}

// Admin: panels and tabs visible, locked notice hidden.
{
  const { state, errors } = await scenario('admin');
  assert.deepEqual(errors, [], 'admin: no uncaught page errors');
  assert.equal(state.locked, false, 'admin: the locked notice must stay hidden');
  assert.equal(state.adminPanels, true, 'admin: panels must be visible');
  assert.equal(state.tabs, true, 'admin: the tab strip must be visible');
  assert.equal(state.cardAccess, 'FULL', 'admin: the access card must report FULL');
  console.log('PASS admin: panels and tabs visible, locked notice hidden.');
}

// Regression: check resolves first, then the view is activated and deactivated.
// The old in-flight guard returned early on the second call, so the locked
// notice never appeared even though access was denied.
for (const tier of ['registered', 'readonly']) {
  const { state, errors, adminMethodCalls } = await scenario(tier, { activateThenReactivate: true });
  assert.deepEqual(errors, [], `${tier}: no uncaught page errors after re-activation`);
  assert.equal(state.locked, true, `${tier}: locked notice must be repainted after re-activation`);
  assert.equal(state.adminPanels, false, `${tier}: admin panels must stay hidden`);
  assert.ok(/UPDATE|VIEW ONLY/.test(state.lockedLine), `${tier}: locked line must be filled, got "${state.lockedLine}"`);
  assert.deepEqual(adminMethodCalls, [], `${tier}: still no admin RPC after re-activation`);
  console.log(`PASS ${tier}: locked notice repainted after the check resolved first.`);
}

// The gate must not be the one painting the locked panel.
{
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.route('**/api/rpc', route => {
    const { method } = route.request().postDataJSON();
    if (method === 'authMe') return route.fulfill({ json: { data: { user: 'viewer@example.com', tier: 'registered', mustChangePassword: false, profile: null } } });
    if (method === 'getSettingsAccessInfo') return route.fulfill({ json: { data: { ok: true, user: 'viewer@example.com', tier: 'registered', role: 'registered', isAuthorized: true, canView: false, canEdit: true } } });
    return route.fulfill({ status: 403, json: { error: 'Forbidden', code: 'ADMIN_REQUIRED' } });
  });
  await page.goto(base + '/app');
  await page.waitForFunction(() => window.isSettingsAdmin === false).catch(() => {});
  // Force the blocked path directly.
  await page.evaluate(() => { if (typeof window.switchTab === 'function') window.switchTab('settings'); });
  await page.waitForTimeout(300);
  const state = await page.evaluate(visibleState);
  assert.equal(state.adminPanels, false, 'blocked switchTab must never reveal admin panels');
  assert.equal(state.tabs, false, 'blocked switchTab must never reveal the tab strip');
  await page.screenshot({ path: 'test-results/settings-access/switchtab-blocked.png' });
  await browser.close();
  console.log('PASS blocked switchTab: no admin panels revealed.');
}

console.log('Settings access-awareness browser QA passed.');
