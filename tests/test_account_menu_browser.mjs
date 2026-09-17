import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const base = process.env.AWQ_MENU_URL || 'https://awq-cloud.pages.dev';
const local = !process.env.AWQ_MENU_URL;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
mkdirSync('test-results/account-menu', { recursive: true });
try {
 for (const width of [375,768,1280,1920]) {
  const page = await browser.newPage({viewport:{width,height:800}});
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  let loggedIn=true, failLogout=true;
  if(local) await page.route('**/cloudflare-shim.js', route=>route.fulfill({contentType:'application/javascript',body:readFileSync('public/cloudflare-shim.js','utf8')}));
  await page.route('**/api/rpc', route=>{
   const {method}=route.request().postDataJSON();
   let data={};
   if(method==='authMe') data={user:loggedIn?'tester@example.com':null,tier:'admin'};
   if(method==='authLogin') {loggedIn=true; data={user:{email:'tester@example.com',role:'admin'}};}
   if(method==='authLogout') {
    if(failLogout) {failLogout=false; return route.fulfill({status:503,json:{error:'Test failure'}});}
    loggedIn=false; data={ok:true};
   }
   if(method==='getAccessContext') data={user:'tester@example.com',tier:'admin',isAuthorized:true,canView:true,canEdit:true,canManageUsers:true};
   return route.fulfill({json:{data}});
  });
  await page.goto(base);
  const toggle=page.locator('#awq-account-toggle'), panel=page.locator('#awq-account-panel');
  await toggle.waitFor();
  assert.equal(await panel.isVisible(),false);
  await page.evaluate(() => {
    window.allDbFlights = Array.from({length:10}, (_,i)=>({rowIdx:i+1, FLIGHT:String(640+i), DEP:'WADD', ARR:'WATO', REG:'PK-AZK', DOF:'20260916', STD:'03:25', STA:'04:40'}));
    window.activeBoardRowIds = window.allDbFlights.map(f=>f.rowIdx);
    window.renderBoard();
  });
  await page.locator('#master-cb').check();
  const fab=page.locator('#bulk-fab');
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('bulk-fab')).opacity==='1');
  const accountBox=await toggle.boundingBox(), fabBox=await fab.boundingBox();
  assert(accountBox.x>=0 && accountBox.x+accountBox.width<=width);
  assert(accountBox.y+accountBox.height<fabBox.y, 'Account must clear selected-flight actions');
  assert.equal(await toggle.evaluate(el=>Boolean(el.closest('.occ-nav-bar'))),true);
  await fab.click();
  assert.equal(await page.locator('#bulk-action-panel').evaluate(el=>el.classList.contains('active')),true);
  await fab.click();
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('bulk-action-panel')).opacity==='0');
  await page.screenshot({path:`test-results/account-menu/${local?'local':'deployed'}-${width}-closed.png`});
  await toggle.click(); await panel.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  const box=await panel.boundingBox(); assert(box.x>=0 && box.x+box.width<=width);
  assert(box.y>=accountBox.y+accountBox.height, 'Menu opens below header trigger');
  await page.screenshot({path:`test-results/account-menu/${local?'local':'deployed'}-${width}-open.png`});
  await page.keyboard.press('Escape'); await panel.waitFor({state:'hidden'});
  await toggle.focus(); await page.keyboard.press('Enter'); await panel.waitFor();
  await page.keyboard.press('Tab'); assert.equal(await page.locator('#awq-profile').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Enter'); await page.locator('#awq-profile-dialog').waitFor();
  assert.equal(await panel.isVisible(),false);
  await page.locator('#awq-profile-cancel').click();
  await toggle.click(); await panel.waitFor();
  await page.setViewportSize({width,height:780}); await panel.waitFor({state:'hidden'});
  await page.setViewportSize({width,height:800});
  await toggle.click(); await panel.waitFor(); await page.mouse.click(8,8); await panel.waitFor({state:'hidden'});
  await toggle.click(); await page.locator('#awq-logout').click();
  await page.locator('#awq-account-error').waitFor();
  assert.equal(await page.locator('#awq-logout').isEnabled(),true);
  await page.locator('#awq-logout').click(); await page.locator('#awq-login-gate').waitFor();
  assert.equal(await toggle.count(),0);
  await page.locator('#awq-login-email').fill('tester@example.com');
  await page.locator('#awq-login-password').fill('test-only-password');
  await page.locator('#awq-login-form button').click(); await toggle.waitFor();
  assert.equal(await panel.isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${width}px: default hidden, toggle, Escape, keyboard, password dialog, outside click, logout failure/retry, login again; no JS exceptions`);
  await page.close();
 }
} finally {await browser.close();}
