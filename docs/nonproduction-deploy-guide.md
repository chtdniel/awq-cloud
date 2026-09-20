# Panduan Deploy Nonproduksi — Gate B0 Transport Proof

> ## ⛔ RENCANA DIHENTIKAN — 2026-09-20
>
> Panduan ini tidak lagi menjadi langkah kerja. Report Handoff tidak dilanjutkan, jadi **jangan** melakukan
> deploy baru atau mengganti versi deployment untuk fitur ini. Deployment staging yang sudah ada dibiarkan
> apa adanya (tidak memengaruhi produksi).
>
> Peringatan yang sudah tertulis di bawah tetap berlaku sepenuhnya: **jangan menyentuh deployment produksi.**

**Status:** Hanya untuk lingkungan test. **Jangan menyentuh deployment produksi.**
Tujuan: menyediakan halaman `?page=report` di deployment Apps Script test agar probe B0 bisa membuktikan transport `READY → CONTEXT → ACCEPTED`.

## 0. Prasyarat

- Akses ke project Apps Script test: `10BDS9QGZe3VjXJEiTGmTTicZgONPAmc3waW-XucfbhBX4hYKFEgVrmDY`
- Spreadsheet test: `18uabNsqTNTxlpWYjUf-fRNNJrz5VWpiWxL78UMDBmXA`
- Deployment URL test: `https://script.google.com/macros/s/AKfycbw1FL23_nuoRGaeUHY4BBLVEZPXMWN6WgzGeF397pJd8AtByFxpKy1A-VQ-TxD7JZybaw/exec`
- File lokal: `archive/Report.html` (sudah dibuat), `archive/Code.gs` (routing `?page=report` sudah ditambahkan).

## 1. Tambah file HTML `Report` di editor Apps Script

1. Buka project Apps Script (link prasyarat).
2. Editor → **+** → **HTML** → beri nama **`Report`**.
3. Hapus isi default, lalu **paste seluruh isi `archive/Report.html`**.
4. Simpan.

> `Report.html` adalah build B0: hanya membuktikan transport. Backend audit/generasi (`recordReportReceived`, `confirmReport`, `getReportStatus`) belum dipanggil dan akan masuk di Gate B.

## 2. Pastikan routing `doGet` ada di `Code.gs`

`archive/Code.gs` (lokal) sudah diperbarui agar `doGet(e)` menampilkan `Report` untuk `?page=report`. Di editor, pastikan fungsi `doGet` di project cocok:

```js
function doGet(e) {
  var event = e || {};
  if (event.parameter && event.parameter.page === 'report') {
    return HtmlService.createTemplateFromFile('Report')
      .evaluate()
      .setTitle('AWQ OCC | Report')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('AWQ OCC | Dispatch Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
```

## 3. Script properties

Di project → **Project Settings → Script Properties**, pastikan:

| Property | Nilai |
|---|---|
| `spreadsheetId` | `18uabNsqTNTxlpWYjUf-fRNNJrz5VWpiWxL78UMDBmXA` (spreadsheet test) |
| `OCC_ALLOWED_EMAILS` | kosong untuk B0 (open-access transport proof) — Gate B baru butuh allowlist |

## 4. Deploy ulang (web app)

1. **Deploy → Manage deployments** → edit deployment yang ada, atau **New deployment**.
2. Type: **Web app**.
3. Description: `B0 transport proof (test)`.
4. Execute as: **Me** (cukup untuk B0; Gate B memakai *User accessing the web app* untuk operator identity).
5. Who has access: **Anyone** (untuk B0; Gate B memakai allowlist + login).
6. **Deploy** → salin `/exec` URL.

## 5. Verifikasi sebelum probe

Buka di browser (atau `curl`):

```
https://script.google.com/macros/s/.../exec?page=report
```

Harus berjudul **"AWQ OCC | Report"** (bukan "Dispatch Dashboard"). Kalau masih "Dispatch Dashboard", deployment belum memuat `Report` — ulangi langkah 1–4.

## 6. Jalankan probe B0

Di workspace (Node v24 + Playwright sudah terpasang):

```bash
node tests/b0_transport_probe.mjs            # chromium + firefox + webkit yang terpasang
node tests/b0_transport_probe.mjs chromium   # satu browser saja
```

Probe membuka mock Web 2 (di `127.0.0.1:8788`), klik DOWNLOAD SHEET, lalu merekam:
- struktur frame (iframe nesting Apps Script),
- origin + `event.source.top === popup` untuk tiap pesan,
- log `#status` Web 1 dan terminal Web 2.

## 7. Kriteria lolos B0 (per PRD Gate B0)

- `READY → CONTEXT → ACCEPTED` sampai ke iframe tujuan dan kembali ke Web 2 di Chrome, Edge, Firefox.
- Rejection popup/frame yang tidak terkait terverifikasi.
- Pembacaan fragment via callback `google.script.url.getLocation` terverifikasi (bukan `doGet`, bukan `window.location.hash` iframe).
- Recovery receipt-hilang terverifikasi.
- Ukuran payload 4-flight representatif tervalidasi (batas 40 KiB/8 KiB dikonfirmasi atau dinaikkan).

## 8. Batasan & keamanan

- Ini **eksperimen prasyarat**, bukan otorisasi implementasi penuh.
- Pakai **data sintetis**; **jangan** klik konfirmasi/generate (probe B0 berhenti di ACCEPTED).
- Jangan deploy ke produksi, jangan edit `public/index.html` produksi, dan jangan pakai spreadsheet produksi.
- `REPORT_AUDIT` belum dibuat pada tahap ini (Gate B).
