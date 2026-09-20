# Route waypoint marker & gap shortcut — QA record

**Scope:** penanda "waypoint sudah terdaftar" di halaman ROUTE, pintasan ke WAYPOINT MANAGER,
penanda koordinat di selector route Flight, kebersihan baris `latlong` yatim, dan hardening charset shell.
**Status:** terverifikasi otomatis (unit + Chromium atas `public/index.html`). **Belum di-deploy.**
**Tidak ada perubahan skema** — tidak ada migrasi D1 yang perlu dijalankan.

---

## 1. Masalah yang diselesaikan

Tabel `latlong` adalah satu-satunya sumber koordinat waypoint, dan **satu-satunya konsumennya adalah peta FIR**
(`src/FIR_Ui.html` → `buildLatLongLookup`/`getRouteCoords`). Sebelum ini tidak ada tempat di UI yang memberi tahu
bahwa sebuah profil route belum punya koordinat, sehingga:

- operator memilih routing profile yang rutenya tidak akan tergambar di peta, dan baru sadar di peta;
- Route ID yang salah ketik di WAYPOINT MANAGER tersimpan sebagai baris yang tidak pernah terbaca siapa pun;
- `route.waypoint_seq` (teks rute) mudah disalahartikan sebagai "sudah ada waypoint", padahal koordinatnya belum ada.

## 2. Perubahan

| Berkas | Perubahan |
|---|---|
| `functions/api/rpc.js` | `fetchRoutesWithWaypointCount()` + `formatRouteForUi()` — satu definisi `WAYPOINT_COUNT` untuk halaman ROUTE **dan** dashboard Flight; `handleLatlongGetEditorData` menandai baris `orphan` + `orphanCount` |
| `shared/waypoint.mjs` | `saveWaypoints` mengembalikan `routeKnown` (Route ID ada di registry atau tidak) |
| `src/Route_Ui.html` | badge `n WP` / `NO WP` / `WP ?`, KPI WP COVERAGE, chip filter NO WAYPOINTS, tombol pintasan admin-only, listener tabel dipasang sekali |
| `src/LatLong_Ui.html` | `latlongPrefillRoute()`, tag UNTRACKED + filter UNTRACKED, peringatan simpan saat Route ID belum dikenal |
| `src/Flight_Ui.html` | label selector route membawa `· n WP` / `· NO WP` |
| `src/Index.html` | `<meta charset="utf-8">`, event `occ:accessResolved` setelah status admin diketahui |

## 3. Cara verifikasi

```bash
node build.js                       # artefak wajib segar; ada gate otomatis untuk ini
npm test                            # 36 unit test (jumlah saat catatan ini ditulis)
npm run test:browser                # 4 suite Chromium (34 skenario)
npm run check:client-syntax
```

### 3.1 Unit (`node --test`)

`tests/test_route_waypoint_marker.mjs` — hitungan per profil; normalisasi spasi/huruf kecil; baris yatim
(`ORPHAN-ROUTE`, `''`, `'   '`) tidak dikreditkan ke route mana pun; tetap terbaca untuk non-admin; bertahan
setelah `saveFlightRoute`; dan **dashboard Flight memberi angka yang sama** dengan `getAllRoutes`.

`tests/test_waypoint.mjs` — `orphan`/`orphanCount` dan `routeKnown` (termasuk kasus `route-a` yang cocok dengan
`ROUTE-A`, jadi perbandingannya tidak case-sensitive).

`tests/test_build_artifact.mjs` — gate artefak: `<meta charset>` ada di 1024 byte pertama, tidak ada placeholder
`<?!= include(...) ?>` yang tersisa, shim RPC tersuntik, dan **tidak ada `src/*.html` yang lebih baru dari
`public/index.html`** (menangkap "lupa `node build.js`").

### 3.2 Chromium atas `public/index.html` (`tests/test_route_waypoint_marker_browser.mjs`)

Skenario admin: badge per profil, KPI cakupan, filter gap, satu klik = satu dialog, label selector route Flight
(`WADDWSSS01 (Alternate) · NO WP`, `WADDWSSS10 (Primary) · 2 WP`), tag/filter UNTRACKED, peringatan simpan untuk
Route ID tak dikenal, dan alur penuh gap → pintasan → SAVE → penanda berubah. Setiap langkah punya asersi DOM
**dan** asersi efek samping di DB (jumlah baris `latlong`), jadi tidak bisa lulus palsu saat hidrasi gagal.

Skenario non-admin: penanda tetap tampil, **nol** tombol admin, dan `openWaypointsForRoute` tidak menembus gate tab.

Selector route menunggu `window.allDbFlights` benar-benar terisi sebelum `openRouteModal` dipanggil — bukan
mengandalkan jeda waktu yang kebetulan cukup.

### 3.3 Bukti bahwa test-nya bisa gagal (bukan hiasan)

Dua asersi yang paling mudah lulus palsu disuntik regresi di `public/index.html`, dijalankan, lalu dipulihkan
dengan `node build.js`:

| Regresi yang disuntik | Hasil |
|---|---|
| handler delete dipasang ulang di dalam `render` | test FAIL (exit 1) → satu klik jadi beberapa dialog |
| listener `occ:accessResolved` dinonaktifkan | test FAIL (exit 1) → tombol tidak muncul saat akses telat |

Gate artefak juga diuji dua arah: tanpa `node build.js` ia gagal (`<meta charset>` hilang dari artefak), dan
setelah `src/*.html` disentuh lebih baru dari artefak ia gagal dengan pesan `jalankan: node build.js`.

## 4. Temuan selama pengerjaan

1. **Fixture test tidak mencerminkan skema.** `tests/test_bulk_flight_dof.mjs` membuat `flights`/`routes`/`aircraft`
   tanpa `latlong`, sehingga `getFlightDashboardData` yang kini menghitung waypoint mengembalikan 500. Fixture
   diperbaiki (tabel `latlong` ditambahkan) — kode produksi tidak dilunakkan untuk menutupi tabel yang hilang.
2. **Tidak ada `<meta charset>` di `public/index.html`.** Halaman bergantung penuh pada header server. Terbukti
   nyata: server test yang mengirim `text/html` tanpa charset membuat semua em-dash/panah di UI jadi mojibake.
   Cloudflare Pages mengirim charset, jadi produksi aman — tapi sekarang deklarasinya ada di shell.
3. **Data D1 lokal menunjukkan fitur ini relevan.** Dari state miniflare: 11 route, 251 baris `latlong`,
   **3 route belum punya koordinat**, dan **0 baris yatim**. Jadi penanda gap akan langsung berguna, sementara
   tombol UNTRACKED memang tidak muncul (memang tidak ada yang yatim).

## 5. Batas yang belum tercakup

- **Belum ada QA di deployment.** Semua pengujian berjalan lokal (D1 tiruan + Chromium headless). Belum diuji
  dengan data `latlong` produksi yang sesungguhnya, dan belum ada pemeriksaan operator di browser nyata.
- `public/index.html` yang di-commit **juga memuat perubahan `src/` yang sedang dikerjakan paralel**
  (TAF/Notam/Report/Weather_Warning), karena `build.js` menyusun seluruh `src/`. Bukan bagian dari perubahan ini.
- Cakupan KPI dihitung dari registry; pada registry kosong nilainya `0/0` (netral), bukan 0%.

## 6. Sisa rekomendasi

1. **Backfill + migrasi** `UPDATE latlong SET route_id = UPPER(TRIM(route_id))`. Belum dikerjakan karena query
   sudah menormalisasi saat membaca, jadi nilainya hanya kerapian data — dan index `idx_latlong_route` tidak akan
   terpakai selama bentuk query-nya `GROUP BY` atas seluruh tabel.
2. **Penanda di drawer/tooltip Flight**, bukan hanya di modal selector route.
3. **Aksi perbaikan** dari tag UNTRACKED (mis. salin Route ID ke field, atau petakan ke profil yang mirip).
4. **Pindahkan normalisasi ke satu tempat** kalau kelak ada konsumen `latlong` ketiga —
   saat ini `UPPER(TRIM(...))` ada di `fetchRoutesWithWaypointCount`, `handleLatlongGetEditorData`, dan
   `saveWaypoints`.
