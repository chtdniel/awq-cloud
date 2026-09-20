# WX WARNING — halaman peta peringatan TC & abu vulkanik

Halaman `WX WARNING` adalah anak dari menu **WX** (sub-menu di bawah tab WX) dan
menampilkan peringatan siklon tropis serta abu vulkanik di atas peta Leaflet,
lengkap dengan rute + waypoint flight yang dipilih.

- Rute aplikasi: `/app` → tab **WX** → sub-menu **WX WARNING** (id view `wx-warning`).
- Kode halaman: `src/Wx_Warning_Ui.html`.
- Sumber data: `shared/wxwarning.mjs` (+ `shared/geo.mjs`, `shared/routegeom.mjs`).
- Penyimpanan: tabel D1 `wx_warnings` (`migrations/013_wx_warnings.sql`).
- Pengisian otomatis: worker cron `workers/cron` (jadwal `0 */4 * * *`).
- RPC: `getWxWarningData`, `parseWxWarningManual`, `saveWxWarningManual`,
  `deleteWxWarningManual` (`functions/api/rpc.js`).

## 1. Dari mana datanya (dan kenapa bukan scraping situs)

Situs sumber yang biasa dibuka operator menolak akses otomatis:

| Situs | Hasil uji | Kesimpulan |
| --- | --- | --- |
| `metoc.navy.mil/jtwc/jtwc.html` | HTTP 403 (CloudFront menolak klien non-browser) | tidak dipakai untuk pengambilan data |
| `bom.gov.au/aviation/volcanic-ash/darwin-va-advisory.shtml` | HTTP 403 + peringatan resmi "does not support web scraping" (diarahkan ke FTP anonim / layanan Registered User berbayar) | tidak dipakai untuk pengambilan data |

Yang dipakai adalah **produk yang sama melalui distribusi resmi WMO/GTS**:

| Lapisan | Sumber | Isi |
| --- | --- | --- |
| TC warning | `https://tgftp.nws.noaa.gov/data/raw/wt/wt{pn,io,xs}31..35.pgtw..txt` | produk JTWC apa adanya: posisi, intensitas, wind radii 34/50/64 KT per kuadran, track forecast 12–72 jam |
| Abu vulkanik (VAA) | `https://tgftp.nws.noaa.gov/data/raw/fv/fv{au,fe,ps}01..08.{adrm,rjtd,nzkl}..txt` | VAA Darwin (BOM), Tokyo (JMA), Wellington (MetNZ): poligon abu OBS + FCST +6/+12/+18 jam |
| SIGMET VA/TC | `https://aviationweather.gov/api/data/isigmet?format=json` | poligon SIGMET yang benar-benar diterima penerbang |

`tgftp.nws.noaa.gov` adalah layanan FTP-anonim publik NOAA yang menyiarkan data
GTS; tidak ada proteksi yang dilewati dan tidak ada permintaan ke `bom.gov.au`
sama sekali. Atribusi tetap ditampilkan per produk (BOM/JMA/MetNZ, JTWC/US Navy,
NOAA untuk feed dan SIGMET API), dan setiap kartu punya tautan ke halaman resmi
untuk verifikasi manual.

## 2. Alur data

```
cron (*/4 jam)                                    browser
  JTWC  ─┐                                        ┌─ getWxWarningData()  → baca D1
  VAAC  ─┼→ fetchWxWarnings() → parse → upsert D1 ─┤   (warnings + rute + hits)
  SIGMET ─┘        (shared/wxwarning.mjs)          └─ Leaflet: poligon, track, rute
```

* Halaman **tidak pernah** mengambil data dari internet: seluruh permintaan
  keluar hanya dilakukan worker cron. Karena itu peta tidak terpengaruh CORS,
  tidak membebani situs sumber, dan satu siklus 4 jam melayani semua operator.
* Cron menghapus baris otomatis yang tidak terlihat pada siklus terakhir
  (`is_manual = 0 AND fetched_at < siklus`), jadi badai yang sudah bubar hilang
  sendiri. Baris manual tidak pernah disentuh siklus ini.
* Produk yang kedaluwarsa ditolak berdasarkan DTG: TC > 12 jam, VAA > 24 jam,
  dan apa pun yang bertanggal lebih dari 2 jam ke depan. Ini bukan kehati-hatian
  teoretis — feed mentah menyimpan pesan terakhir setiap slot selamanya
  (`WTIO31` masih menyajikan badai berbulan-bulan lalu saat fitur ini ditulis).

## 3. Halaman

* **Header**: badge umur feed (`FEED nH OLD`, `NEVER SYNCED` bila belum pernah
  di-ingest, atau `FEED — ERROR`), tombol **REFRESH**, dan ringkasan rute.
* **KPI**: jumlah TC, VA, warning yang memotong rute, dan entri manual.
* **Peta** (2/3 lebar): poligon TC (garis penuh = SIGMET, track + lingkaran 34 KT),
  poligon abu (solid = OBS, putus-putus = FCST), penanda gunung, dan overlay rute
  flight terpilih (garis putus + titik waypoint + label). Ada legenda, kontrol
  layer (`TC TRACK`, `VA CLOUD`, `SIGMET`, `ROUTE`, `LABELS`), pemilih flight,
  chip koridor 25/50/100 NM, dan **FIT ROUTE**.
  Provider tile dicoba berurutan (OSM lalu CARTO) dan perpindahan dipicu oleh
  `tileerror`, karena basemap publik CARTO sekarang membalas dengan watermark
  "API KEY REQUIRED" alih-alih gagal.
* **Panel ACTIVE WARNINGS** (1/3 lebar): kartu per warning dengan badge sumber
  (`JTWC`/`VAAC`/`SIGMET`/`MANUAL`), jenis (TC/VA), metadata (GVP, FL, arah,
  DTG + umur, valid-to, operator), chip `AFFECTS ROUTE +n NM` / `CLEAR n NM`
  / `NO ROUTE`, tombol `LOCATE`, `SOURCE`, `DELETE` (manual), dan `RAW PRODUCT`.
  Filter `ALL / TC / VA / ROUTE / MANUAL` berlaku untuk daftar **dan** peta.
* **COPY SUMMARY / EXPORT .TXT / EXPORT .CSV**: ringkasan terstruktur berbahasa
  Inggris tanpa prosa AI — flight, route fixes, lalu satu baris per warning
  (jenis, sumber, nomor advisory, FIR/VAAC, FL, intensitas, pergerakan, DTG,
  valid-to, dampak rute) plus baris sumber dan disclaimer verifikasi.
* **MANUAL PRODUCT INPUT**: operator menempel teks produk, menekan **PARSE
  PREVIEW** untuk melihat laporan (READY/REJECTED + alasan), geometri pratinjau
  digambar abu-abu putus-putus di peta, lalu **SAVE TO SHARED BOARD**. Entri
  manual disimpan di D1 (`is_manual = 1`, `created_by`) sehingga terlihat semua
  operator, dan kedaluwarsa otomatis setelah 7 hari.

### AFFECTS ROUTE

`getWxWarningData(rowId, bufferNm)` mengembalikan rute flight (hasil
`shared/routegeom.mjs`, aturan sama dengan halaman FIR: `ACTIVE_ROUTE_ID` lebih
dulu, lalu pasangan DEP/ARR, duplikat koordinat dibuang) dan `hits` per warning.
Perhitungannya jarak bola:

* poligon abu / SIGMET: jarak minimum poligon ke polyline rute; sebuah rute yang
  **menyeberangi** poligon dengan kedua ujung di luar tetap dihitung 0 (titik
  sudut saja tidak cukup — ini terdeteksi saat pengujian dan diperbaiki);
* TC: jarak tiap titik track ke rute dikurangi radius 34 KT terbesar, sehingga
  rute yang berada di dalam wind radii ikut tertandai;
* tanpa rute yang bisa diresolusi, hasilnya `NO ROUTE` — halaman tidak pernah
  mengklaim "clear" untuk rute yang tidak diketahui.

Ambang default 50 NM; chip koridor 25/50/100 NM memicu pemuatan ulang dengan
nilai yang dikirim ke server (server membatasi 10–200 NM).

## 4. Keamanan & hak akses

| Method | Tier | Catatan |
| --- | --- | --- |
| `getWxWarningData` | sesi terautentikasi | hanya membaca D1 |
| `parseWxWarningManual` | sesi terautentikasi | stateless, tidak menyimpan; maksimum 200.000 karakter |
| `saveWxWarningManual` | registered + CSRF | menulis entri manual, dicatat di audit (`wx_warning_manual_save`) |
| `deleteWxWarningManual` | registered + CSRF | satu entri atau `ALL`, dicatat di audit |

Paste yang tidak dikenali **ditolak** (`WX_WARNING_UNPARSED`), bukan disimpan
setengah jadi: lebih baik operator diberi alasan daripada ada hazard yang salah
digambar. Produk yang hanya sebagian (mis. salah satu bagian pesan JTWC yang
terbelah) juga ditolak dengan alasan `PARTIAL PRODUCT`.

## 5. Uji

| Berkas | Cakupan |
| --- | --- |
| `tests/test_wxwarning_parse.mjs` | parser dengan produk nyata: WTPN31 DUJUAN, FVAU01 DUKONO, FVAU02 SEMERU, fragmen WTIO31, contoh ISIGMET; split multi-produk; kesegaran; filter wilayah; pemetaan baris D1 |
| `tests/test_wxwarning_geometry.mjs` | jarak bola, point-in-polygon (termasuk garis tanggal), jarak poligon–rute, resolusi rute dari `routes`/`latlong`, dan dampak rute |
| `tests/test_wx_warning_rpc.mjs` | RPC terhadap SQLite nyata + migrasi asli: upsert 30 kolom, dedupe paste ulang, pemisahan baris manual/otomatis, `hits` per buffer, gating tier & CSRF, audit |
| `tests/test_wx_warning_browser.mjs` | halaman sungguhan di Chromium: sub-menu WX, laporan parse, simpan, gambar peta (ukuran vektor diperiksa, bukan dikira-kira), filter, COPY/EXPORT, hapus, dan nol error halaman |

Screenshot bukti ada di `test-results/wx-warning-page.png`,
`wx-warning-map.png`, dan `wx-warning-manual.png` setelah menjalankan
`node tests/test_wx_warning_browser.mjs`.

## 6. Operasional

1. Terapkan migrasi: `wrangler d1 execute awq-db --file migrations/013_wx_warnings.sql`
   (lokal: `--local`).
2. Deploy worker cron agar feed terisi: `cd workers/cron && wrangler deploy`.
   Uji sekali tanpa menunggu jadwal: `curl "https://<worker-host>/?job=wx-warnings"`
   (atau `?job=tafs` untuk TAF).
   Selama worker belum ter-deploy, halaman menampilkan `FEED NEVER SYNCED` dan
   daftar kosong — bukan kesalahan halaman.
3. Deploy Pages seperti biasa (`node build.js` sudah menghasilkan
   `public/app/index.html`; `tests/test_build_artifact.mjs` menjaga artifact
   tidak basi).
4. Bila NOAA mengubah struktur feed, lapisan SIGMET tetap jalan dan panel sumber
   menampilkan sumber yang aktif; pesan kegagalan tercatat di respons cron
   (`problems`) dan di log worker.

## 7. Batasan yang diketahui

* Cakupan wilayah adalah kotak Asia-Pasifik (lat −55..45, lon 60..180 plus
  segmen −180..−160 untuk Fiji/Samoa); badai di luar kotak tidak ditampilkan.
* Track TC berasal dari produk JTWC; bila JTWC berhenti menerbitkan (badai
  bubar), baris otomatis hilang pada siklus berikutnya dan hanya SIGMET yang
  tersisa.
* Entri manual kedaluwarsa 7 hari; sebelum memakainya untuk briefing, periksa
  badge umur DTG di kartu.
* Halaman ini adalah alat bantu: keputusan operasional tetap harus diverifikasi
  terhadap produk resmi (tautan `SOURCE` pada setiap kartu).
