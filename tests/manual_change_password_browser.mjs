import { chromium } from 'playwright';

const baseUrl = 'https://auth-preview.awq-cloud.pages.dev';
const temporaryPassword = process.env.AWQ_TEST_TEMP_PASSWORD;
if (!temporaryPassword) throw new Error('AWQ_TEST_TEMP_PASSWORD is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(baseUrl);
await page.waitForSelector('#awq-login-gate', { timeout: 15000 });
await page.locator('#awq-login-form').evaluate((form, password) => {
  form.querySelector('#awq-login-email').value = 'christiandaniel@airasia.com';
  form.querySelector('#awq-login-password').value = password;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}, temporaryPassword);
await page.waitForSelector('#awq-user-bar', { timeout: 15000 });
await page.locator('#awq-change-password').click();
await page.waitForSelector('#awq-change-password-dialog', { timeout: 5000 });
await page.locator('#awq-current-password').fill('intentionally-wrong-old-password');
await page.locator('#awq-new-password').fill('not-used-test-password');
await page.locator('#awq-confirm-password').fill('not-used-test-password');
await page.locator('#awq-change-password-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
await page.waitForFunction(() => document.querySelector('#awq-change-password-error')?.textContent.includes('incorrect'));
console.log('Change-password dialog opened and displayed backend validation error without changing the account.');
await browser.close();
