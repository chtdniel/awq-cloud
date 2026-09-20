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

let profile = { fullName: null, iaaId: null, licNo: null };
let saveCalls = 0;
let adminSaveCalls = 0;
let conflictNext = false;

await mkdir('test-results/profile', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/api/rpc', route => {
    const { method, args } = route.request().postDataJSON();
    const ok = data => route.fulfill({ json: { data } });
    if (method === 'authMe') return ok({ user: 'tester@example.com', tier: 'admin', mustChangePassword: false, profile });
    if (method === 'authLogin') return ok({ user: { email: 'tester@example.com', role: 'admin' }, expiresAt: 'x' });
    if (method === 'authLogout') return ok({ ok: true });
    if (method === 'getSettingsAccessInfo') return ok({ ok: true, canView: true, canEdit: true, user: 'tester@example.com', tier: 'admin', isAuthorized: true, canManageUsers: true });
    if (method === 'profileSave') {
      saveCalls += 1;
      if (conflictNext) {
        conflictNext = false;
        return route.fulfill({ status: 409, json: { error: 'IAA ID is already used by another user.', code: 'PROFILE_CONFLICT', fields: { iaaId: 'IAA ID is already used by another user.' } } });
      }
      const f = args[0] || {};
      profile = { fullName: f.fullName || null, iaaId: (f.iaaId || '').toUpperCase() || null, licNo: (f.licNo || '').toUpperCase() || null };
      return ok({ ok: true, profile: { ...profile, updatedAt: '2026-09-18 00:00:00' } });
    }
    if (method === 'adminListUsers') return ok({ users: [
      { id: 1, email: 'tester@example.com', role: 'admin', isActive: 1, mustChangePassword: 0, failedLoginCount: 0, lockedUntil: null, createdAt: 'x', updatedAt: 'x', lastLoginAt: null, fullName: profile.fullName, iaaId: profile.iaaId, licNo: profile.licNo },
      { id: 2, email: 'second@example.com', role: 'readonly', isActive: 1, mustChangePassword: 0, failedLoginCount: 0, lockedUntil: null, createdAt: 'x', updatedAt: 'x', lastLoginAt: null, fullName: 'Second User', iaaId: 'IAA-777', licNo: null }
    ] });
    if (method === 'adminSaveProfile') {
      adminSaveCalls += 1;
      const f = args[1] || {};
      return ok({ ok: true, profile: { fullName: f.fullName || null, iaaId: (f.iaaId || '').toUpperCase() || null, licNo: (f.licNo || '').toUpperCase() || null, updatedAt: 'x' } });
    }
    return ok({});
  });

  await page.goto(base + '/app');
  await page.locator('#awq-account-toggle').waitFor();

  await page.locator('#awq-account-toggle').click();
  await page.locator('#awq-account-panel').waitFor();
  assert.equal(await page.locator('#awq-account-name').textContent(), 'tester@example.com', 'falls back to email when no name');

  await page.locator('#awq-profile').click();
  await page.locator('#awq-profile-dialog').waitFor();
  assert.equal(await page.locator('#awq-profile-email').inputValue(), 'tester@example.com');
  assert.equal(await page.locator('#awq-profile-save').isDisabled(), true, 'Save disabled when nothing changed');

  await page.locator('#awq-profile-iaa').fill('IAA-12a');
  await page.waitForFunction(() => document.getElementById('awq-profile-iaaId-error').textContent.length > 0);
  assert.equal(await page.locator('#awq-profile-save').isDisabled(), true, 'Save disabled on invalid IAA');

  await page.locator('#awq-profile-name').fill('Chris Daniel');
  await page.locator('#awq-profile-iaa').fill('iaa-123');
  await page.locator('#awq-profile-lic').fill('FOOL-881234');
  await page.waitForFunction(() => !document.getElementById('awq-profile-save').disabled);
  await page.locator('#awq-profile-save').click();
  await page.locator('#awq-profile-dialog').waitFor({ state: 'detached' });
  assert.equal(saveCalls, 1, 'profileSave called once');
  assert.deepEqual(profile, { fullName: 'Chris Daniel', iaaId: 'IAA-123', licNo: 'FOOL-881234' }, 'normalized payload persisted');
  assert.equal(await page.locator('#awq-account-name').textContent(), 'Chris Daniel', 'panel shows name after save');
  await page.screenshot({ path: 'test-results/profile/account-panel-name.png' });

  await page.locator('#awq-account-toggle').click();
  await page.locator('#awq-profile').click();
  await page.locator('#awq-profile-dialog').waitFor();
  assert.equal(await page.locator('#awq-profile-name').inputValue(), 'Chris Daniel', 'dialog prefills saved name');
  assert.equal(await page.locator('#awq-profile-iaa').inputValue(), 'IAA-123', 'dialog prefills saved IAA');
  assert.equal(await page.locator('#awq-profile-save').isDisabled(), true, 'Save disabled when unchanged');

  conflictNext = true;
  await page.locator('#awq-profile-iaa').fill('IAA-999');
  await page.waitForFunction(() => !document.getElementById('awq-profile-save').disabled);
  await page.locator('#awq-profile-save').click();
  await page.waitForFunction(() => document.getElementById('awq-profile-iaaId-error').textContent.includes('already used'));
  assert.equal(await page.locator('#awq-profile-dialog').count(), 1, 'dialog stays open on error');
  assert.equal(await page.locator('#awq-profile-save').isDisabled(), false, 'Save re-enabled to allow retry');
  await page.screenshot({ path: 'test-results/profile/dialog-field-error.png' });
  await page.locator('#awq-profile-cancel').click();
  await page.locator('#awq-profile-dialog').waitFor({ state: 'detached' });

  await page.waitForFunction(() => window.isSettingsAdmin === true);
  await page.evaluate(() => window.switchTab('settings'));
  await page.locator('[data-settings-tab="users"]').click();
  await page.evaluate(() => window.authUsersRefresh());
  await page.waitForFunction(() => document.getElementById('auth-users-list').textContent.includes('Second User'));
  const listHtml = await page.locator('#auth-users-list').innerHTML();
  assert.ok(listHtml.includes('IAA-777'), 'admin list shows IAA ID column');
  assert.ok(listHtml.includes('\u2014'), 'admin list renders em dash for unset LIC');
  await page.screenshot({ path: 'test-results/profile/admin-users-list.png' });

  await page.locator('[data-auth-profile="second@example.com"]').click();
  await page.locator('#auth-profile-backdrop.open').waitFor();
  assert.equal(await page.locator('#auth-profile-name').inputValue(), 'Second User');
  assert.equal(await page.locator('#auth-profile-iaa').inputValue(), 'IAA-777');
  assert.equal(await page.locator('#auth-profile-save').isDisabled(), true, 'admin Save disabled when unchanged');
  await page.locator('#auth-profile-name').fill('Second User Renamed');
  await page.waitForFunction(() => !document.getElementById('auth-profile-save').disabled);
  await page.locator('#auth-profile-save').click();
  await page.locator('#settings-modal-backdrop.open').waitFor();
  await page.screenshot({ path: 'test-results/profile/admin-confirm.png' });
  await page.locator('#settings-modal-ok').click();
  await page.waitForFunction(() => document.getElementById('auth-users-status').textContent.includes('successfully'));
  assert.equal(adminSaveCalls, 1, 'adminSaveProfile called once after confirmation');

  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log('PASS profile browser QA: account dialog (prefill/validation/save/conflict retry), panel name, admin list columns, admin modal + confirmation');
} finally {
  await browser.close();
  server.close();
}
