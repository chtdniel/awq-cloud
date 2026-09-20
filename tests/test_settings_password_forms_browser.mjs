import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Chrome memperingatkan "[DOM] Password field is not contained in a form" untuk
// tiga input password di Settings_Ui.html. Test ini menjaga perbaikannya:
// ketiganya harus benar-benar berada di dalam <form>, dan pembungkus form itu
// tidak boleh mengubah layout modal (grid .modal, jarak 12px).
//
// Asersi terpenting ada di bagian akhir: satu Enter hanya boleh menghasilkan
// SATU panggilan adminResetPassword. Tombol save dulu type="button" dengan
// listener click; setelah jadi type="submit", listener click yang tertinggal
// membuat satu klik menjalankan handler dua kali (click + submit) — artinya
// dua kali reset password ke akun yang sama.

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');

const artifactDirectory = join(tmpdir(), 'awq-settings-forms-' + Date.now());
await mkdir(artifactDirectory);

const publicDirectory = resolve('public');
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
async function asset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname === '/app' ? '/app/index.html' : pathname));
  if (!filename.startsWith(publicDirectory + '\\') && !filename.startsWith(publicDirectory + '/')) return new Response('Forbidden', { status: 403 });
  try { return new Response(await readFile(filename), { headers: { 'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
}

// getOperationalReadiness sengaja dijawab tanpa `ok`: jalur itu hanya menandai
// status UNAVAILABLE dan TIDAK memanggil dialog.showModal(), jadi dialog
// readiness tidak menutupi halaman dan klik di test ini tidak terblokir.
function stub(method, args) {
  switch (method) {
    case 'authMe': return { user: 'admin@example.com', tier: 'admin', mustChangePassword: false, profile: null };
    case 'getSettingsAccessInfo': return { ok: true, canView: true, tier: 'admin' };
    case 'adminListUsers': return { users: [{ email: 'tester@example.com', role: 'readonly', isActive: 1, fullName: 'Test User', iaaId: null, licNo: null }] };
    case 'adminResetPassword': return { ok: true, email: args && args[0] };
    case 'adminCreateUser': return { ok: true };
    default: return {};
  }
}

const rpcCalls = [];
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === '/api/rpc') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const { method, args } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      rpcCalls.push({ method, args });
      const response = Response.json({ data: stub(method, args) }, { headers: { 'Cache-Control': 'no-store' } });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const response = await asset(new Request('http://' + incoming.headers.host + incoming.url));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// Kalau form ter-submit native (lupa preventDefault), halaman reload dan
// penghitung ini naik jadi 2.
await context.addInitScript(() => { window.__navCount = (window.__navCount || 0) + 1; });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('PASS ' + label); }
  catch (error) { failures += 1; console.error('FAIL ' + label + ': ' + error.message); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log('PASS ' + label); }
  catch (error) { failures += 1; console.error('FAIL ' + label + ': ' + error.message); }
}
const resetCalls = () => rpcCalls.filter(call => call.method === 'adminResetPassword').length;

try {
  await page.goto(baseUrl + '/app', { waitUntil: 'domcontentloaded' });
  // Gate admin menentukan #nav-settings tampil; isSettingsAdmin diset server-side.
  await page.waitForFunction(() => window.isSettingsAdmin === true, null, { timeout: 20000 });

  // ---- Struktur: ketiga input password harus punya form induk ----
  const structure = await page.evaluate(() => {
    const info = id => {
      const el = document.getElementById(id);
      return { exists: !!el, formId: el && el.form ? el.form.id : null, type: el ? el.type : null };
    };
    const resetForm = document.getElementById('auth-reset-form');
    return {
      createPassword: info('auth-user-password'),
      resetPassword: info('auth-reset-password'),
      resetConfirm: info('auth-reset-confirm'),
      resetSave: info('auth-reset-save'),
      bodyInsideForm: !!(resetForm && resetForm.querySelector('.modal-body')),
      actionsInsideForm: !!(resetForm && resetForm.querySelector('.modal-actions')),
      titleOutsideForm: !!(resetForm && !resetForm.contains(document.getElementById('auth-reset-title')))
    };
  });
  check('temporary password berada di dalam form', () => assert.equal(structure.createPassword.formId, 'auth-create-user-form'));
  check('password reset berada di dalam form', () => assert.equal(structure.resetPassword.formId, 'auth-reset-form'));
  check('konfirmasi password reset berada di dalam form', () => assert.equal(structure.resetConfirm.formId, 'auth-reset-form'));
  check('tombol save reset di dalam form dan type=submit', () => {
    assert.equal(structure.resetSave.formId, 'auth-reset-form');
    assert.equal(structure.resetSave.type, 'submit');
  });
  check('modal-body dan modal-actions berada di dalam form', () => {
    assert.equal(structure.bodyInsideForm, true);
    assert.equal(structure.actionsInsideForm, true);
  });
  check('judul modal tetap di luar form', () => assert.equal(structure.titleOutsideForm, true));

  // ---- Layout: pembungkus harus meniru grid .modal supaya jarak tetap 12px ----
  const layout = await page.evaluate(() => {
    const create = getComputedStyle(document.getElementById('auth-create-user-form'));
    const reset = getComputedStyle(document.getElementById('auth-reset-form'));
    const modal = getComputedStyle(document.querySelector('#auth-reset-backdrop .modal'));
    return {
      createDisplay: create.display,
      createColumnCount: create.gridTemplateColumns.split(' ').length,
      resetDisplay: reset.display,
      resetRowGap: reset.rowGap,
      modalGap: modal.gap
    };
  });
  check('form create user tetap grid 4 kolom', () => {
    assert.equal(layout.createDisplay, 'grid');
    assert.equal(layout.createColumnCount, 4, `kolom: ${layout.createColumnCount}`);
  });
  check('form modal reset tetap grid dengan jarak sama seperti .modal', () => {
    assert.equal(layout.resetDisplay, 'grid');
    assert.equal(layout.resetRowGap, layout.modalGap, `reset ${layout.resetRowGap} vs modal ${layout.modalGap}`);
  });

  // ---- Buka Settings → tab Internal Users (daftar user ada di panel itu,
  // bukan panel default "access"), lalu pakai tombol Refresh-nya sendiri ----
  await page.click('#nav-settings');
  await page.click('#view-settings [data-settings-tab="users"]');
  await page.waitForSelector('#auth-users-panel:not([hidden])', { timeout: 10000 });
  await page.click('#auth-users-panel .settings-head button');
  await page.waitForSelector('#auth-users-list [data-auth-reset]', { timeout: 20000 });
  await page.click('#auth-users-list [data-auth-reset]');
  await page.waitForSelector('#auth-reset-backdrop.open', { timeout: 10000 });
  await page.evaluate(() => {
    window.__resetSubmits = 0;
    document.getElementById('auth-reset-form').addEventListener('submit', () => { window.__resetSubmits += 1; });
  });

  const password = 'correct horse battery staple';
  await page.fill('#auth-reset-password', password);
  await page.fill('#auth-reset-confirm', password);
  await checkAsync('tombol save aktif setelah dua password cocok', async () => {
    assert.equal(await page.locator('#auth-reset-save').isEnabled(), true);
  });

  const before = resetCalls();
  await page.locator('#auth-reset-confirm').press('Enter');
  await page.waitForFunction(() => !document.getElementById('auth-reset-backdrop').classList.contains('open'), null, { timeout: 15000 });
  await page.waitForTimeout(400); // beri kesempatan panggilan kedua menyusul kalau ada

  const delta = resetCalls() - before;
  const submits = await page.evaluate(() => window.__resetSubmits);
  check('Enter di form reset menghasilkan tepat satu submit', () => assert.equal(submits, 1, `submit: ${submits}`));
  check('Enter di form reset menghasilkan tepat satu panggilan adminResetPassword', () => assert.equal(delta, 1, `panggilan: ${delta}`));
  await checkAsync('halaman tidak reload saat submit form reset', async () => {
    assert.equal(await page.evaluate(() => window.__navCount), 1);
  });
  await page.screenshot({ path: join(artifactDirectory, 'settings-reset-modal.png'), fullPage: true });

  // ---- Form create user: Enter lewat handler, bukan submit native ----
  await page.evaluate(() => {
    window.__createSubmits = 0;
    document.getElementById('auth-create-user-form').addEventListener('submit', () => { window.__createSubmits += 1; });
  });
  await page.fill('#auth-user-email', 'baru@example.com');
  await page.fill('#auth-user-password', '');
  await page.locator('#auth-user-email').press('Enter');
  await page.waitForTimeout(300);

  await checkAsync('Enter dengan password kosong menampilkan hint validasi', async () => {
    assert.match(await page.locator('#auth-users-status').innerText(), /at least 12 characters/);
  });
  await checkAsync('Enter dengan password kosong tidak membuka modal konfirmasi', async () => {
    assert.equal(await page.evaluate(() => document.getElementById('settings-modal-backdrop').classList.contains('open')), false);
  });
  await checkAsync('Enter pada form create hanya menghasilkan satu submit', async () => {
    assert.equal(await page.evaluate(() => window.__createSubmits), 1);
  });

  // Dengan password valid, Enter harus membuka modal konfirmasi (jalur lama).
  await page.fill('#auth-user-password', password);
  await page.locator('#auth-user-email').press('Enter');
  await checkAsync('Enter dengan password valid membuka modal konfirmasi', async () => {
    await page.waitForSelector('#settings-modal-backdrop.open', { timeout: 10000 });
  });
  await checkAsync('halaman tetap tidak reload setelah kedua form', async () => {
    assert.equal(await page.evaluate(() => window.__navCount), 1);
  });
  await page.screenshot({ path: join(artifactDirectory, 'settings-create-user.png'), fullPage: true });

  check('tidak ada JS error di halaman', () => assert.deepEqual(pageErrors, []));
} catch (error) {
  failures += 1;
  console.error('FAIL (skenario): ' + error.message);
} finally {
  console.log(`\nQA artifacts: ${artifactDirectory}`);
  await context.close();
  await browser.close();
  server.close();
}

if (failures) {
  console.error(`\n${failures} pemeriksaan gagal.`);
  process.exit(1);
}
console.log('Semua pemeriksaan form password Settings lulus.');
