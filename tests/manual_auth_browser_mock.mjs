import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let loggedIn = false;
await page.route('**/api/rpc', async route => {
  const request = route.request();
  const body = request.postDataJSON();
  if (body.method === 'authMe' && !loggedIn) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required.' }) });
  if (body.method === 'authLogin') {
    loggedIn = true;
    return route.fulfill({ status: 200, headers: { 'Set-Cookie': '__Host-awq_session=mock-session; Path=/; Secure; HttpOnly; SameSite=Lax\nawq_csrf=mock-csrf; Path=/; Secure; SameSite=Lax' }, contentType: 'application/json', body: JSON.stringify({ data: { user: { email: 'admin@example.com', role: 'admin', mustChangePassword: false }, expiresAt: new Date(Date.now() + 3600000).toISOString() } }) });
  }
  if (body.method === 'authLogout') {
    loggedIn = false;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true } }) });
  }
  if (loggedIn) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true, user: 'admin@example.com', tier: 'admin', isAuthorized: true, canView: true, canEdit: true, canManageUsers: true } }) });
  return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required.' }) });
});
await page.goto('http://127.0.0.1:8788');
await page.waitForSelector('#awq-login-gate');
await page.locator('#awq-login-email').fill('admin@example.com');
await page.locator('#awq-login-password').fill('correct horse battery staple');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('#awq-user-bar');
await page.getByRole('button', { name: 'Logout' }).click();
await page.waitForSelector('#awq-login-gate');
await browser.close();
console.log('Browser auth UI smoke test passed with mocked RPC: login, account bar, logout, and login gate.');
