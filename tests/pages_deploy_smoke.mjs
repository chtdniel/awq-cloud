// Smoke test pasca-deploy Cloudflare Pages — tanpa sesi operator.
//
// Deploy produksi di repo ini lewat integrasi Git Cloudflare Pages (push ke main),
// bukan skrip di repo. Jadi bukti yang bisa diambil otomatis adalah:
//   1. host produksi menjawab dan menyajikan app yang SAMA dengan build lokal yang
//      sudah diuji (selisih hanya CRLF checkout Windows vs build Linux Cloudflare),
//   2. semua blok <script> inline yang tayang tetap terkompilasi,
//   3. /api/rpc hidup dan gagal-tertutup tanpa sesi (401 JSON, bukan 404/HTML),
//   4. tidak ada data NOTAM yang bocor tanpa autentikasi.
// Sisi yang butuh login (payload geometri getActiveNotams) tidak bisa diperiksa di
// sini — itu diverifikasi oleh tests/test_fir_map_area_browser.mjs secara lokal.
//
// Usage: node tests/pages_deploy_smoke.mjs   (override host: PAGES_HOSTS=url1,url2)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const HOSTS = (process.env.PAGES_HOSTS || 'https://awq-cloud.pages.dev,https://awq.christiandaniel.my.id')
  .split(',').map(host => host.trim()).filter(Boolean);

let failures = 0;
const chk = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures += 1;
};
const norm = text => text.replace(/\r\n/g, '\n');
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12);

const local = norm(readFileSync('public/app/index.html', 'utf8'));
console.log(`lokal public/app/index.html (dinormalisasi LF): ${local.length} char sha=${sha(local)}`);

for (const host of HOSTS) {
  const appUrl = `${host}/app/index.html`;
  let served = '';
  let appStatus = 0;
  try {
    const response = await fetch(appUrl);
    appStatus = response.status;
    served = norm(await response.text());
  } catch (error) {
    chk(`${host} menjawab`, false, error.message);
    continue;
  }
  chk(`${host} menyajikan /app/index.html`, appStatus === 200 && served.length > 1000, `status=${appStatus}`);

  // Artefak tayang harus identik dengan build lokal yang diuji (modulo CRLF).
  chk(`${host} menyajikan artefak yang identik dengan build lokal`, served === local,
    `tayang=${served.length} char sha=${sha(served)} vs lokal=${local.length} char sha=${sha(local)}`);

  // Build Cloudflare menjalankan build.js dari checkout LF, jadi blok script harus
  // tetap utuh — syntax error di sini berarti UI mati di produksi.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let blocks = 0;
  let broken = 0;
  while ((match = re.exec(served)) !== null) {
    if (/\bsrc\s*=/i.test(match[1] || '') || !match[2].trim()) continue;
    blocks += 1;
    try { new vm.Script(match[2], { filename: `served#${blocks}` }); } catch { broken += 1; }
  }
  chk(`${host} semua blok <script> inline tayang terkompilasi`, blocks > 0 && broken === 0, `${blocks - broken}/${blocks} blok`);

  // Fungsi FIR yang diperbaiki harus ada di artefak tayang.
  const firMarkers = ['parseNotamGeometryFromText', 'notamShapeProps', 'notamsAtPoint', 'notamRingContains', 'fir-notam-pick'];
  const missing = firMarkers.filter(marker => !served.includes(marker));
  chk(`${host} membawa perbaikan peta FIR`, missing.length === 0, 'hilang: ' + missing.join(', '));

  // /api/rpc hidup dan gagal-tertutup tanpa sesi. Origin harus cocok dengan host,
  // kalau tidak penjaga CSRF menjawab lebih dulu dengan pesan yang berbeda.
  try {
    const response = await fetch(`${host}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: host },
      body: JSON.stringify({ method: 'getActiveNotams', args: [] })
    });
    const body = await response.text();
    const json = (() => { try { return JSON.parse(body); } catch { return null; } })();
    chk(`${host} /api/rpc menolak tanpa sesi (401 JSON)`, response.status === 401 && !!json && !!json.error,
      `status=${response.status} body=${body.slice(0, 80)}`);
    chk(`${host} tidak membocorkan data NOTAM tanpa sesi`, !/NOTAM|polygon|radiusNm/i.test(body),
      body.slice(0, 80));
  } catch (error) {
    chk(`${host} /api/rpc menjawab`, false, error.message);
  }
}

console.log(failures ? `\nPages deploy smoke: ${failures} pemeriksaan GAGAL` : '\nPages deploy smoke: semua pemeriksaan lolos');
process.exit(failures ? 1 : 0);
