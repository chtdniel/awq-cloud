import { chromium } from 'playwright';

const baseUrl = 'http://127.0.0.1:8788';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', message => console.log('[browser]', message.type(), message.text()));
console.log('opening page');
const bootstrap = await page.request.post(baseUrl + '/api/rpc', {
  data: { method: 'authBootstrap', args: ['local-auth-bootstrap-secret', 'admin@example.com', 'correct horse battery staple'] },
  headers: { Origin: baseUrl }
});
if (bootstrap.status() !== 200) throw new Error('Bootstrap failed: ' + await bootstrap.text());
console.log('bootstrap passed');
await page.goto(baseUrl + '/app');
await page.waitForSelector('#awq-login-gate', { timeout: 15000 });
console.log('login gate visible');
await page.locator('#awq-login-form').evaluate(form => {
  form.querySelector('#awq-login-email').value = 'admin@example.com';
  form.querySelector('#awq-login-password').value = 'correct horse battery staple';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
console.log('login submitted');
await page.waitForSelector('#awq-user-bar');
console.log('login passed');
if (!(await page.locator('#awq-user-bar').innerText()).startsWith('ADMIN')) throw new Error('Admin bar missing');
await page.locator('#awq-logout').dispatchEvent('click');
await page.waitForSelector('#awq-login-gate');
await browser.close();
console.log('Browser auth smoke test passed.');
