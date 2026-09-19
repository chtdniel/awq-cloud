import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bug yang direproduksi: operator mengklik pil ATC pada baris yang jauh di bawah
// daftar (flight 534, SENT -> UNSENT) tetapi dialog CONFIRM ATC CHANGE muncul
// menempel di baris lain yang sedang tidak berhubungan (648/649).
//
// Sebabnya: `.atc-confirm-popover` diposisikan `position: absolute`, sementara
// koordinatnya diambil dari `getBoundingClientRect()` yang berbasis VIEWPORT.
// Karena body adalah containing block (body punya position: relative), nilai
// `top` diukur dari awal dokumen, sehingga popover selalu meleset ke atas
// sebesar scroll halaman. Di skrinsut operator selisihnya ~490px.
//
// Asersi di sini sengaja mengukur posisi popover terhadap pil yang diklik, bukan
// sekadar "popover muncul", supaya bug meleset-ke-atas tidak bisa lulus palsu.
// Setiap skenario memakai halaman baru (dokumen bersih).

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');

const publicDirectory = resolve('public');
// Halaman yang diuji default-nya build di public/. ATC_PAGE_FILE dipakai untuk
// membandingkan dengan build lain (mis. index.html sebelum perbaikan) di
// lingkungan yang sama, supaya bukti "sebelum vs sesudah" bisa direproduksi.
const pageFile = process.env.ATC_PAGE_FILE ? resolve(process.env.ATC_PAGE_FILE) : null;
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
async function asset(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  if (pageFile && (pathname === '/' || pathname === '/index.html')) {
    return new Response(await readFile(pageFile), { headers: { 'Content-Type': 'text/html' } });
  }
  const filename = resolve(publicDirectory, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(publicDirectory + '\\') && !filename.startsWith(publicDirectory + '/')) return new Response('Forbidden', { status: 403 });
  try { return new Response(await readFile(filename), { headers: { 'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = 'http://' + incoming.headers.host + incoming.url;
    const response = await asset(new Request(url));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

// CI menjalankan browser sendiri. Di lingkungan yang memblokir piped stdio
// (spawn EPERM), browser bisa dinyalakan di luar Node lalu dihubungkan lewat CDP
// dengan mengisi DSH_ATC_CDP=http://127.0.0.1:<port>.
const browser = process.env.DSH_ATC_CDP
  ? await chromium.connectOverCDP(process.env.DSH_ATC_CDP)
  : await chromium.launch({ headless: true });
const ownsBrowser = !process.env.DSH_ATC_CDP;

// Halaman hanya butuh SATU pil ATC di tengah dokumen yang tinggi, supaya
// operator "menggulir jauh ke bawah" seperti pada laporan. Pil-nya memakai
// markup persis seperti yang digenerate renderBoard (termasuk ikon <svg>).
const SEED_PAGE = () => {
  // Halaman ini dijalankan tanpa backend, jadi shim menampilkan gerbang login
  // yang menutupi seluruh layar dan menelan klik. Singkirkan (termasuk kalau
  // muncul menyusul) supaya klik pil benar-benar sampai ke pil.
  const dropGate = () => { const gate = document.getElementById('awq-login-gate'); if (gate) gate.remove(); };
  dropGate();
  new MutationObserver(dropGate).observe(document.body, { childList: true, subtree: true });

  const spacer = document.createElement('div');
  spacer.style.height = '3000px';
  document.body.appendChild(spacer);

  const row = document.createElement('div');
  row.id = 'atc-test-row';
  row.style.cssText = 'padding:24px;';
  row.innerHTML = '<button type="button" class="atc-pill atc-sent" data-row-idx="534" data-atc="SENT" data-flight="534"'
    + ' title="ATC SENT — click for options"'
    + ' onclick="window.showATCConfirmPopover(event, 534, \'SENT\', \'UNSENT\')" style="cursor: pointer;">'
    + '<svg class="ic atc-ic"><use href="#i-check-circle"/></svg>SENT</button>';
  document.body.appendChild(row);

  const tail = document.createElement('div');
  tail.style.height = '1200px';
  document.body.appendChild(tail);

  // Stub RPC: mencatat ke baris mana saveFlightData diarahkan saat CONFIRM ditekan.
  window.__atcSaves = [];
  window.__renders = 0;
  window.renderBoard = () => { window.__renders += 1; };
  window.allDbFlights = [{ rowIdx: 534, FLIGHT: '534', ATC: 'SENT' }];
  window.google = window.google || {};
  // Rantai seperti runner Cloudflare: withSuccessHandler(H).withFailureHandler(F).saveFlightData(...)
  const record = (success) => (rowId, colIdx, value, type) => {
    window.__atcSaves.push({ rowId, colIdx, value, type });
    if (success) success();
  };
  const chain = (success) => ({
    withSuccessHandler: (next) => chain(next),
    withFailureHandler: () => ({ saveFlightData: record(success) }),
    saveFlightData: record(success)
  });
  window.google.script = {
    run: new Proxy({ withSuccessHandler: (success) => chain(success) }, { get: (target, prop) => (prop in target ? target[prop] : () => {}) })
  };
};

// Taruh pil di ~35% tinggi viewport SETELAH dokumen digulir jauh, lalu pastikan
// masih ada ruang di bawahnya supaya popover tidak perlu flip ke atas.
async function scrollIntoView(page) {
  return page.evaluate(() => {
    window.scrollTo(0, 0);
    const pill = document.querySelector('#atc-test-row .atc-pill');
    const docTop = pill.getBoundingClientRect().top;
    const want = Math.max(160, Math.round(window.innerHeight * 0.35));
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(docTop - want, maxScroll));
    const rect = pill.getBoundingClientRect();
    return { scrollY: window.scrollY, innerHeight: window.innerHeight, pillTop: rect.top, pillBottom: rect.bottom, roomBelow: window.innerHeight - rect.bottom };
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const popover = document.querySelector('.atc-confirm-popover');
    const pill = document.querySelector('#atc-test-row .atc-pill');
    const pick = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return {
      popover: pick(popover),
      pill: pick(pill),
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      scrollY: window.scrollY,
      text: popover ? popover.textContent.replace(/\s+/g, ' ').trim() : '',
      saves: window.__atcSaves,
      renders: window.__renders,
      undoAvailable: typeof window.undoLastATCChange === 'function',
      status: (window.allDbFlights[0] || {}).ATC
    };
  });
}

const browserContext = process.env.DSH_ATC_CDP ? browser.contexts()[0] : null;
let failures = 0;

async function withPage(name, body) {
  const context = browserContext || await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (!browserContext) await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.showATCConfirmPopover === 'function', null, { timeout: 20000 });
    await page.evaluate(SEED_PAGE);
    await body(page);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await page.close();
    if (!browserContext) await context.close();
  }
}

function assertAnchored(view, label) {
  assert.ok(view.popover, `${label}: popover CONFIRM ATC CHANGE harus muncul`);
  const gap = view.popover.top - view.pill.bottom;
  assert.ok(Math.abs(gap - 8) <= 2,
    `${label}: popover harus 8px di bawah pil yang diklik, dapat ${gap.toFixed(1)}px (scrollY ${view.scrollY})`);
  assert.ok(Math.abs(view.popover.left - view.pill.left) <= 2,
    `${label}: popover harus sejajar kiri dengan pil, dapat selisih ${(view.popover.left - view.pill.left).toFixed(1)}px`);
  assert.ok(view.popover.top >= 0 && view.popover.bottom <= view.innerHeight,
    `${label}: popover harus terlihat penuh di viewport (top ${view.popover.top.toFixed(1)}, bottom ${view.popover.bottom.toFixed(1)}, tinggi viewport ${view.innerHeight})`);
  assert.ok(!view.text.includes('648') && !view.text.includes('649'),
    `${label}: dialog tidak boleh menyebut baris lain`);
}

// Buka popover, lalu tunggu animasi popoverSlideIn (0.2s) selesai: selama
// animasi, transform translateY(-8px) masih menggeser posisi terukurnya.
async function openPopover(page, { viaIcon = false } = {}) {
  if (viaIcon) {
    // Klik yang mendarat di elemen ikon <use> di dalam pil, bukan di tombolnya.
    await page.locator('#atc-test-row .atc-pill use').dispatchEvent('click');
  } else {
    const pill = page.locator('#atc-test-row .atc-pill');
    const box = await pill.boundingBox();
    await pill.click({ position: { x: box.width - 10, y: box.height / 2 } }); // area teks, bukan ikon
  }
  await page.waitForTimeout(320);
}

// Skenario 1 — inti laporan: klik teks pil pada baris yang jauh di bawah.
await withPage('klik pil SENT pada baris terbawah menempel di baris itu', async (page) => {
  const seed = await scrollIntoView(page);
  assert.ok(seed.scrollY > 800, `prasyarat: dokumen harus tergulir jauh (scrollY ${seed.scrollY})`);
  assert.ok(seed.roomBelow >= 200, `prasyarat: butuh ruang di bawah pil (${seed.roomBelow}px)`);

  await openPopover(page);

  const view = await measure(page);
  assertAnchored(view, 'skenario 1');
  assert.match(view.text, /CONFIRM ATC CHANGE/);
  assert.match(view.text, /SENT/);
  assert.match(view.text, /UNSENT/);
});

// Skenario 2 — ikon di dalam pil juga jadi target klik. Anchor harus tetap kotak
// pil, bukan kotak ikon yang lebih kecil.
await withPage('klik ikon di dalam pil tetap menempel ke pil', async (page) => {
  const seed = await scrollIntoView(page);
  assert.ok(seed.scrollY > 800, `prasyarat: dokumen harus tergulir jauh (scrollY ${seed.scrollY})`);

  // Buktikan klik benar-benar mendarat di ikon, bukan di tombolnya.
  await page.evaluate(() => {
    window.__lastClickTarget = null;
    document.addEventListener('click', (event) => { window.__lastClickTarget = event.target.tagName.toLowerCase(); }, true);
  });
  await openPopover(page, { viaIcon: true });
  assert.equal(await page.evaluate(() => window.__lastClickTarget), 'use',
    'prasyarat skenario 2: target klik harus elemen ikon <use>');

  const view = await measure(page);
  assertAnchored(view, 'skenario 2');
});

// Skenario 3 — popover tidak boleh menggantung di baris lain saat halaman
// digulir: harus ikut anchor atau ditutup.
await withPage('popover tidak tertinggal di baris lain saat digulir', async (page) => {
  await scrollIntoView(page);
  await openPopover(page);

  await page.evaluate(() => window.scrollBy(0, 220));
  await page.waitForTimeout(320);

  const view = await measure(page);
  if (view.popover) {
    const gap = view.popover.top - view.pill.bottom;
    assert.ok(Math.abs(gap - 8) <= 2,
      `skenario 3: popover harus ikut pil setelah digulir, dapat ${gap.toFixed(1)}px`);
  }
});

// Skenario 4 — CONFIRM harus tetap mengubah baris yang diklik (534/kolom 14),
// jadi yang perlu diperbaiki hanya posisi dialognya.
await withPage('CONFIRM mengirim perubahan ke baris yang diklik', async (page) => {
  await scrollIntoView(page);
  await openPopover(page);

  await page.locator('.atc-confirm-popover .popover-btn:not(.cancel)').click();
  await page.waitForTimeout(60);

  const view = await measure(page);
  assert.deepEqual(view.saves, [{ rowId: 534, colIdx: 14, value: 'UNSENT', type: 'text' }],
    'skenario 4: saveFlightData harus diarahkan ke baris 534 kolom ATC');
  assert.equal(view.renders, 1, 'skenario 4: board harus dirender ulang setelah sukses');
  assert.equal(view.popover, null, 'skenario 4: popover harus tertutup setelah CONFIRM');
});

// Skenario 5 — jendela undo habis TIDAK boleh membatalkan perubahan. Versi lama
// melakukan saveFlightData(oldStatus) di dalam timeout, jadi status ATC kembali
// sendiri 5 detik setelah dikonfirmasi.
await withPage('perubahan ATC tidak dibatalkan sendiri setelah jendela undo habis', async (page) => {
  await scrollIntoView(page);
  await openPopover(page);
  await page.locator('.atc-confirm-popover .popover-btn:not(.cancel)').click();

  await page.waitForTimeout(5600); // ATC_UNDO_WINDOW_MS (5s) + margin

  const view = await measure(page);
  assert.deepEqual(view.saves, [{ rowId: 534, colIdx: 14, value: 'UNSENT', type: 'text' }],
    'skenario 5: hanya satu tulisan (UNSENT); tidak boleh ada tulisan pembatalan');
  assert.equal(view.status, 'UNSENT', 'skenario 5: status ATC harus tetap UNSENT');
  assert.equal(view.undoAvailable, false, 'skenario 5: kesempatan undo harus sudah kedaluwarsa');
});

// Skenario 6 — Ctrl+Z di dalam jendela undo tetap berfungsi.
await withPage('Ctrl+Z di dalam jendela undo mengembalikan status ATC', async (page) => {
  await scrollIntoView(page);
  await openPopover(page);
  await page.locator('.atc-confirm-popover .popover-btn:not(.cancel)').click();
  await page.waitForTimeout(120);

  assert.equal(await page.evaluate(() => typeof window.undoLastATCChange), 'function',
    'prasyarat skenario 6: undo harus tersedia di dalam jendela 5 detik');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
  await page.waitForTimeout(120);

  const view = await measure(page);
  assert.deepEqual(view.saves, [
    { rowId: 534, colIdx: 14, value: 'UNSENT', type: 'text' },
    { rowId: 534, colIdx: 14, value: 'SENT', type: 'text' }
  ], 'skenario 6: Ctrl+Z harus menulis balik status lama (SENT)');
  assert.equal(view.status, 'SENT', 'skenario 6: status ATC kembali SENT');
  assert.equal(view.undoAvailable, false, 'skenario 6: undo sekali pakai, lalu tidak tersedia lagi');
});

await server.close();
if (ownsBrowser) await browser.close();
if (failures) {
  console.error(`\n${failures} skenario gagal.`);
  process.exit(1);
}
console.log('Semua skenario posisi popover ATC lulus.');
