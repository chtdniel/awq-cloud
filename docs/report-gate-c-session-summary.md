# Gate C — Ringkasan Sesi & Titik Masuk Sesi Berikutnya

> ## ⛔ RENCANA DIHENTIKAN — 2026-09-20
>
> Pekerjaan Report Handoff dihentikan atas keputusan operator. **Tidak ada langkah lanjutan.**
> §6 di bawah sengaja dibiarkan utuh sebagai catatan apa yang belum dikerjakan, **bukan** sebagai
> antrean tugas. Jangan melanjutkan Gate D, jangan deploy ke produksi, jangan regenerasi
> `public/index.html` untuk fitur ini.
>
> Yang perlu diketahui kalau dokumen ini dibaca lagi nanti:
> - Deployment **staging** sudah memuat build aerodrome-only + fix blokir. **Produksi tidak pernah disentuh.**
> - `archive/Report_Handoff.gs` yang live di staging memuat fix `reportFindBlockingRequest_` yang
>   **belum pernah direview untuk produksi**. Itu risiko utama yang ditinggalkan, tercatat di §6.3
>   `docs/report-gate-c-qa-evidence.md`.
> - Seluruh bukti QA (168 cek otomatis + fidelitas Sheet per ukuran) tetap valid dan tersimpan.

**Tanggal sesi:** 2026-09-19 → 2026-09-20
**Cakupan sesi:** Gate C (QA staging) — matriks browser × seleksi 1–4 flight, failure mode, interop Web 1, smoke deployment staging, plus paket bukti QA.
**Status akhir:** deploy aerodrome-only live & terverifikasi di staging; seluruh QA otomatis PASS (168 cek); fidelitas Sheet per ukuran seleksi tuntas (4/4). **Rencana dihentikan di titik ini** — sisa item (Chrome ber-otentikasi, konfirmasi `REPORT_AUDIT`, observasi durasi penuh, Gate D) tidak dikerjakan.

> Dokumen ini adalah ringkasan sesi. Dokumen otoritatif tetap:
> - `docs/report-google-sheets-integration-prd.md` (PRD)
> - `docs/report-google-sheets-integration-implementation-plan.md` (spesifikasi teknis)
> - `docs/report-handoff-session-brief.md` (brief handoff, sudah diperbarui ke status Gate C)
> - `docs/report-gate-c-qa-evidence.md` (paket bukti Gate C)

---

## 1. Yang dikerjakan di sesi ini
| # | Pekerjaan | Hasil |
|---|---|---|
| 1 | Membaca brief handoff, PRD, implementation plan | scope Gate C terkonfirmasi |
| 2 | Recon lingkungan: browser terpasang, deployment staging, seed data | Chrome 153, Edge 153, Firefox 156, Chromium/WebKit bundled; staging `?page=report` hidup; seed TAF/NOTAM/flight nyata |
| 3 | Membangun harness fixture Gate C | `tests/gatec_harness.mjs`, `tests/gatec_fixtures.mjs`, `tests/gatec_browsers.mjs` |
| 4 | Membangun suite otomatis | matrix, failure mode, interop Web 1, smoke deployment, agregator bukti |
| 5 | Menjalankan & menstabilkan suite | 81 cek PASS di Chrome/Edge/Chromium |
| 6 | Membangun harness bukti manual | `tests/gatec_manual_firefox.mjs` (Firefox nyata + live ber-otentikasi) |
| 7 | Menulis paket bukti QA | `docs/report-gate-c-qa-evidence.md` + `test-results/gate-c/*` |
| 8 | Memperbarui brief handoff | status Gate C, perintah baru, sisa pekerjaan, catatan Firefox |
| 9 | **Aturan baru: report hanya membawa NOTAM aerodrome** (permintaan user) | filter di batas payload + peringatan operator + data uji nyata dari staging |

### 1.1 Aturan "AERODROME ONLY" (permintaan user, selesai)

Keputusan yang disepakati: scope **hanya di payload report Web 2 → Web 1**, operator **diberi peringatan** di preview Web 1, dan data uji **ditarik dari database staging**.

| Berkas | Perubahan |
|---|---|
| `src/Notam_Ui.html` | `reportStationSet()` + `isAerodromeReportNotam()`; `getReportNotamContext()` membuang NOTAM yang stasiunnya bukan aerodrome flight terpilih dan mencatatnya di `window.reportNotamScope` |
| `src/Report_Ui.html` | payload membawa `notamScope { rule, droppedFirWide, dropped[] }`; terminal Web 2 menampilkan `warning` dari receipt |
| `archive/Report.html` | preview menampilkan baris `Scope rule` dan `FIR-wide excluded: N NOTAM tidak dimasukkan (bukan aerodrome)` + daftar `id (station)`; receipt membawa `warning` |
| `tests/pull_staging_ad_notams.mjs` | **baru** — tarik `notams WHERE kind='AD'` dari staging D1 (read-only) ke snapshot gitignored |
| `tests/gatec_fixtures.mjs` | korpus NOTAM report = aerodrome nyata dari snapshot; 1 baris FIR seed dicampur per flight untuk menguji aturan drop |
| `tests/gatec_matrix.mjs` | 4 assertion baru: payload bebas designator FIR, tidak ada ID FIR lolos, semua aerodrome hadir, `droppedFirWide` sesuai; 2 assertion preview (scope + peringatan) |

Temuan data yang memicu ini: korpus seed lama **829 baris semuanya FIR/UIR** (`WIIF`, `WAAF`, `RPHI`, …), sementara staging punya **63 baris `kind='AD'`** (`YPPH 31, WIII 12, WADD 4, YPKG 4, YPPD 4, WARR 3, WADL 2, WATO 2, WIPP 1`). Lokal D1 punya 829 baris yang semuanya berlabel `kind='AD'` padahal berkode FIR — artefak `archive/seed_notams.sql` yang tidak mengisi kolom `kind`. **Data seed itu sebaiknya diperbaiki terpisah**; jangan dijadikan acuan kebenaran.

## 2. Hasil akhir (angka konkret)

```
aerodrome-only rule (kode asli × 1/2/3/4)  PASS  42/42   tests/test_gatec_aerodrome_only.mjs
operator harness contract                 PASS  45/45   tests/test_gatec_operator_harness.mjs
deployment smoke (live staging, anonim)   PASS  12/12
browser × selection matrix                PASS  12/12   (Chrome 153, Edge 153, Chromium 153 × 1/2/3/4)
failure modes                             PASS  33/33   (3 engine × 11 skenario)
Web 1 state interop                       PASS  24/24   (3 engine × 8 skenario)
```

Perintah:

```powershell
cd "C:\Users\chris\OneDrive\Desktop\AWQ - CLOUD"
npm run test:gatec          # rule + kontrak harness + matrix + failure + interop + ringkasan
npm run test:gatec:smoke    # smoke deployment staging (anonim)
npm run qa:gatec:manual     # harness bukti manual di http://127.0.0.1:8788/
```

Artefak: `test-results/gate-c/SUMMARY.md`, `matrix-results.json`, `failure-results.json`, `interop-results.json`, `deployment-smoke-results.json`, `manual/`.

**Deploy aerodrome-only TERVERIFIKASI (2026-09-20):** sepuluh fragmen kode dicocokkan **verbatim** antara halaman live dan file lokal — Web 2 6/6 (`reportStationSet`, `isAerodromeReportNotam`, `reportNotamScope.dropped.push`, `rule: 'AERODROME_ONLY',`, `notamScope: notamScope,`, `openReportWeb1`) dan Web 1 4/4 (baris `Scope rule`, `FIR-wide excluded`, `msg.warning`, `GENERATE GOOGLE SHEET`). Ukuran dokumen membuktikan build berganti: `/exec` 894.262 → **920.790** B, `?page=report` 32.124 → **33.672** B. Sebelum paste, kesepuluh fragmen itu 0× ada.

**Fidelitas Sheet per ukuran seleksi — SELESAI oleh operator (2026-09-20):**

| Ukuran | Template | Scope dibuang | Payload | Sheet |
|---|---|---|---|---|
| 1 flight | CBR1 | 1/1 | 2.591 B | `1iHM6Vn7yV9BDPukpMg8_pBZiRwVwy2_MB9XmR9OH9XU` |
| 2 flights | CBR2 | 2/2 | 4.195 B | `1Rlec_kRvanc4yeqWm3lVcCmQQ891WAgh7lOUsQ5lSxU` |
| 3 flights | CBR4 | 3/3 | 6.266 B | `1UZ7j4h6LbwgrVTUfZCQnMIlKZlAwIU-qmemXPoZyndw` |
| 4 flights | CBR4 | 4/4 | 7.900 B | `1py6CggG3N2_BOhvBvZP2fLBuI7AIV2AMHhfYbFtzTc0` |

Checklist harness **8/8** pada setiap ekspor; `coverage 4/4`; `SUMMARY.md` tidak lagi memuat baris `**NO**`. Hitungan scope di preview **sama persis** dengan prediksi suite otomatis (matrix: `droppedFirWide` = jumlah flight).

**Preview Web 1 per ukuran seleksi:** CBR1/CBR2/CBR4/CBR4, baris `AERODROME ONLY`, dan `FIR-wide excluded` 1/2/3/4 dengan daftar `id (designator FIR)` yang benar (`B2376/26-4 (RPHI)`, `J5162/26-4 (VTBB)`, `B0685/26-4 (WAAF)`, `D0699/26-4 (WBFC)`).

**Bukti kuat yang sudah terkumpul (per kasus matrix):** tab dibuka sinkron; `AWQ_REPORT_READY` dari origin allowlist dengan `event.source.top === popup`; nonce hanya di fragment (query string bersih); tepat satu CONTEXT dan satu ACCEPTED; Web 1 mencatat tepat satu receipt dengan template CBR1/CBR2/CBR4 dan urutan flight sesuai seleksi; **hash payload kanonik yang dihitung ulang dari payload yang diterima Web 1 sama dengan hash receipt Web 1**; teks TAF/NOTAM byte-identik dengan sumber Web 2; payload version 1, `savedNotamAnalysis` lengkap, `noSigStationMap` terjaga, di bawah 64 KiB (fixture 4 flight ≈ 9,5 KiB); preview menampilkan request ID/template/flight/NO SIG dan **tidak ada generasi sebelum konfirmasi**.

**Failure mode yang lulus:** popup blocked; 0 flight; 5 flight; teks TAF 12.288 B (>8 KiB); total 84.250 B (>64 KiB); origin tidak diizinkan; nonce salah; readiness timeout; lost receipt (request ID sama, tanpa CONTEXT ganda); handoff baru setelah timeout pre-send (ID + nonce baru); authorization failure (Web 2 & Web 1 menampilkan penolakan, generasi tidak pernah dipanggil).

**Smoke deployment staging (anonim):** `?page=report` → 200; halaman render di dalam frame user-content Apps Script dengan kontrol konfirmasi/status; fragment dibaca lewat callback `google.script.url.getLocation`; open anonim berhenti aman tanpa preview dan tanpa READY; diagnostic anonim mengembalikan `activeUser: ""`, `isAuthorized: false`, `allowedEmailsConfigured: true`, tiga template CBR ada → deployment berjalan *execute as accessing user* dan fail-closed.

---

## 3. Batasan lingkungan yang terukur (JANGAN diulang dari nol)

| Batasan | Pengukuran | Konsekuensi |
|---|---|---|
| **Playwright Firefox deadlock** | `firefox.launch()` resolve (155.0), tapi `newPage()` tidak pernah selesai — direproduksi headless, headed, bundled (`firefox-1543`), channel, dan dengan pref sandbox/IPC dimatikan | Tidak ada matrix Firefox otomatis. Firefox hanya lewat `npm run qa:gatec:manual` di Firefox nyata. Jangan jalankan `tests/gatec_matrix.mjs firefox`. |
| **Frame origin asing tidak bisa kirim ke window non-opener** | iframe `127.0.0.1:8790` di dalam tab Web 1 tidak bisa `postMessage` ke window Web 2; tab Web 1 (8789) bisa | Injeksi READY origin asing tidak reproducible di browser → baris origin-mismatch menguji keputusan allowlist + ketiadaan pesan dari origin terlarang + pinning target-origin |
| **JSHandle tidak bisa lintas browser context** | `JSHandles can be evaluated only in the context they were created` | Window asing yang digerakkan Playwright juga tidak bisa mengirim READY palsu |
| **URL fragment tidak pernah sampai ke server HTTP** | `req.url` di sisi server tidak memuat `#nonce=…` | Fixture diberi tahu nonce hidup di luar jalur, lalu tab Web 1 di-*reload* per handshake |
| **Apps Script memuat frame secara asinkron** | frame `userCodeAppPanel` terisi beberapa detik setelah navigasi | Smoke deployment harus polling `#status`, bukan sampling sekali |

Semua batasan di atas terdokumentasi di `docs/report-gate-c-qa-evidence.md` §4.

---

## 4. Perubahan kode yang dibuat sesi ini

### `src/Report_Ui.html` (satu-satunya perubahan produk)

| Perubahan | Sifat |
|---|---|
| `REPORT_WEB1_URL` dapat di-override via `window.__REPORT_WEB1_URL_OVERRIDE` | hook test; tanpa efek produksi |
| Readiness timeout membaca `window.__REPORT_READY_TIMEOUT_MS` (default 30.000) dan pesannya memakai nilai window itu | hook test + pesan tidak lagi hardcode "30 seconds" |
| Global observasi: `__gatecPendingHandoff`, `__gatecContextSent`, `__gatecTransferState` | write-only, tanpa efek perilaku |

Tidak ada validasi, allowlist, urutan timeout, atau aturan generasi yang dilonggarkan.

### File baru

`tests/gatec_harness.mjs`, `tests/gatec_fixtures.mjs`, `tests/gatec_browsers.mjs`, `tests/gatec_matrix.mjs`, `tests/gatec_failures.mjs`, `tests/gatec_interop.mjs`, `tests/gatec_deploy_smoke.mjs`, `tests/gatec_manual_firefox.mjs`, `tests/gatec_summary.mjs`, `tests/test_gatec_aerodrome_only.mjs`, `tests/test_gatec_operator_harness.mjs`, `docs/report-gate-c-qa-evidence.md`, `docs/report-gate-c-session-summary.md` (file ini).

### Koreksi yang ditemukan di sesi lanjutan (2026-09-20)

Tiga masalah nyata, semuanya membuat QA **tampak** lebih kuat daripada kenyataannya:

| # | Masalah | Dampak | Perbaikan |
|---|---|---|---|
| 1 | Fixture mendeteksi FIR dari **huruf terakhir kode** (`/[FI]$/`) | `VTBB` (Bangkok), `YBBB` (Brisbane), `YMMM` (Melbourne), `WBFC`, `WMFC`, `WSJC` — **6 dari 9** FIR — lolos dari assertion; `WIII` (Jakarta) nyaris dianggap UIR | Klasifikasi dari keanggotaan korpus FIR nyata (`notams.kind`, migrasi 005/006); `FIR_DESIGNATORS` + `isFirStation()` diekspor; fixture gagal keras bila snapshot `kind='AD'` memuat designator FIR |
| 2 | Baris FIR tidak ada di `savedNotamAnalysis` | Selector menolaknya sebagai *tidak dimiliki flight*, bukan karena aturan scope → fixture membuktikan aturan yang salah | `savedNotamAnalysis` dibangun dari respons **mentah** sehingga baris FIR benar-benar terseleksi lalu dibuang oleh aturan |
| 3 | Baris FIR membawa `station` = kode aerodrome | Preview Web 1 menampilkan `B2376/26-4 (WADD)` — menyebut aerodrome untuk NOTAM FIR, padahal baris itulah yang dibaca operator | `station` baris FIR = designator FIR → preview menampilkan `B2376/26-4 (RPHI)` |

Dua suite regresi baru menjaga hal ini: `tests/test_gatec_aerodrome_only.mjs` (42 cek, menjalankan kode asli di VM) dan `tests/test_gatec_operator_harness.mjs` (43 cek, memastikan harness operator memuat aturan **asli**, bukan mock, dan capture per ukuran lengkap).

### Perubahan harness operator (sesi lanjutan)

| Perubahan | Alasan |
|---|---|
| Aturan aerodrome **asli** diekstrak dari `src/Notam_Ui.html` dan dievaluasi di halaman harness (mock `getReportNotamContext` dibuang) | Bukti operator harus menjalankan implementasi yang dikirim, bukan salinannya |
| Fidelitas + checklist disimpan **per skenario** (`gatec-fidelity-by-scenario`) | Ekspor lama hanya menyimpan satu checklist, sehingga satu ukuran seleksi tidak bisa dibuktikan |
| Ekspor membawa `coverage { covered, total, missing, perSize }` | `gatec_summary.mjs` bisa menyebut ukuran yang **belum** punya catatan, bukan sekadar menghitung berkas |
| Baris **Per-size records** + **Coverage 1/2/3/4** di halaman | Operator melihat apa yang masih kurang tanpa menebak |
| `pageHtml()` diekspor + server hanya listen saat dijalankan sebagai entry point | Regression test bisa memvalidasi halaman tanpa berebut port 8788 |

### Diperbarui

`package.json` (`test:gatec` kini menjalankan dua suite regresi lebih dulu, sebelum suite browser yang mahal), `docs/report-handoff-session-brief.md`, `docs/report-gate-c-qa-evidence.md`.

---

## 5. Cara kerja harness (penting untuk sesi berikutnya)

- **Satu server fixture** hidup selama satu suite (port 8788 Web 2, 8789 Web 1, 8790 origin asing). Skenario dipilih per request lewat query (`?view=…`, `?outcome=…`, `?ready=…`, `?ack=…`), **bukan** dengan menutup/membuka server — menutup server membuat port tertinggal dan halaman basi (ini penyebab kegagalan awal sesi).
- **Web 2** = skrip REPORT asli dari `src/Report_Ui.html` + global yang biasa disediakan shell (`escapeHtml`, `safeStorage`, `getSelectedFlightObjects`, `getReportTafContext`, `getReportNotamContext`) + instrumentasi `window.open` dan `message`.
- **Web 1** = `archive/Report.html` asli + stub `google.script` yang disuntik sebelum skripnya. Stub `getLocation` memasok nilai fragment; jalur READY, allowlist, dan relasi `window.top.opener` tetap kode asli.
- **Dataset besar** didaftarkan lewat `POST /datasets` dan diakses dengan token (`dst=`), karena fixture oversize tidak muat di URL.
- **Nonce hidup** dipublikasikan ke fixture lewat `harness.setNonce(nonce)`, diambil dari `window.__gatecPendingHandoff.nonce` setelah klik; lalu tab Web 1 di-*reload*.
- **Verdict**: objek skenario punya `finalize()` yang menulis `pass` (Proxy-computed tidak ikut `JSON.stringify`); selalu panggil `finalize()` sebelum push/log.

---

## 6. Yang belum selesai — **DITINGGALKAN (rencana dihentikan)**

> ⛔ Daftar ini **bukan antrean kerja**. Ia disimpan supaya kalau fitur dihidupkan lagi, tidak ada yang
> perlu ditebak. Jangan mengerjakan langkah 8–10 tanpa keputusan baru dari operator.

**Status per 2026-09-20 (saat dihentikan):**

| Langkah | Status |
|---|---|
| 1. Deploy build aerodrome-only (`archive/Report.html` + `src/Notam_Ui.html` + `src/Report_Ui.html`) lewat *Manage deployments → edit → New version* | ✅ **SELESAI** — URL `/exec` tidak berubah, terverifikasi 10 fragmen verbatim (§2) |
| 2. `npm run test:gatec:smoke` pasca-deploy | ✅ **PASS 12/12** |
| 3. `npm run qa:gatec:manual` dijalankan | ✅ harness hidup, aturan asli termuat, mekanisme coverage terverifikasi di Chromium (14/14) |
| 4. Bukti Firefox nyata untuk transport 1–4 flight + timing | ✅ **SELESAI** (`manual/firefox-2026-09-20.json`), ringkasan di `qa-evidence` §6.1 |
| 5. Preview Web 1 per ukuran seleksi | ✅ **SELESAI**, terbukti otomatis (§6.1b) |
| 6. **Fidelitas isi Sheet + URL Sheet per ukuran** | ✅ **SELESAI** — `manual/firefox-gatec2-sel{1,2,3,4}.json`, checklist 8/8 per ukuran, `coverage 4/4`, summary tanpa baris `**NO**` |
| 7. Deploy fix blokir `reportFindBlockingRequest_` | ✅ **SELESAI + terverifikasi live** — `SUCCEEDED` pada flight set yang sebelumnya diblokir |
| 8. Status `REPORT_AUDIT` per request ID | ⛔ **ditinggalkan** |
| 9. Run ber-otentikasi di Chrome | ⛔ **ditinggalkan** — Firefox sudah lengkap 4 ukuran |
| 10. Observasi durasi penuh (preview 15 menit, deadline 6 menit) | ⛔ **ditinggalkan** |

**Ringkasan jujur:** QA staging sudah cukup untuk membuktikan fitur bekerja (168 cek otomatis + fidelitas
Sheet per ukuran + satu halaman bug produk ditemukan dan diperbaiki). Yang **tidak** pernah terjadi adalah
review produksi atas kode yang kini live di staging. Itu batas yang ditinggalkan, bukan sesuatu yang
"tinggal satu langkah lagi".

~~Langkah lanjutan (tidak dikerjakan): jalankan `gatecAuditProbe` dengan empat ID di §3; Chrome ber-login
`1`/`4 flight`; amati expiry 15 menit dan deadline 6 menit; Gate D review + baseline metrik;
regenerate `public/index.html`.~~

**Tidak ada yang perlu diulang** — transport/timing Firefox, verifikasi deploy, dan fidelitas 1–4 flight
semuanya sudah tercatat dan tetap valid.

**Rencana lanjutan yang dibatalkan** (jangan dijalankan): Gate D (review diff + evidence QA, approval,
smoke terbatas, baseline metrik PRD §7) dan regenerasi `public/index.html`. Akibatnya yang disebut terakhir
itu penting: **`public/index.html` tidak pernah diregenerasi**, jadi fitur ini memang tidak ada di shell
produksi — dan itu konsisten dengan keputusan menghentikan rencana.

PRD §13 "Ready for production deployment" tetap `[ ]` dan **akan tetap begitu** selama rencana ini dihentikan.

---

## 7. Jebakan yang sudah ditemukan (hemat waktu sesi berikutnya)

- Port 8788/8789/8790 dipakai bersama harness dan `serve_b0_manual.mjs`; jalankan satu proses saja.
- Fixture tidak bisa membaca fragment dari request → jangan mengandalkan `req.url.includes('#nonce')`.
- Jangan menutup server fixture antar skenario.
- `pass` harus di-`finalize()`, bukan dihitung saat objek dibaca.
- Mutasi kode untuk kontrol negatif harus diterapkan **sebelum** skrip dievaluasi (referensi fungsi sudah tertangkap oleh listener).
- Jangan pakai `Set-Content`/pipe PowerShell untuk menulis file tes berisi karakter non-ASCII: pernah menghasilkan mojibake ganda (em dash berubah jadi rangkaian karakter aneh, contoh: `\u00e2\u20ac\u201d (em dash yang rusak)`). Pakai tool file atau verifikasi ulang encoding setelahnya.
- **Diff `src/Report_Ui.html` terlihat besar (~200 baris) padahal perubahan sesi ini hanya ~7 baris**: blok handoff Gate B memang belum pernah di-commit, jadi ikut muncul di diff. Jangan panik dan jangan "mengembalikan" baris-baris itu.
- **Jangan simpulkan cakupan FIR dari bentuk kode.** `VTBB`, `YBBB`, `YMMM`, `WBFC`, `WMFC`, `WSJC` adalah FIR/UIR yang tidak berakhiran `F`/`I`, dan `WIII` adalah aerodrome yang berakhiran `I`. Pakai `isFirStation()` dari `tests/gatec_fixtures.mjs`.
- **Halaman Apps Script dibungkus sandbox**: HTML user-code ada sebagai string literal yang di-escape di dalam bootstrap. Untuk memeriksa deployment, decode dulu (lihat `scratch/verify_deployed_fragments.mjs`); `shell.includes('openReportWeb1')` pada respons mentah **selalu** false dan menyesatkan.
- **Jangan parse `<script>` dari halaman live dengan regex `</script>`**: string literal di dalam kode memuat `</script>` yang lolos ke regex tapi ditangani benar oleh parser HTML — pernah menghasilkan 14 "kegagalan" palsu.
- **Playwright tidak bisa dijalankan dari dalam sandbox file** (`spawn EPERM` pada `--remote-debugging-pipe`); jalankan suite browser sebagai proses normal.
- **Port 8788 dipegang harness operator yang hidup lama.** Sebelum menjalankan `test:gatec`, hentikan harness dulu, lalu hidupkan kembali untuk operator.
- **Jangan pernah mengarahkan probe otomatis ke harness operator.** Probe yang mengisi field fidelity akan menulis ke `test-results/gate-c/manual/manual-incidents.json` dan **mencemari bukti operator** dengan nilai sintetis. Jalankan instance sekali-pakai lewat `GATEC_MANUAL_PORT` + `GATEC_MANUAL_OUT`, dan pastikan probe memverifikasi log operator tetap bersih di akhir (contoh: `scratch/check_coverage_mechanism.mjs`).
- **Log operator pernah tercemar dan sudah dibersihkan.** Sempat ada 7 event dari probe (satu burst `08:17:49–08:17:50`, memuat nilai `SYNTHETIC-not-evidence`); semuanya dihapus dan log dikembalikan ke `[]`. Kalau nanti menemukan event `fidelity` bernilai `SYNTHETIC-…` di log, itu artefak probe — bukan bukti operator.

---

## 8. Status repositori (github.com/chtdniel/awq-cloud)

`.gitignore` sengaja mengecualikan `test-results/` dan `scratch/` karena **repo publik** dan artefak QA bisa memuat data operasional. Konsekuensinya:

| Artefak | Status git | Catatan setelah penghentian |
|---|---|---|
| `tests/gatec_*.mjs` (9 file) + `tests/test_gatec_*.mjs` (2 file) | untracked | tidak perlu diputuskan lagi; biarkan lokal |
| `docs/report-gate-c-qa-evidence.md`, `docs/report-gate-c-session-summary.md` | untracked | catatan historis; aman bila ingin di-commit |
| `test-results/gate-c/*.json`, `SUMMARY.md`, `manual/` | **gitignored** | bukti mentah hanya di disk lokal |
| `scratch/*.mjs` (probe deploy & verifikasi) | **gitignored** | perkakas sesi, bukan bagian paket QA |
| `src/Report_Ui.html`, `src/Notam_Ui.html`, `archive/Report_Handoff.gs`, `archive/Report.html`, `package.json` | modified/untracked, belum di-commit | **berisi perubahan yang belum pernah direview** |

⚠️ **Yang paling perlu diingat dari tabel ini:** perubahan di `src/Notam_Ui.html`, `src/Report_Ui.html`, dan
`archive/Report_Handoff.gs` sudah **live di deployment staging** tetapi **belum pernah melewati review
produksi**. Selama rencana dihentikan, itu tidak masalah — tapi jangan menyalin berkas-berkas ini ke
deployment produksi tanpa review tersebut, terutama `archive/Report_Handoff.gs`.

Bukti mentah tetap ada di disk (`test-results/gate-c/`). Tidak ada kewajiban mengarsipkannya lagi; kalau
suatu saat fitur ini dihidupkan kembali, salin ke lokasi di luar repo alih-alih `git add -f` ke repo publik.
