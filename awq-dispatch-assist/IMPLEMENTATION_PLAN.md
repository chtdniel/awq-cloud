# Implementation Plan — Dispatch Analysis (ETA / TAF / Minima / Fuel)

> Status: keputusan terkunci, implementasi dimulai pada modul deterministik.
> Dokumen review ada di `GAP_ANALYSIS.md`. Dokumen ini adalah rencana eksekusi.

---

## 1. Keputusan terkunci

| # | Item | Keputusan |
|---|---|---|
| 1 | NOTAM | Input manual + REMARKS; verdict terdegradasi bila NOTAM tidak tersedia |
| 2 | Minima | Berbasis aturan OM Part A / FDM / CASR; airport chart menyusul |
| 3 | Layer regulasi | OM Part A → FDM → CASR → AIP Australia |
| 4 | Pemilihan flight | Manual dari flight board aktif |
| 5 | Semantik verdict | **GO hanya bila NOTAM terverifikasi** |
| 6 | Provider AI | **DeepSeek API eksternal** (`api.deepseek.com`), model `deepseek-flash` |
| 7 | Egress data | **Hanya ID klausa + findings** yang dikirim; teks corpus tetap di D1 (manual `CONFIDENTIAL`) |
| 8 | Advisory cuaca menyentuh rute | **MARGINAL, bukan blokir.** `WX_ROUTE_IMPACT` = CRITICAL non-blocking; dispatcher yang menilai |

---

## 2. Bukti dari corpus (diverifikasi terhadap `.tmp/doc2-4.json` + `ingest-doc*.sql`)

Aturan yang dibutuhkan spec **ada di corpus dan bisa disitir**:

| Aturan | Klausa | Isi |
|---|---|---|
| Planning minima (destinasi / en-route / isolated alternate) | OM Part A `8.1.2`, `8.1.2.2.1`, `8.1.2.2.2`, `8.1.2.2.3.1` | Table 8.1-2/8.1-3/8.1-4: minima berbasis jenis pendekatan (CAT II/III → CAT 1 RVR; CAT I → NPA minima) |
| Efek peralatan gagal/downgrade terhadap landing minima | OM Part A `Table 8.1-17` | Basis untuk ILS U/S, approach/touchdown-zone lights, RVR assessment |
| Additional fuel & holding fuel | OM Part A `8.1.7.1.2`, `8.4.4.2.2.1`, `8.1.2` | Termasuk **"Additional 30 mins holding fuel is carried"** untuk kondisi TEMPO di alternate |
| Fuel (dispatch manual) | FDM `4.8.3.5.1`, `4.8.4.3` | Additional fuel |
| Fuel (regulasi) | CASR `121.639`, `121.646` | Additional fuel; en-route fuel supply |

**Batas yang terverifikasi:** nilai minima **numerik per-bandara tidak ada** di corpus (tabel menyatu/hilang — konsisten dengan `DESIGN.md` §9). Yang recoverable adalah **aturan** minima berbasis kategori. Karena itu:

- Engine deterministik memakai **rule table** minima (transkripsi bersitasi dari OM `8.1.2` family + `Table 8.1-17`).
- **Nilai** minima per-bandara adalah **input** (manual sekarang, airport chart kemudian).
- Bila nilai minima tidak tersedia → engine **tidak boleh** menyimpulkan kepatuhan → finding `MINIMA_NOT_AVAILABLE` → verdict maksimum `MARGINAL`.

**AIP Australia belum ada di corpus** (corpus = OM/FDM/CASR). Perlu diunggah sebagai dokumen referensi ke-4 sebelum bisa disitir.

---

## 3. Arsitektur

```
Input per flight (dipilih manual dari flight board aktif)
  DOF, STA(Z), diversion, TAF dest/alt (raw), alternates, minima (chart/manual), NOTAM/REMARKS
        │  (untrusted)
        ▼
[1] src/taf.ts            decode TAF → base + change groups (FM/BECMG/INTER/TEMPO/PROB)
        ▼
[2] ETA window            dest = STA ± 1h ; primary alt = STA + diversion ± 1h
        ▼
[3] src/dispatch.ts
    ├─ assessTafWindow    prevailing vs conditional deteriorations DI DALAM window
    ├─ minima             cuaca vs landing minima / alternate planning minima
    ├─ fuel               INTER→30min / TEMPO→60min bila tanpa alternate; 0 bila alternate valid
    └─ NOTAM gate         tanpa NOTAM terverifikasi → tidak boleh GO
        ▼
    verdict GO / NO-GO / MARGINAL  +  findings bersitasi klausa
        ▼
[4] src/explainer.ts (DeepSeek API eksternal) — HANYA menjelaskan + mengutip, tidak mengubah verdict
    └─ data minimisation: kirim findings + ID klausa saja; teks corpus tidak pernah keluar
        ▼
[5] Report 3-section + snapshot contract v3 + audit trail
```

Prinsip yang dipertahankan: payload upstream untrusted (malformed → `NO_DATA`, bukan silent pass); verdict tidak pernah dihasilkan model; `test/report.spec.ts` tetap berlaku (message finding tidak memuat bahasa keputusan).

---

## 4. Fase

| Fase | Lingkup | Status |
|---|---|---|
| F1 | Kontrak data (tipe DOF/STA/diversion/minima/NOTAM) | sebagian — tipe engine selesai, adapter AWQ Cloud menyusul |
| F2a | **`src/taf.ts`** decoder change groups + window assessment | **selesai** |
| F2b | **`src/dispatch.ts`** ETA window + fuel + minima + NOTAM gate + verdict | **selesai** |
| F2c | Test unit `test/taf.spec.ts`, `test/dispatch.spec.ts` | **selesai** |
| F3 | AI explainer (`src/explainer.ts`, DeepSeek eksternal) | **modul + test selesai**; wiring endpoint & secret menunggu |
| F4 | UI input manual NOTAM/REMARKS + minima | menunggu |
| F5 | Adapter + endpoint + contract v3 + laporan (`src/awq.ts`, `src/index.ts`) | **selesai** |
| F6 | UI input manual NOTAM/minima + konfirmasi jadwal (`public/index.html`) | **selesai** |
| F7 | Update `DESIGN.md` §10 | **selesai** |
| F8 | Set secret produksi + deploy | menunggu |

Catatan F3 — `src/explainer.ts` provider-agnostic (endpoint + model = konfigurasi), default
`deepseek-flash`. Verdict tetap milik engine: prompt menyatakan verdict **fixed** dan test
mengunci itu. Data minimisation diuji secara eksplisit — prompt **tidak boleh** memuat
`PT Indonesia AirAsia`, footer manual, atau kata `CONFIDENTIAL`; yang dikirim hanya nomor
klausa seperti `OM Part A 8.1.2`, dan teks kutipan ditampilkan aplikasi dari D1.

Secret: `npx wrangler secret put DEEPSEEK_API_KEY` (produksi) atau `.dev.vars` (lokal,
sudah gitignored). Template tersedia di `.dev.vars.example`.

Catatan F2 — seluruh suite 180 test lulus (100 di antaranya test baru untuk F2/F3/F5). Test menemukan satu
bug parser nyata: grup `PROB40 TEMPO` terpecah menjadi dua karena `TEMPO` juga penanda grup,
sehingga jendela validitasnya menempel pada separuh yang salah. Sudah diperbaiki dan dikunci
oleh test.

Dua perilaku yang **belum** deterministik dan sementara ini bergantung pada penjelasan AI:

- Dampak `ILS U/S` terhadap minima (OM Part A `Table 8.1-17`) — engine hanya mendeteksi
  closure, bukan downgrade peralatan.
- Crosswind/tailwind — runway-in-use bukan bagian dari payload, sehingga komponen angin
  belum bisa dihitung.

## 5. Kontrak payload AWQ Cloud (dari capture 2026-09-21)

`GET /api/assist?mode=flight-board` → `{ ok, data: { flights: [...], fetchedAt } }`

| Field | Bentuk | Catatan |
|---|---|---|
| `id`, `callsign` | number / string | `flightNumber` dan `operator` **selalu null** → label pakai `callsign` |
| `origin`, `destination` | ICAO | |
| `std`, `sta` | **dua bentuk berbeda** | `"23:00"` (tanpa tanggal) **dan** `"2026-09-11T23:05:00.000Z"` |
| `aircraft.type_code` | selalu null | minima per-kategori pesawat belum bisa |
| `destinationAlternates`, `enrouteAlternates` | array ICAO | |

`GET /api/assist?mode=flight-weather&flight_id=` → `{ ok, data: { flightId, taf: [...], route, weatherMonitoring } }`

| Field | Bentuk | Catatan |
|---|---|---|
| `taf[].role` | `Departure` / `Destination` / `Destination alternate` / `Enroute alternate N` | pencocokan harus exact — substring `Destination` akan menangkap `Destination alternate` |
| `taf[].raw` | teks TAF, **multi-baris** (`\n`), diakhiri `=` | |
| `taf[].validity` | `{ label, validFrom, validTo }` ISO absolut | berguna sebagai verifikasi silang |
| `TAF ... NIL=` | enroute alternates | harus dianggap TIDAK usable, bukan TAF kosong |
| `weatherMonitoring.warnings[].impact` | `{ nm, hit, severity }` | `hit:true` = feed sudah menilai menyentuh rute |

### Cacat data dan akar masalahnya (dilacak ke sumber AWQ Cloud)

Akar masalahnya **bukan** sekadar format. `AWQ - CLOUD/shared/wxtime.mjs` mendokumentasikan
(fungsi `flightInstant`, baris 92–107) bahwa **tanggal yang tertanam di `etd`/`eta` bisa basi
sampai berminggu-minggu** — baris produksi nyata membawa `dof=20260917` dengan
`etd='2026-09-08T03:25:00.000Z'` (selisih 9 hari, sampai 17 hari dalam sampel). Modul itu
menyelesaikan instan penerbangan dari kolom `dof` (tanggal terbang yang dikendalikan operator),
bukan dari tanggal tertanam. Capture Anda konsisten: tanggal ISO di sana meleset 10–13 hari dari
`fetchedAt`.

Tiga hal bertemu di endpoint `flight-board` (`functions/api/assist.js` baris 239–263):

1. **`dof` tidak dikirim sama sekali** — padahal kolomnya ada, dan endpoint `flight-weather`
   di file yang sama justru memilihnya (`SELECT ... etd, eta, dof`, baris 285).
2. **`std`/`sta` dikembalikan mentah** (`std: item.etd || null`, baris 256–257), sehingga
   tanggal tertanam yang basi ikut terkirim.
3. **Aturan rollover tidak diterapkan di sini**, padahal `flightLegWindows` di
   `shared/wxtime.mjs` sudah menerapkannya, dan komentarnya (baris 251–254) menyebut aturan itu
   "the same rule the Flight board timeline already applies". Endpoint ini melewatkannya.

Akibatnya konsumen menerima tanggal yang bisa meleset berminggu-minggu, tanpa `dof` untuk
mengoreksinya.

### Penanganan di `src/awq.ts`

Karena `dof` tidak tersedia, adapter **tidak mempercayai tanggal tertanam** dan tidak memakai
aturan "geser satu hari". Ia mengambil **jam** dari nilai yang dikirim (mendukung `HH:MM`,
`HHMM`, dan ISO) lalu menambatkannya ke kemunculan terdekat di sekitar `fetchedAt` board.
Aturan itu menangani kedatangan lintas tengah malam tanpa kasus khusus, dan tahan terhadap
tanggal basi.

**Koreksi tidak pernah diam-diam.** Setiap nilai yang ditambatkan dicatat di `adjustments`
dengan alasan `date-absent` (tidak ada tanggal) atau `date-not-authoritative` (ada tanggal, tapi
bukan tanggal terbang) — menghasilkan finding `SCHEDULE_NEEDS_CONFIRMATION` sehingga verdict
**tidak bisa GO** sampai manusia mengonfirmasi. ETA window tetap dihitung dari nilai tambatan
agar assessment masih berguna sambil menunggu, dan field `assumed` dikembalikan supaya UI bisa
mengisi form konfirmasi tanpa operator mengetik timestamp.

Operator dapat menimpa lewat body request; override menang atas inferensi dan menghapus kebutuhan
konfirmasi:

```
{ flightId, ..., schedule?: { staZ: "2026-09-12T03:00:00.000Z" } }
```

### Perbaikan di sisi AWQ Cloud (diterapkan, belum di-deploy)

Dua perubahan kecil di `functions/api/assist.js`, tanpa mengubah perilaku internal mana pun:

1. `f.dof` ditambahkan ke SELECT board, dan `dof` kini dikirim di payload.
2. Pemetaan baris diekstrak menjadi fungsi murni `boardFlightRow(item)` yang **diekspor**, dan
   mengembalikan `std`/`sta` sebagai instan absolut lewat `flightLegWindows(etd, eta, dof)`
   yang sudah ada. Nilai mentah tetap tersedia sebagai `publishedStd`/`publishedSta`, supaya
   tidak ada informasi yang hilang ketika instant-nya `null`.

`boardFlightRow` sengaja diekspor agar bisa diuji: normalisasi inilah bagian yang selama ini
salah secara senyap, jadi ia dikunci oleh unit test, bukan hanya lewat mock D1.

Test baru `tests/test_assist_board_row.mjs` (7 kasus) mengunci: instant dari `dof`; tanggal
basi tidak menimpa `dof`; kedatangan tidak pernah mendahului keberangkatan; `published*` tetap
utuh; dan jam tanpa `dof` menghasilkan `null` — bukan tebakan.

Suite AWQ Cloud: **158 test lulus** (151 baseline + 7 baru), 0 gagal. Repo itu `type: commonjs`
sementara `functions/` memakai ESM, jadi test memuatnya lewat bundling esbuild + data URL —
pola yang sama dengan `tests/test_wx_time_window.mjs`.

### Jalur presisi di adapter (siap, menunggu deploy)

`resolveSchedule` kini bercabang dua:

- **Path A** — `dof` tersedia: instant dibaca tepat dari `dof` + jam, tidak ada yang
  diinferensi, `needsConfirmation: false`.
- **Path B** — tanpa `dof`: jam ditambatkan ke `fetchedAt` board dan tanggalnya harus
  dikonfirmasi manusia.

Ketika `dof` mulai mengalir setelah AWQ Cloud di-deploy, kebutuhan konfirmasi tanggal hilang
dengan sendirinya — tanpa perubahan kode di sisi dispatch-assist.

### Field yang absen dari payload

Diversion time, minima, angka fuel, dan NOTAM — semuanya **tidak ada**. Diversion memakai
default 60 menit; minima & NOTAM disuplai manual (F4). Engine dapat **menyatakan** kebutuhan
holding fuel, tetapi **tidak bisa membandingkannya** dengan fuel uplift yang nyata.

## 6. Dependensi yang masih terbuka

1. **Deploy perbaikan AWQ Cloud** (`npx wrangler pages deploy` di repo AWQ Cloud) — setelah itu
   `dof` mengalir dan konfirmasi tanggal tidak lagi diperlukan.
2. **Nilai minima** per-bandara — dari chart (rencana Anda) atau input manual.
3. **PDF AIP Australia** — untuk diunggah & di-ingest sebagai dokumen referensi ke-4.
4. ~~Kebijakan advisory rute~~ — **diputuskan**: tetap MARGINAL, butuh penilaian manusia.

## 7. F5 selesai — endpoint & kontrak v3

`POST /api/assessments` kini menerima minima + NOTAM manual, karena tanpa keduanya setiap
assessment secara konstruksi akan berhenti di MARGINAL:

```
{ flightId, minima?: { destination: ApproachMinima, alternate: ApproachMinima }, notamRemarks? }
```

Alurnya: payload board/weather → `src/awq.ts` → `assessDispatch` → `src/explainer.ts` (opsional)
→ snapshot **contract v3** (menyimpan windows, verdict, fuel, findings, `notes` data-quality,
model + `promptHash`) → report 3-section. Snapshot v2 lama tetap harus bisa dibaca.

### Yang berubah di endpoint

- Body: `{ flightId, minima?: { destination, alternate }, notamRemarks?, explain? }`.
- Verdict disimpan di kolom `status`; `decision` tetap `OPEN` sampai direview.
- `explain: false` melewati pemanggilan model. Tanpa `DEEPSEEK_API_KEY`, assessment tetap dibuat
  dan `explanation.reason` mencatat `no-api-key` — kehilangan narasi, bukan keputusan.
- Snapshot **contract v3** menyimpan windows, verdict, fuel, findings, `notes` data-quality,
  model + `promptHash`, dan payload upstream mentah untuk re-check.
- Laporan 3-section dirender untuk v3; **snapshot v2 lama tetap bisa dibaca** (assessment bersifat
  immutable, jadi record lama tidak boleh jadi tidak terbaca).

### Pengecekan yang dipindahkan dari engine lama

`WX_NOT_FRESH` / `WX_FRESHNESS_UNKNOWN` (freshness monitoring) dan `TAF_NOT_CURRENT` /
`TAF_STATUS_UNKNOWN` (currency TAF) kini ada di engine deterministik baru, disuplai adapter dari
`weatherMonitoring.freshness` dan `taf[].status`. Keduanya **opsional**: sinyal yang tidak dikirim
berarti "tidak dicek", bukan "unknown", sehingga tidak memunculkan caution palsu.

### Sisa pekerjaan

1. **Set secret produksi** (`npx wrangler secret put DEEPSEEK_API_KEY`) lalu deploy.
   Tanpa secret ini assessment tetap jalan, hanya tanpa narasi.
2. **Perbaikan di sisi AWQ Cloud** (lihat §5) — memperbaiki di hulu lebih tahan lama.
3. **Airport chart** — untuk mengisi nilai minima tanpa entri manual.
4. **AIP Australia** — perlu diunggah agar aturan AIP bisa disitir.

Pemeriksaan UI dijalankan manual: `npm run ui:check` memverifikasi bahwa setiap
`getElementById` dan `label for` di `public/index.html` menunjuk elemen yang benar-benar
ada. UI satu-file ini tidak punya test lain, dan kesalahan id di sana hanya muncul sebagai
panel mati saat runtime.
