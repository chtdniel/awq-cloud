# Report Handoff — Session Brief (DIHENTIKAN 2026-09-20)

> ## ⛔ RENCANA INI DIHENTIKAN — JANGAN DILANJUTKAN
>
> Atas keputusan operator pada 2026-09-20, pekerjaan Report Handoff (Web 2 → Web 1) **dihentikan**.
> Tidak ada langkah lanjutan yang diharapkan: tidak ada Gate D, tidak ada deploy produksi, tidak ada
> run QA tambahan, dan `public/index.html` **tidak** akan diregenerasi untuk fitur ini.
>
> **Dokumen ini bukan lagi titik masuk untuk melanjutkan.** Ia disimpan sebagai catatan historis.
>
> Yang **tetap berlaku** dan tidak boleh diabaikan:
> - **Kode sudah live di deployment staging** (bukan produksi): `archive/Report.html`,
>   `archive/Report_Handoff.gs`, `src/Notam_Ui.html`, `src/Report_Ui.html`. Produksi belum pernah disentuh.
> - **Empat defect ditemukan saat Gate C** — lihat `docs/report-gate-c-qa-evidence.md` §6.3. Satu di antaranya
>   (`reportFindBlockingRequest_` memblokir request baru setelah request yang sama `SUCCEEDED`) adalah bug
>   produk yang sudah diperbaiki **hanya di salinan lokal + staging**; `archive/Report_Handoff.gs` yang
>   mengandung fix itu **belum pernah masuk review produksi**.
> - Karena itu: bila fitur ini nanti dihidupkan lagi, mulai dari review keamanan/korut tersebut —
>   bukan dari "sisa checklist QA".

**Tujuan asli file ini:** titik masuk bagi sesi baru. Fakta Gate A/B sudah diverifikasi runtime pada 2026-09-19; status Gate C diperbarui 2026-09-20 (hanya bagian otomatis).

---

## 1. Status

| Fase | Status |
|---|---|
| Gate A (PRD approval) | selesai |
| **Gate B0** (transport proof) | **PASS** — Chromium + WebKit otomatis, Firefox manual |
| **Gate B** (implementasi penuh) | **SELESAI + terverifikasi end-to-end di deployment test** |
| **Gate C** (QA staging) | **otomatis PASS** (Chrome/Edge/Chromium × 1–4 flight, 11 failure mode, 8 interop Web 1, smoke deployment anonim) — **sisa manual: Firefox nyata + Sheet fidelity ber-otentikasi** |
| Gate D (produksi) | belum — produksi belum disentuh sama sekali |

PRD §13 "Ready for full local implementation" → **semua `[x]`**. "Ready for production deployment" → masih `[ ]` (menunggu §7 di bawah).

**Paket bukti Gate C:** `docs/report-gate-c-qa-evidence.md` + `test-results/gate-c/` (`SUMMARY.md`, `matrix-results.json`, `failure-results.json`, `interop-results.json`, `deployment-smoke-results.json`, `manual/`).
**Ringkasan sesi Gate C (catatan historis, bukan ajakan melanjutkan):** `docs/report-gate-c-session-summary.md`.

## 2. Lingkungan test

| Item | Nilai |
|---|---|
| Deployment URL (test) | `https://script.google.com/macros/s/AKfycbz0gdvfrKdGu-7LovIZylT7q-REolKKBNmCRUOL13Dd9gdUZhDmeb6134hMKfv5wLPajA/exec` |
| Apps Script project | `10BDS9QGZe3VjXJEiTGmTTicZgONPAmc3waW-XucfbhBX4hYKFEgVrmDY` |
| Spreadsheet | `18uabNsqTNTxlpWYjUf-fRNNJrz5VWpiWxL78UMDBmXA` (`AWQ-REPORT`) |
| Operator terverifikasi | `chtdniel@gmail.com` (`isAuthorized: true`) |
| Script properties dipakai | `spreadsheetId`, `OCC_ALLOWED_EMAILS`, `REPORT_AUDIT_MAX_ROWS`, `REPORT_AUDIT_TRIM_MIN_AGE_MS`, `REPORT_AUDIT_LAST_TRIM` |

**Catatan penting:** `REPORT_WEB1_URL` ada di `src/Report_Ui.html`. Setiap kali membuat **New deployment**, URL berubah dan konstanta ini harus diperbarui, atau `openReportWeb1()` akan membuka deployment lama.

## 3. Berkas yang dibangun

| Berkas | Peran |
|---|---|
| `archive/Report_Handoff.gs` | **Backend Gate B**: `REPORT_AUDIT` schema, `PAYLOAD_HASH` SHA-256 kanonik, `ScriptLock tryLock(5000)`, expiry lazy, two-phase write, rekonsiliasi, `recordReportReceived` / `confirmReport` / `getReportStatus`, generator boundary payload-only, trim retensi, `resetReportAudit` |
| `archive/Report.html` | **UI Web 1**: READY/CONTEXT/ACCEPTED, preview, GENERATE, CHECK REPORT STATUS, diagnostik identitas |
| `archive/Code.gs` | routing `doGet?page=report` + `reportHandoffDiagnostic()` |
| `src/Report_Ui.html` | Web 2: `openReportWeb1()` iframe-aware, payload builder (`tafContext`/`notamContext`), guard ukuran, jendela receipt |
| `src/Taf_Ui.html` | `getReportTafContext()` — precedence + unavailable eksplisit |
| `src/Notam_Ui.html` | `getReportNotamContext()` + preservasi respons `analyzeNotams` |
| `tests/measure_payload_size.mjs` | ukur payload dari data seed nyata |
| `tests/test_report_handoff_unit.mjs` | 9 cek fungsi murni |
| `tests/test_report_payload_builder.mjs` | 7 cek helper Web 2 |
| `tests/test_report_handoff_protocol.mjs` | 21 cek state machine (mock Apps Script in-memory) |
| `tests/b0_ui_protocol.mjs` | 4 cek browser UI Web 1 (RPC di-mock) |
| `tests/b0_local_handshake.mjs`, `b0_local_iframe.mjs`, `b0_negative.mjs` | verifikasi lokal transport/negative |
| `tests/b0_transport_probe.mjs` | probe nyata ke deployment (Playwright) |
| `tests/serve_b0_manual.mjs` | server manual untuk uji di browser login Google |
| `docs/nonproduction-deploy-guide.md` | langkah deploy test |

## 4. Keputusan yang dikunci (dengan dasar)

| Keputusan | Nilai | Dasar |
|---|---|---|
| Batas ukuran payload | **64 KiB total, 8 KiB per teks** | Diukur dari data seed nyata: 40 KiB terbukti kurang (56 KiB pada 10 NOTAM/flight) |
| **Scope NOTAM report** | **AERODROME ONLY** | Permintaan operator 2026-09-20: NOTAM FIR/UIR tidak boleh masuk report. Filter di batas payload (`src/Notam_Ui.html`), `notamScope` dikirim di payload, preview Web 1 + terminal Web 2 menampilkan peringatan bila ada yang dibuang |
| Jendela readiness | 30 detik | disepakati |
| Jendela receipt | **45 detik** | cold start Apps Script terukur **~34 detik** |
| Preview TTL | 15 menit | default implementasi |
| Lock acquisition | `tryLock(5000)` | default implementasi |
| Deadline browser confirm | 6 menit | batas runtime Apps Script |
| Retensi audit | trim di **500 baris**, hanya request *settled* yang lebih tua dari **24 jam** | mencegah duplikat & menjaga rekonsiliasi |
| Origin Web 1 | `script.google.com` + pola `*-script.googleusercontent.com` | origin iframe asli terukur: `n-…-0lu-script.googleusercontent.com` |

## 5. Bukti runtime yang sudah ada

1. **Transport**: `READY → CONTEXT → ACCEPTED` di iframe Apps Script asli, `sourceTopMatchesPopup=true`, fragment via `google.script.url.getLocation`.
2. **Receipt**: `recordReportReceived` menulis `RECEIVED` + `AWAITING_CONFIRMATION`; `REPORT_AUDIT` dibuat otomatis.
3. **Generation**: klik GENERATE → `SUCCEEDED` + link Sheet; rantai audit `RECEIVED → AWAITING_CONFIRMATION → GENERATING → CREATE_ATTEMPTED → CREATED → SUCCEEDED` terverifikasi di spreadsheet (request `234b6d77-8981-496e-a9c9-33dab7a060ca`).
4. **Status**: CHECK REPORT STATUS → `SUCCEEDED` dengan request ID sama.
5. **Otorisasi**: penolakan anonim (`UNAUTHORIZED`) dan penerimaan operator terdaftar.

## 6. Cara menjalankan tes

```powershell
cd "C:\Users\chris\OneDrive\Desktop\AWQ - CLOUD"
npm run test:report           # 9 + 7 + 21 cek + pengukuran payload
npm run test:report:browser   # 4 cek UI + handshake + iframe + lost-receipt
node tests/pull_staging_ad_notams.mjs  # tarik korpus NOTAM aerodrome nyata dari staging (read-only, sekali)
npm run test:gatec            # Gate C: matrix + failure mode + interop Web 1 + ringkasan bukti
npm run test:gatec:smoke      # Gate C: smoke deployment staging (anonim)
npm run qa:gatec:manual       # harness bukti manual (Firefox nyata / live ber-otentikasi) di http://127.0.0.1:8788/
node tests/b0_transport_probe.mjs chromium   # probe ke deployment (anonim → akan ditolak otorisasi)
```

**Jebakan:** tes lokal dan harness manual memakai port **8788/8789/8790**. Jalankan satu proses saja; kalau `serve_b0_manual.mjs` atau `qa:gatec:manual` masih jalan, tes lain menunggu port (atau gagal `EADDRINUSE`).

**Catatan Firefox:** Playwright Firefox di mesin ini *deadlock* — `newPage()` tidak pernah selesai (sudah dicoba headless, headed, bundled, channel, dan tanpa sandbox). Karena itu Firefox **hanya** lewat `qa:gatec:manual` di Firefox nyata; jangan buang waktu menyalakan `tests/gatec_matrix.mjs firefox`.

## 7. Pekerjaan yang tersisa — **TIDAK AKAN DIKERJAKAN**

> ⛔ Rencana dihentikan 2026-09-20. Daftar di bawah **bukan** antrean kerja; ia disimpan supaya kalau
> fitur ini dihidupkan lagi, tidak ada yang perlu ditebak.

**Sudah selesai sebelum penghentian** (jadi tidak perlu diulang): deploy aerodrome-only di staging,
`npm run test:gatec:smoke` PASS 12/12, seluruh suite otomatis PASS (168 cek), Firefox nyata 1–4 flight
(transport + timing), dan fidelitas Sheet per ukuran seleksi (`coverage 4/4`) —
lihat `docs/report-gate-c-qa-evidence.md`.

**Ditinggalkan (tidak dikerjakan):**
- ~~Run ber-otentikasi di Chrome~~ — dilewati.
- ~~Konfirmasi baris `REPORT_AUDIT` untuk empat request terakhir~~ — dilewati.
- ~~Observasi durasi penuh: preview expiry 15 menit & deadline konfirmasi 6 menit~~ — dilewati.
- ~~Gate D: review diff + evidence QA, approval eksplisit, smoke test terbatas~~ — tidak dilanjutkan.
- ~~Baseline + target metrik (PRD §7 🔵)~~ — tidak disusun.
- ~~Regenerate `public/index.html` dari `src/` (`build.js`)~~ — **tidak dilakukan**, sehingga fitur ini
  tetap tidak ada di shell produksi.
- ~~Pastikan `REPORT_WEB1_URL` menunjuk deployment produksi~~ — tidak relevan selama tidak dilanjutkan.

**Kalau nanti dihidupkan lagi, ini titik masuknya:** `archive/Report_Handoff.gs` yang kini live di staging
memuat fix `reportFindBlockingRequest_` yang belum pernah direview untuk produksi, dan `src/Notam_Ui.html`
+ `src/Report_Ui.html` juga sudah live di staging. Review itu dulu, baru tentukan ulang cakupan QA.
Deployment staging yang sudah ada **boleh dibiarkan** (tidak memengaruhi produksi), tetapi jangan dianggap
sebagai kandidat rilis tanpa review tersebut.
