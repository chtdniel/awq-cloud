# NOTAM Analyst Audit — Halaman FIR & FIR NOTAM

- **Skill**: `skills/notam-analyst/` v1.6.0 (canonical: `notam-analyst.md`)
- **Target**: `src/FIR_Ui.html` (1935 baris), `src/FIR_Notam_Ui.html` (1524 baris)
- **Backend terkait**: `functions/api/rpc.js` (4066 baris), `functions/api/notamUtils.js` (372 baris)
- **Metode**: baca kode penuh + eksekusi kode produksi (bundle esbuild + D1 `node:sqlite`) + self-test matrix 7 fixture wajib skill
- **Mode**: read-only review. Satu perubahan kode sebelumnya (`determinePriority` MEDIUM false-positive) sudah terpisah dan tidak dihitung di sini.
- **Verdict awal**: **FAIL** — 🔴 13 HIGH · 🟡 11 MEDIUM · 🔵 3 LOW
- **Status perbaikan (revisi 3)**: **13 temuan sudah DIPERBAIKI dan dikunci regression test** (H1, H2, H4, H5, H6, H7, H8, H9, H10, H11, M1, M2, M3). Sisa terbuka: **3 HIGH** (H3, H12, H13) + **8 MEDIUM** (M4–M11) + **3 LOW** (L1–L3). Gate skill sekarang **36/36 PASS, 0 todo**.

> ⚠️ Setiap perbaikan yang menyentuh logika waktu B/C/D, altitud, atau geo-math **wajib peer review** sebelum deploy (skill step 5). Perbaikan H2 (resolusi matahari) dan H5/H6 (pre-join AFTN) masuk kategori itu.

---

## 1. Self-test matrix (gate wajib skill v1.6.0)

Harness: **`tests/test_notam_analyst_fixtures.mjs`** (sudah wired ke `npm test`) — memanggil RPC produksi lewat bundle esbuild, bukan salinan logika. Jam sistem saat audit: **2026-09-20T21:29Z**.

| Fixture | Cakupan | Hasil awal | Hasil sekarang |
|---|---|---|---|
| FIXTURE_1 | Year-crossing B/C/D | 3/3 PASS | 3/3 PASS |
| FIXTURE_2 | Midnight crossing + multi-interval D | 4/4 PASS | 2/2 PASS |
| FIXTURE_3 | PERM vs EST suppression | 4/5 FAIL | 5/5 PASS |
| FIXTURE_4 | SR-SS / HJ / HN / offset matahari | 1/5 FAIL | 7/7 PASS |
| FIXTURE_5 | Q-line multi-qualifier + scope mismatch | 3/4 FAIL | 5/5 PASS |
| FIXTURE_6 | AFTN 69-char pre-join | 1/3 FAIL | 4/4 PASS |
| FIXTURE_7 | SNOWTAM / ASHTAM routing | 0/3 FAIL | 3/3 PASS |
| FIXTURE_8 | Scope FIR dari tabel `airport_firs` | belum ada | 1/1 PASS |
| FIXTURE_9 | Lifecycle NOTAMR/NOTAMC, paritas risiko, banner fail-closed | belum ada | 6/6 PASS |
| AUDIT [H7]/[H8] | Validasi tanggal AFTN (imajiner ditolak di klien + server) | belum ada | 2/2 PASS |
| | **TOTAL** | **16/27 — GATE FAIL** | **36/36 — GATE PASS (0 todo)** |

Assertion yang dulu gagal dan sekarang tertutup:

```
FIX (H2)  SR-SS diresolusi ke posisi matahari (YMMM siang)         -> PASS
FIX (H2)  SR-SS tidak klaim overlap di malam lokal                 -> PASS
FIX (H2)  HJ = siang, HN = malam pada koordinat yang sama          -> PASS (baru)
FIX (H2)  SR-30 SS+15 memakai offset terhadap matahari             -> PASS (baru)
FIX (H2)  lintang tinggi: polar day vs polar night (Svalbard)      -> PASS (baru)
FIX (H2)  SR-SS tanpa koordinat fail-open (arah aman)              -> PASS (baru)
FIX (H5)  digit terbelah tengah token (23|42S) di-join             -> PASS
FIX (H5)  parseNotam klien menyambung B)/C) yang terbelah wrap     -> PASS (baru)
FIX (H6)  blob 3 NOTAM terpecah 3 baris (header terbelah)          -> PASS
FIX (H1)  scope FIR dari tabel airport_firs                        -> PASS (baru)
FIX (H4)  NOTAMR/NOTAMC menurunkan status di getActiveNotams       -> PASS (baru)
FIX (H10) baris tak terparse berisiko sama di kedua halaman        -> PASS (baru)
FIX (H11) banner SOURCE_UNAVAILABLE terpasang di kedua halaman     -> PASS (baru)
FIX (M2)  scope A terhitung skipped, bukan dibuang senyap          -> PASS
FIX (M3)  editor menampilkan PERM (bukan string kosong)            -> PASS
FIX (M1)  SNOWTAM tanpa Q) ditolak dengan alasan terlihat          -> PASS
FIX (M1)  SNOWTAM ber-Q) diberi flag SNOWTAM/GRF                   -> PASS
FIX (M1)  ASHTAM tidak hilang tanpa jejak                          -> PASS
FIX (H7)  yyMMddHHmm klien menolak tanggal imajiner + peringatan    -> PASS (baru)
FIX (H8)  tanggal AFTN imajiner ditolak tanpa syarat jam            -> PASS (baru)
```

Bukti pendukung (dijalankan langsung terhadap kode produksi), `scratch/nam-verify.mjs`:

```
yyMMddHHmm('2613459900')          -> "2026-13-45 99:00"      # tanpa validasi  -> H7
duParseIcaoDateCode('2602310000') -> null                     # benar
duParseIcaoDateCode('2602311200') -> 2026-03-03T12:00:00Z     # tanggal imajiner lolos -> H8
parseNotam B) 26092812|23         -> Effective=""             # B hilang -> H5
parseNotam C) 26100414|47         -> Expiration=""            # C hilang -> H5
parseNotam C) EST / UFN           -> "2026-10-04 14:47" / ""  # klien vs server -> M5
parseNotam Class (QRDCA/QWULW/QKKKK) -> ""                    # Class tak pernah terisi -> M6
offset browser -480; server 12:23Z -> form 20:23; ketik "12:23" -> tersimpan 04:23Z  # M4
```

---

## 2. Temuan

### Status perbaikan (revisi 2)

Sudah diperbaiki dan dikunci regression test — rincian teknis di bawah tetap sebagai catatan kondisi awal audit:

| ID | Perbaikan | File | Test |
|---|---|---|---|
| ✅ H1 | Scope FIR dari tabel `airport_firs` (`fetchAirportFirMap`), literal 13 bandara jadi fallback saja; `firScope`/`firScopeSource` dikirim di payload; `getSelectedFlightsData` mengisi `FIR 1..8` | `rpc.js` | FIXTURE_8 |
| ✅ H2 | Token matahari (`SR-SS`, `SS-SR`, `HJ`, `HN`, `SR-30 SS+15`) diresolusi per hari **surya** dengan `duSunTimesUTC` (NOAA/SunCalc); tidak ada lagi band tetap 06:00–18:00 UTC; tanpa koordinat → fail-open | `notamUtils.js` | FIXTURE_4 (7 test) |
| ✅ H4 | `parseNotamLifecycleMap` dipakai `getActiveNotams`; `lifecycle` + status REPLACED/CANCELLED/CANCEL_MARKER; klien pakai status eksplisit (`FIRN_STATUS`, `notamIsLive`, `hazardStatusBucket`) | `rpc.js`, `FIR_Ui.html`, `FIR_Notam_Ui.html` | FIXTURE_9 |
| ✅ H5 | B) digabung sebelum dipotong (`\d[\d\s]{6,}\d`); token koordinat yang terbelah disambung di server dan di dua parser geometri klien; `parseNotam` klien memakai `joinField`/`dateCodeField` | `notamUtils.js`, `FIR_Notam_Ui.html`, `FIR_Ui.html` | FIXTURE_6 |
| ✅ H6 | Pola header menerima prefiks lokasi + wrap (`\s+`), prefix sebelum `Q)` ditempel ke baris pertama, dan potongan dengan >1 `Q)` dilaporkan sebagai `warnings` | `rpc.js` | FIXTURE_6 |
| ✅ H7 | `yyMMddHHmm` klien divalidasi (rentang + round-trip, wajib 10 digit); tanggal imajiner **tidak** di-rollover dan `parseNotam` mengembalikan `_warnings` yang ditampilkan `doParse` | `FIR_Notam_Ui.html` | AUDIT [H7] |
| ✅ H8 | Round-trip `duParseIcaoDateCode` jalan **tanpa syarat** HHMM = 0000, jadi `2602311200` → `null` (bukan 3 Mar) | `notamUtils.js` | AUDIT [H8] |
| ✅ H9 | `riskBadge` fail-closed (null/UNKNOWN → amber UNVERIFIED, bukan Clear); `getRiskClass` → `risk-UNVERIFIED`; kelas CSS `Clear` diperbaiki; chip risiko UNVERIFIED | `FIR_Ui.html` | FIXTURE_9 |
| ✅ H10 | Risiko baris tak terparse lewat satu helper `firUnverifiedRisk()` di kedua handler, status `UNVERIFIED` | `rpc.js` | FIXTURE_9 |
| ✅ H11 | Banner SOURCE_UNAVAILABLE + ANALYSIS FAILED menggantikan klaim "no impact"; `loadResults` membuang hasil basi dan menandai `lastResultsError` | `FIR_Ui.html`, `FIR_Notam_Ui.html` | FIXTURE_9 |
| ✅ M1 | Deteksi SNOWTAM/ASHTAM: penolakan berlabel + `unsupported` di preview/import; `firParseBulkNotamText` memberi alasan saat 0 baris | `rpc.js` | FIXTURE_7 |
| ✅ M2 | `skipped` jujur di `getActiveNotams` dan `firGetNotamEditorData` (+ `skippedRows` beralasan) | `rpc.js` | FIXTURE_5, FIXTURE_9 |
| ✅ M3 | `valid_to` NULL dilabeli `PERM` di editor (sama dengan `firGetNotamResults`) | `rpc.js` | FIXTURE_3 |

**Masih terbuka**: H3 (batas vertikal Q `000/999` + F)/G) tidak dievaluasi), H12 (teks dipotong 400 char tanpa penanda), H13 (`geometryChecked: true` palsu), M4–M11, L1–L3.

**Catatan dampak H8** (diukur pada 829 NOTAM di D1 lokal): 0 baris punya B)/C) bertanggal imajiner, jadi perbaikan ini menutup lubang laten **tanpa** mengubah klasifikasi data yang ada; tahun kabisat tetap benar (`2802291200` → 2028-02-29).

### 🔴 HIGH

**H1 — `[🔴 LOGIC-ERROR]` Scope FIR yang dilintasi hilang; rute bisa dibaca "Clear".**
`functions/api/rpc.js:2056-2079` memakai peta hardcoded 13 bandara, bukan tabel `airport_firs` yang ada di DB (`schema.sql:46-49`, dipakai di `rpc.js:2854`). Filter `candidateLocs.has(location)` di `rpc.js:2129` lalu membuang NOTAM FIR yang tidak masuk peta itu.
Bukti data: `archive/flights.csv` baris QZ 544 `WADD→YPPH` mendeklarasikan `FIR 1=WAAF, FIR 2=YBBB, FIR 3=YMMM, ENR1=YPPD`; `analyzeSingleFlight` hanya menghasilkan `{WADD,WAAF,YPPH,YMMM,YPPD}` → **YBBB tidak pernah masuk scope**. `firMapped` tetap `true` (`rpc.js:2182`) sehingga banner peringatan (`FIR_Ui.html:1448-1453`) tidak muncul.
Pelengkapnya: panel "Traversed FIR Boundaries" selalu kosong karena klien membaca `FIR 1..8` (`FIR_Ui.html:719, 1456`) yang tidak pernah dikirim `getSelectedFlightsData` (`rpc.js:1891-1913`) → selalu "None specified".
*Fix*: ambil mapping dari `airport_firs` (helper `handleFirGetFirs` sudah ada), kirim `fir_code` per flight, dan perlakukan scope kosong sebagai `UNVERIFIED`, bukan `Clear`.

**H2 — `[🔴 LOGIC-ERROR]` `SR-SS` dievaluasi sebagai band UTC tetap 06:00–18:00.**
`notamUtils.js:271, 283` (`isDaylight` → `sMin=360; eMin=1080`). Sunrise/sunset tidak pernah dihitung terhadap koordinat/tanggal.
Terbukti salah dua arah untuk YMMM (-37.81/144.96): window `2026-09-29 20:30–22:30Z` (= 06:30–08:30 lokal, **siang**, matahari 19:59Z–08:23Z) dinilai `false`; window `12:00–13:00Z` (= 22:00 lokal, **malam**) dinilai `true`.
`HN` (night) dan `SR-30 SS+15` tidak punya handler sama sekali — hasilnya identik dengan jadwal sampah, yaitu fail-open (selalu overlap).
*Fix*: hitung solar term dengan koordinat Q)/A) + tanggal window; kalau tidak bisa → tandai `SCHEDULE_UNRESOLVED`, jangan diam-diam fail-open.

**H3 — `[🔴 LOGIC-ERROR]` Batas vertikal tidak pernah dievaluasi/ditampilkan.**
Payload `getActiveNotams` (`rpc.js:1846-1862`) tidak punya field ketinggian; tidak ada penanganan `000/999` maupun `F)`/`G)` di kedua halaman. Sebuah warning FL500-600 dilaporkan HIGH untuk flight FL360 tanpa band yang bisa dinilai dispatcher. Arahnya fail-safe (tidak pernah false clear), jadi ini false-positive/fatigue, bukan silent miss.
*Fix*: parse Q-limits + F)/G) ke `lowerFt/upperFt`, bandingkan dengan CRZ FL flight, tampilkan band di kartu hazard.

**H4 — `[🔴 LOGIC-ERROR]` Lifecycle NOTAMR/NOTAMC tidak diterapkan.**
`parseNotamLifecycleMap` (`rpc.js:2397`) hanya dipakai `handleFirGetNotamResults` (`rpc.js:2464-2478`), **tidak** dipakai `handleGetActiveNotams` (`rpc.js:1803`) → NOTAM yang sudah di-replace/cancel tetap tampil aktif di halaman FIR. Di halaman FIR NOTAM, `badgeHtml` (`FIR_Notam_Ui.html:880`) hanya memisahkan `EXPIRED`: `REPLACED`, `CANCELLED`, `CANCEL_MARKER` (dipancarkan server) semuanya dirender badge hijau **"Active"**, dan `active` di peta (`FIR_Ui.html:1215`) juga tidak mengenal status itu.
*Fix*: pakai `parseNotamLifecycleMap` di kedua handler + map status eksplisit di klien; jangan pernah hijau untuk non-ACTIVE.

**H5 — `[🔴 LOGIC-ERROR]` Tidak ada pre-join AFTN 69 karakter.**
`FIR_Notam_Ui.html:1287-1310` menerapkan regex pada baris mentah. Terbukti: `B) 26092812` + baris berikut `23` → Effective kosong; `C) 26100414` + `47` → Expiration kosong, tanpa peringatan. Pada geometri, digit terbelah (`23` + `42S`) menghilangkan satu koordinat (polygon 2 dari 3 — fixture F6b).
*Fix*: gabungkan continuation line sebelum regex apa pun (skill §5); tambahkan test `5130N` + `00010W`.

**H6 — `[🔴 LOGIC-ERROR]` Blob multi-NOTAM: header terbelah baris menelan satu NOTAM.**
`headerPattern` (`rpc.js:2261`) menuntut `[A-Z]\d{4}\/\d{2}[ \t]+NOTAM[NRC]` pada satu baris. Fixture dengan 3 NOTAM, satu di antaranya berheader `WIIF A9102/26` + baris `NOTAMN`, menghasilkan `total=2` — satu NOTAM hilang tanpa error, tanpa audit, dan baris gabungan menyimpan dua `Q)` sekaligus.
*Fix*: normalisasi `\s+` pada pola header, dan tolak baris yang mengandung >1 `Q)` dengan alasan eksplisit.

**H7 — `[🔴 LOGIC-ERROR]` `yyMMddHHmm` tanpa validasi rentang.**
`FIR_Notam_Ui.html:1248-1253` tidak memeriksa bulan/hari/jam/menit: `'2613459900'` → `"2026-13-45 99:00"`, yang kemudian di-`Date.UTC` (`:797`) menjadi tanggal lain yang tetap masuk akal (rollover) sehingga operator tidak sadar window-nya salah.
*Fix*: validasi `mo 1-12, d 1-31, hh≤23, mm≤59` + round-trip `getUTCMonth/Date` tanpa syarat, kembalikan `''` bila gagal.

**H8 — `[🔴 LOGIC-ERROR]` `duParseIcaoDateCode` meloloskan tanggal imajiner bila HHMM ≠ 0000.**
`notamUtils.js:34` — guard round-trip digerbangi `hours === 0 && minutes === 0`. Terbukti: `'2602311200'` → `2026-03-03T12:00:00Z` (bukan `null`), dan nilai ini ikut dipakai `checkScheduleDOverlap`.
*Fix*: buang precondition `hours === 0 && minutes === 0 &&`.

**H9 — `[🔴 LOGIC-ERROR]` Fail-open: risiko `Clear`/`LOW` saat data tidak ada.**
`riskBadge` default `'Clear'` (`FIR_Ui.html:699`), `renderInspector` dipanggil dengan `analysis: []` **sebelum** RPC selesai (`:1636`), dan kegagalan analisa hanya memunculkan toast (`:1654`) sementara inspector tetap "Clear" hijau. Risiko hilang juga menjadi `'LOW'` di `:1056, :1214, :1467, :1525`.
*Fix*: badge `UNVERIFIED` (amber) untuk risk null/unknown; gate `Clear` pada flag `analysisOk[rowId]`.

**H10 — `[🔴 LOGIC-ERROR]` Baris yang sama punya tingkat risiko berbeda antar halaman.**
`handleFirGetNotamResults` memakai `parsed ? parsed.priority : 'LOW'` (`rpc.js:2474`), sedangkan `handleGetActiveNotams` memakai jalur konservatif `UNVERIFIED` + HIGH/MEDIUM berbasis kata kunci hazard (`rpc.js:1819-1836`). NOTAM "RWY CLSD"/"DANGER AREA ACT" yang gagal di-parse tampil **LOW hijau** di halaman FIR NOTAM dan **UNVERIFIED** di halaman FIR.
*Fix*: satukan satu sumber kebenaran risiko (satu helper dipakai kedua handler), dan kirim `risk:'UNKNOWN'` bila parse gagal.

**H11 — `[🔴 LOGIC-ERROR]` Kegagalan sumber senyap; daftar basi tampil sebagai segar.**
Halaman FIR: `loadActiveNotams` mengabaikan `data.error` (`FIR_Ui.html:1606-1611`) lalu empty state menyatakan **"No direct NOTAM impact found for current flight context."** (`:1520`) tanpa banner `SOURCE_UNAVAILABLE`. Halaman FIR NOTAM: `loadResults` menampilkan pesan error tetapi tidak mengosongkan `state.results`/`lastResultsLoad` (`:1014-1016`), sehingga render berikutnya dari perubahan filter (`:927, :1002`) melukis ulang baris lama tanpa penanda freshness.
*Fix*: flag `SOURCE_UNAVAILABLE` + banner merah persisten; kosongkan daftar atau tandai basi; jangan pernah menyatakan "no impact" saat sumber gagal.

**H12 — `[🔴 LOGIC-ERROR]` Teks NOTAM dipotong 400 char lalu ditampilkan seolah utuh.**
`rpc.js:1852` (`slice(0, 400)`) → popup peta `FIR_Ui.html:1083` menampilkan tanpa elipsis, sementara daftar hazard memakai teks penuh (`rpc.js:2154`). Frasa hazard di E) setelah karakter ke-400 tidak terlihat di popup. Klien sudah punya guard untuk polygon terpotong (`:1069`) tetapi tidak untuk teks.
*Fix*: kirim `textTruncated: true` + elipsis, atau naikkan batas dan kirim daftar hazard dari teks penuh.

**H13 — `[🔴 LOGIC-ERROR]` `geometryChecked: true` adalah klaim palsu.**
`rpc.js:2185` selalu `true`, padahal tidak ada perhitungan geometri/intersection sama sekali — pencocokan rute hanya regex token pada teks (`notamUtils.js:361-372`). Klien menampilkan flag lain (`:1448-1453`) sehingga mengesankan validasi spasial sudah berjalan.
*Fix*: implementasi bbox→point-in-polygon, atau set `false` dan tampilkan apa adanya.

### 🟡 MEDIUM

**M1 — `[🟡 CODE-SMELL]` SNOWTAM/ASHTAM tidak punya jalur parser khusus.** SNOWTAM tanpa `Q)` → preview `{total:0}` tanpa alasan; ASHTAM → senyap 0 baris; SNOWTAM ber-`Q)` → ditolak "Invalid (needs Location ICAO, NOTAM #, and B)/C) date)" karena `C)` pada SNOWTAM berarti designator runway — tanpa flag GRF/LEGACY. Tidak ada deteksi `SNOWTAM|ASHTAM` di seluruh repo.
*Fix*: deteksi keyword → parser khusus (RWYCC per third, kontaminan, ash top/base) atau minimal penolakan berlabel.

**M2 — `[🟡 CODE-SMELL]` Q-scope `A` dibuang senyap dan `skipped: 0` palsu.** `isValidFirNotam` (`rpc.js:2442-2447`) membuangnya di 4 handler; `handleFirGetNotamEditorData` melaporkan `skipped: 0` (`rpc.js:2376`) padahal barisnya disaring di `:2361`. Standar skill: mismatch scope harus tetap reviewable + ber-flag.
*Fix*: hitung dan laporkan `skipped` sebenarnya; tandai `QSCOPE_MISMATCH` di UI.

**M3 — `[🟡 CODE-SMELL]` `PERM` hilang di editor.** `handleFirGetNotamEditorData` mengembalikan `''` untuk `valid_to` NULL (`rpc.js:2363`) sedangkan `handleFirGetNotamResults` mengembalikan `'PERM'` (`:2471`) → checkbox PERM tidak tercentang saat mengedit (fixture F3), dan `loadIntoForm` (`:1142-1146`) memperlakukannya sebagai tanggal kosong.

**M4 — `[🟡 CODE-SMELL]` Input datetime menampilkan waktu lokal, hint menyatakan UTC.** `FIR_Notam_Ui.html:291` ("Dates are stored as UTC") vs `toLocalInput` (`:790-800`). Round-trip form aman (terbukti byte-identik), tetapi operator yang mengetik digit UTC dari B)/C) menyimpan window bergeser sebesar offset browser (empiris: UTC+8 → 12:23Z tersimpan 04:23Z).
*Fix*: pakai field UTC eksplisit (`new Date(v + 'Z')`) atau ubah label + tampilkan offset.

**M5 — `[🟡 CODE-SMELL]` EST/UFN tidak konsisten klien vs server.** Klien hanya cocok `(\d{10}|PERM)` (`:1310`) → `EST` menjadi tanggal keras, `UFN` menjadi kosong; server memetakan keduanya ke sentinel 2099 dan melabelinya `PERM` (`notamUtils.js:92-94` → `rpc.js:1851`) → estimasi tampil sebagai permanen.

**M6 — `[🟡 CODE-SMELL]` Class diturunkan dari huruf Q-code, selalu kosong.** `FIR_Notam_Ui.html:1296-1298` memakai `qcode.charAt(1)`; aturan kanonik kedua backend adalah huruf seri nomor NOTAM (`rpc.js:2417-2422`). Terbukti `QRDCA`/`QWULW`/`QKKKK` semuanya menghasilkan `""` → karena Class wajib (`:1084, :1092`), SAVE diblokir / baris tersimpan tanpa Class. Contoh di placeholder halaman sendiri (`:288`) juga gagal.

**M7 — `[🟡 CODE-SMELL]` Geometri rute: urutan salah + nama field tidak cocok.** `latlong` diambil `ORDER BY id` (`rpc.js:1889`) tanpa `sequence_order` (`:1927-1932`, padahal ada di `schema.sql:160`), dan klien membaca `route['WAYPOINT_SEQ (Airway & Fix)']`/`ROUTE_STRING_ORIGINAL` (`FIR_Ui.html:793`) sementara server mengirim `WAYPOINT_SEQ`/`ROUTE_STRING` → tokens kosong, polyline bisa lurus/zig-zag di bawah overlay NOTAM.

**M8 — `[🟡 CODE-SMELL]` Stale-guard terlewati untuk edit dari tab Results.** `editFromResults` menyuntik baris tanpa `updatedAt` (`FIR_Notam_Ui.html:1025-1034`) → `state.editingUpdatedAt=''` → `firNotamStaleError` butuh kedua sisi non-empty (`rpc.js:2591`) → save/delete menimpa perubahan tab lain tanpa peringatan (last-writer-wins).

**M9 — `[🟡 CODE-SMELL]` Hitungan filter marginal, bukan kondisional.** `FIR_Notam_Ui.html:904-911` menghitung tiap dropdown atas seluruh `state.results`, jadi "HIGH (12)" bisa tampil bersama 3 kartu terlihat, tanpa peringatan bahwa HIGH disembunyikan kombinasi filter.

**M10 — `[🟡 CODE-SMELL]` Cabang koordinat 3 digit hanya di klien, tanpa cek rentang.** `FIR_Ui.html:939` (tidak ada di `notamUtils.js:204`) → `"407S"` menjadi lat `-407` yang digambar Leaflet.

**M11 — `[🟡 CODE-SMELL]` Antimeridian dan layer ganda.** Tidak ada normalisasi ±180 pada polygon/circle (`FIR_Ui.html:1022-1033`, `FIR_Notam_Ui.html:519-520`) → artefak melingkari dunia dan `_notamBounds` pre-filter tidak pernah menolak; `firnMapGeomLayer` di-assign dua kali (`:571-573`) sehingga satu layer group tidak pernah dibersihkan.

### 🔵 LOW

- **L1** `[🟡 CODE-SMELL]` Audit trail §8 tidak ada: `FIR_Ui.html:1210` (`if (!ll) return`), `:1112` (`catch(e){}`), `:925` (`.catch(()=>{})`), plus koordinat fallback fabrikasi `110.0/-5.0` (`:1014`) yang digambar seolah nyata (hanya counter agregat di `:1237`).
- **L2** `[🟡 CODE-SMELL]` Sisa XSS/escaping: tooltip Leaflet mentah (`FIR_Ui.html:1226, 1231`), class dari `risk`/`type` tanpa `esc` (`FIR_Notam_Ui.html:887-888`), `rowId` mentah di atribut (`:983-984`). Exploitability rendah (nilai dari server), bukan nol.
- **L3** `[🟡 CODE-SMELL]` `esc()` ditulis ke `textContent` (double-escape, `FIR_Notam_Ui.html:644, 1240`); Issue Date mengambil 10 digit pertama baris mana pun (`:1316`) sehingga bisa mengambil nilai `B)` pada AFTN satu baris.

---

## 3. Yang sudah benar (jangan diubah)

- **Year crossing & midnight rollover** — B/C lintas tahun 2026→2027 dan D) blok `2612312359 TO 2701010000` ter-parse benar; `DAILY 2300-0100` overlap pada window 00:30Z dan tidak overlap pada 03:00Z (fixture 1 & 2, 7/7 assertion).
- **Interval ganda tidak digabung** — `DAILY 0800-1200 1400-1800` diuji per interval (fixture 2), melanggar tidak.
- **PERM/EST tidak di-suppress** — keduanya tetap `ACTIVE` dan dilabeli `PERM` oleh `getActiveNotams` (fixture 3).
- **Q-line dengan field kosong** (`Q) WRXX/QKKKK/K /K /K/...`) tidak salah dibaca sebagai scope `A` (fixture 5) — `split('/')[4]` benar.
- **Pasangan koordinat terbelah newline** tetap terbaca (fixture 6a, 5/5 titik) karena `\s*` pada regex server.
- **Radius of influence `000`/`999`** diperlakukan "tidak terdefinisi" identik di klien dan server (`FIR_Ui.html:986` ⟷ `notamUtils.js:245`); split E)/F) dan dedupe titik penutup juga identik.
- **`notamRingContains`** ray-casting dimensional benar (ring `[lat,lon]`, dipakai sebagai `yi/xi`), dengan pre-filter bounds — bukan O(n²).
- **Escaping posture**: `esc = window.escapeHtml` dipakai di seluruh pembangun HTML; `addToast` memakai `textContent`; tidak ada `eval`/`new Function`/interpolasi NOTAM ke prompt.
- **Matematika D-line tidak diduplikasi di klien** — keputusan schedule/active/expiry datang dari payload server, jadi tidak ada dua implementasi yang bisa berbeda.
- **Round-trip form NOTAM** (`parseNotam` → `toLocalInput` → `fromLocalInput`) lossless.

---

## 4. Regression test (skill step 6) — SUDAH DIPASANG

Harness dipromosikan menjadi **`tests/test_notam_analyst_fixtures.mjs`** dan sudah masuk `npm test`.

- **36 test hijau, 0 todo** (revisi 3): fixture 1–7 + FIXTURE_8 (scope `airport_firs`) + FIXTURE_9 (lifecycle/paritas risiko/banner fail-closed) + AUDIT [H7]/[H8] (validasi tanggal AFTN) + pengunci helper klien.
- Tiga belas temuan audit yang dulu `{ todo }` sekarang dijalankan sebagai **regression test per ID temuan** (H2, H5, H6, H7, H8, M1×3, M2, M3). Mekanisme `DEFECTS` + ledger test tetap ada: temuan baru yang belum diperbaiki cukup ditambahkan ke array itu dengan opsi `{ todo }`, dan ledger menjaga jumlahnya sinkron dengan `FIXED_DEFECTS`.
- Test tidak bisa "lulus sendiri": `functions/api/notamUtils.js` diimpor sebagai modul dan handler RPC dijalankan lewat bundle esbuild + D1 in-memory, jadi tidak ada salinan logika di dalam test.
- Parser klien (`parseNotam`) dan helper fail-closed (`riskBadge`, `notamIsLive`, `hazardStatusBucket`) diuji dengan mengekstrak fungsinya dari HTML — jadi yang diuji benar-benar kode halaman yang dikirim ke browser.
- Tanggal B) dihitung relatif terhadap jam sistem (`icaoDateDaysAgo`), jadi test tidak basi seiring waktu.
- Gerbang artefak build (`tests/test_build_artifact.mjs`) memaksa `node build.js` dijalankan setiap kali `src/*.html` berubah — perubahan klien tidak bisa tertinggal di `public/app/index.html`.

Fixture tambahan yang belum ada:

1. Solar term: `SR-SS` di lintang/bujur YMMM, WIII, dan lintang tinggi dengan window siang/malam.
2. AFTN 69-char: B)/C)/Q)/koordinat terbelah, dan blob 3 NOTAM dengan header terbelah.
3. Tanggal imajiner: `2602311200`, `2613459900`, `2602310000`.
4. Scope: `Q) XXXX/QRDCA/IV/BO/A/...` pada dataset FIR → harus terlihat/ter-flag.
5. SNOWTAM GRF (dengan & tanpa `Q)`) dan ASHTAM → harus memiliki jalur + alasan.
6. Persamaan risiko antar halaman: satu baris tidak boleh `LOW` di satu halaman dan `UNVERIFIED` di halaman lain.
7. Antimeridian: polygon/circle yang melewati 180°.

---

## 5. Pertanyaan terbuka (butuh validasi manusia)

1. Backend mana yang otoritatif di produksi untuk halaman FIR NOTAM — GAS `archive/FIR_Notam_Backend.gs` (mengembalikan `type` NEW/RPL/CNL) atau port Workers (`rpc.js:2490` hardcoded `'NEW'`)? Menentukan M1/M6 dan apakah filter RPL/CNL hidup.
2. Apakah benar operator mengetik nilai UTC dari `B)`/`C)` ke field datetime-local (M4)? Butuh konfirmasi alur kerja dispatcher + timezone deployment.
3. Apakah produksi menyimpan baris `NOTAMC`/`NOTAMR` di `notams(kind='FIR')`? Menentukan dampak nyata H4.
4. Apakah `latlong` produksi benar-benar tidak berurutan menurut `sequence_order` (M7)? Satu query cukup.
5. Apakah halaman ini memang diharapkan menulis audit trail §8, atau itu sengaja di hulu?

---

## 6. Kesiapan produksi (revisi 3)

### Sudah terverifikasi

| Gate | Hasil |
|---|---|
| `npm test` | **139/139 pass, 0 fail** |
| Fixture skill `notam-analyst` | **37/37 PASS, 0 todo** |
| `npm run check:client-syntax` | semua blok `<script>` inline terkompilasi |
| `npm run test:browser` (Chromium, klien asli `public/app/index.html`) | **semua PASS** — termasuk FIR map area geometry, FIR overlap click, FIR flight list mengikuti Flight Board, stale report rejection |
| `npm run test:report` | exit 0 (termasuk batas payload 64 KiB) |
| Gerbang artefak build | `public/app/index.html` sinkron dengan `src/*.html` |
| Regresi | 0 |

Blast radius perubahan, diukur pada 829 NOTAM D1 lokal:

| Perubahan | Baris terdampak | Catatan |
|---|---|---|
| H2 resolusi matahari | **7** (semua `D) HJ`) | semuanya punya titik Q), jadi benar-benar diresolusi — bukan fail-open |
| H4 lifecycle | **1** dari 63 NOTAMR | 62 target menggantung (tidak ada di DB) → original tetap ACTIVE, sesuai desain |
| H8 tanggal imajiner | **0** | tidak ada churn klasifikasi; kabisat tetap benar |
| H1 `airport_firs` | semua flight | literal 13 bandara hanya fallback bila tabel kosong |
| M2 `skipped` | baris Q-scope A | kini terhitung, sebelumnya dilaporkan 0 |

### Belum terverifikasi — prasyarat deploy

1. **Peer review** (wajib menurut skill step 5) untuk perubahan yang menyentuh logika waktu B/C/D, parsing AFTN, dan geo-math: **H2, H5, H6, H7, H8**. Penulis perubahan tidak bisa menjadi reviewer-nya sendiri.
2. **Sanity check D1 produksi** (angka di atas berasal dari D1 lokal):
   ```bash
   npx wrangler d1 execute <DB> --remote --command "SELECT COUNT(*) AS airport_firs FROM airport_firs;"
   npx wrangler d1 execute <DB> --remote --command "SELECT id, message FROM notams WHERE kind='FIR' AND (message LIKE '%D) HJ%' OR message LIKE '%SR-SS%' OR message LIKE '%D) HN%');"
   npx wrangler d1 execute <DB> --remote --command "SELECT COUNT(*) FROM notams a WHERE a.kind='FIR' AND EXISTS (SELECT 1 FROM notams b WHERE b.message LIKE '%NOTAMR ' || a.id || '%');"
   ```
   Kalau `airport_firs` kosong, H1 hanya jatuh ke fallback (tidak berbahaya, tapi panel FIR tetap kosong).
3. **Verifikasi visual sekali** di halaman FIR + FIR NOTAM dengan data produksi: badge status baru (FUTURE/UNVERIFIED/REPLACED/CANCELLED), chip UNVERIFIED/INACTIVE, dan banner SOURCE_UNAVAILABLE (uji dengan mematikan sumber).
4. **Commit + review diff dulu** — saat ini semua perubahan masih di working tree, belum ada commit.
5. **Rollback**: tidak ada migration DB pada perubahan ini, jadi rollback = revert commit + `node build.js` + redeploy. Bersih.

### Risiko yang ditutup saat penilaian ini

Pre-join digit lintas baris (H5) awalnya ikut berjalan di pemindaian **seluruh pesan** (fallback saat Q) tidak punya koordinat). Di sana newline bukan pembungkus token, dan menyambungnya bisa **mengarang titik pusat** — baris `2630` + baris `42S 07500E` menjadi `30°42'S 075°00'E` — yang lalu dipakai juga untuk meresolusi jadwal matahari. Sekarang join dibatasi ke field E) saja, di server maupun di klien, dengan test khusus (`FIXTURE_6 pre-join hanya di field E)`).

## 7. Artefak
| File | Isi |
|---|---|
| `tests/test_notam_analyst_fixtures.mjs` | self-test matrix 7 fixture (gate) — 13 test hijau + 11 `todo` + ledger. Masuk `npm test`. |
| `scratch/nam-verify.mjs` | verifikasi klaim parser klien/server (tanggal imajiner, Class, C) EST/UFN, timezone) |
| `scratch/h8-impact.mjs` | pengukuran dampak H8 pada 829 NOTAM D1 lokal (0 baris terdampak, kabisat tetap benar) |
| `scratch/db-audit2.mjs` | distribusi trigger MEDIUM di 829 NOTAM D1 lokal |
| `functions/api/notamUtils.js:157-172` | perbaikan `determinePriority` (false positive `MEN` + rule hazard HIGH) |
