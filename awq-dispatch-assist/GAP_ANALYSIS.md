# Dispatch Analysis — Gap Analysis & Implementation Plan

> Status: review selesai, **belum ada kode yang diubah**.
> Tujuan: memetakan spec evaluasi dispatch (ETA window, TAF change groups, minima/NOTAM, fuel) terhadap implementasi saat ini, lalu menyusun rencana implementasi.

---

## 1. Keputusan yang sudah dikunci (dari konfirmasi)

| Item | Keputusan |
|---|---|
| Mode kerja | Review/gap analysis dulu, implementasi menyusul setelah disetujui |
| Otoritas verdict | **Engine deterministik** yang memutuskan GO / NO-GO / MARGINAL; AI hanya menjelaskan + mengutip klausa |
| Data tersedia dari AWQ Cloud | DOF + STA/ETA (Zulu), TAF raw dengan change groups, approach/landing/alternate minima, fuel + nominated alternates |
| Data **tidak** tersedia | **NOTAM** (tidak dipilih) |

---

## 2. Kondisi saat ini (baseline)

### 2.1 Engine deterministik (`src/findings.ts`)

`evaluateWeather()` adalah satu-satunya otoritas status saat ini, dan cakupannya **hanya cuaca tingkat-tinggi**:

- Membaca `taf[].status` (`Current`/`Expired`) → `TAF_NOT_CURRENT` / `TAF_STATUS_UNKNOWN`.
- Membaca `taf[].coverage` (`Covered`/`Not covered`) → `TAF_WINDOW_NOT_COVERED`.
- Membaca `weatherMonitoring.freshness` dan `warnings[]` (`impact.hit` → `WX_ROUTE_IMPACT`).
- Menghasilkan status `READY | REVIEW_REQUIRED | NO_DATA` + findings `CRITICAL/CAUTION/INFO`.

**Yang tidak dilakukan:** parsing teks TAF, hitung ETA window, baca change groups, cek minima, cek NOTAM, logika fuel, atau verdict GO/NO-GO.

### 2.2 Payload yang diterima

`AssessmentFlight` (dari `/api/assist?mode=flight-board`):

```
id, callsign, flightNumber, origin, destination,
aircraft.registration, destinationAlternates[], enrouteAlternates[]
```

`AssessmentWeather` (dari `/api/assist?mode=flight-weather`):

```ts
taf: Array<{ role, station, status, coverage, raw }>
weatherMonitoring: { freshness, warningCount, fetchedAt, warnings[] }
```

Contoh `taf.raw` (dari fixture test): `TAF WIII 211700Z 2118/2224 27008KT 9999 SCT020`
→ **teks TAF mentah (termasuk change groups) sudah ada di field `raw`, tetapi tidak pernah di-parse.**

### 2.3 Assistant RAG (`src/retrieval.ts`, `src/clause.ts`)

- Hybrid retrieval (lexical D1 + vector Vectorize, fused RRF), hasil berupa **kutipan klausa** (`clauseId`, `clauseScheme`, `excerpt`, `foundBy`).
- **Tidak ada generasi jawaban.** `proxyAssistant()` hanya mengembalikan "Retrieved N excerpts … review the cited clauses". Belum ada LLM text-generation yang terhubung.

### 2.4 Corpus referensi (DESIGN.md §9)

| Dokumen | Scheme | Klausa |
|---|---|---|
| Operations Manual Part A (IAA/FOP/M/001) | `om` | 1,641 |
| Flight Dispatch Manual (IAA/FOP/M/008) | `fdm` | 581 |
| CASR Part 121 (PM 61/2017) | `casr` | 355 |

Catatan penting: **AIP tidak ada di corpus.** Spec Anda menyebut "OM-A / Dispatch manual / Casr / AIP rules" — sumber ke-4 (AIP) belum terindeks.

### 2.5 Batas desain yang mengikat

- `DESIGN.md` §10: "A language model may explain … It must not determine readiness, decide release, or assert airworthiness." → selaras dengan pilihan Anda (engine deterministik putuskan verdict).
- `test/report.spec.ts` mengunci: **message findings tidak boleh mengandung kata** `dispatch/release/depart/go/no-go/safe to/may fly/airworthy`. Verdict GO/NO-GO harus jadi **field terpisah**, bukan kata di dalam message finding.
- `DESIGN.md` §9 Confidentiality: teks corpus `CONFIDENTIAL` (milik PT Indonesia AirAsia). Kirim ke model **harus lewat gateway CIZ-AI internal** (katalog `WX_AI_CATALOG` berisi DeepSeek), bukan provider eksternal.

---

## 3. Matriks gap (spec → baseline → yang kurang)

| # | Elemen spec | Baseline | Gap |
|---|---|---|---|
| 1a | Destination ETA Window = STA ± 1 jam | Tidak ada STA/DOF di `AssessmentFlight`; tidak ada hitung window | Butuh field DOF/STA/diversion + modul time-window |
| 1b | Alternate ETA Window = STA + diversion (± 1 jam), default diversion 1 jam | Tidak ada | Butuh field diversion time (atau default) + modul window |
| 1c | Cocokkan cuaca ke DOF + Zulu | Tidak ada | TAF validity (`2118/2224`) harus di-intersect dengan window Zulu |
| 2a | Terapkan change groups (FM/BECMG/INTER/TEMPO/PROB) dalam window | `raw` ada, **tidak di-parse** | Butuh TAF decoder (change group + waktu validitas) |
| 2b | TAF3 3-hour exemption (AIP Australia) | Tidak ada; corpus = CASR/IAA Indonesia | **Provenance rule belum jelas** — lihat §5.3 |
| 2c | Prevailing vs deterioration (vis, ceiling, TS, FG, crosswind/tailwind) | Tidak ada ekstraksi kondisi | Butuh ekstraksi kondisi dari TAF + pembanding minima |
| 3a | Approach capability + NOTAM/REMARKS (ILS U/S, runway closed) | Tidak ada; **NOTAM tidak tersedia** | Butuh sumber NOTAM/remarks atau input manual — lihat §5.1 |
| 3b | Bandingkan cuaca vs Landing Minima & Alternate Planning Minima | Tidak ada data minima di payload | Butuh surfacing minima + komparator |
| 4a | INTER → 30 min / TEMPO → 60 min holding bila tanpa alternate; 0 min bila alternate valid dinominasikan | Tidak ada | Butuh deteksi INTER/TEMPO dalam window + status alternate + aturan fuel |
| 4b | Advisory fuel padding (shower/traffic holding) | Tidak ada | Butuh rekomendasi padding (advisory, bukan mandatory) |
| 5 | Output 3-section (ETA windows / weather-minima / recommendation+sumber) | Report HTML flat: findings + tabel TAF + daftar dokumen | Butuh render format 3-section + kutipan sumber per verdict |

---

## 4. Gap kontrak data (field yang harus di-surface)

Field spec yang **belum ada** di tipe saat ini (harus diambil dari AWQ Cloud atau ditambahkan):

| Field | Untuk | Status |
|---|---|---|
| `flight.dof` (Date of Flight) | Basis pencocokan Zulu | Konfirmasi: tersedia upstream |
| `flight.sta` (Scheduled Time of Arrival, Zulu) | ETA window | Konfirmasi: tersedia upstream |
| `flight.eta` / diversion time | Alternate window | Konfirmasi: tersedia (fuel/nominated alternates) |
| `taf[].raw` dengan change groups | Sudah ada, belum di-parse | Sudah di payload |
| Approach/landing minima (dest + alternates) | Pembanding cuaca | Konfirmasi: tersedia upstream |
| Alternate planning minima | Pembanding cuaca alternate | Konfirmasi: tersedia upstream |
| Fuel + nominated alternates + diversion | Logika INTER/TEMPO & alternate | Konfirmasi: tersedia upstream |
| **NOTAM / REMARKS** | Approach capability & runway status | **TIDAK tersedia** — gap data |

> Catatan: "tersedia upstream" berarti AWQ Cloud memilikinya, tetapi belum di-surface ke tipe `AssessmentFlight`/`AssessmentWeather` di Worker ini. Perlu konfirmasi nama field aktual dari kontrak API AWQ Cloud sebelum menulis kode.

---

## 5. Risiko & kendala yang harus diselesaikan

### 5.1 NOTAM tidak tersedia → integritas verdict

Spec mensyaratkan "ensure 100% regulatory and safety compliance" dan cek NOTAM (ILS U/S, runway closure). Tanpa NOTAM, **verdict "GO" bersih tidak dapat dipertahankan**. Opsi:

1. **Input manual** NOTAM/REMARKS per flight (form di UI → masuk snapshot).
2. **Sumber NOTAM baru** (integrasi eksternal) — butuh keputusan procurement/compliance.
3. **Degradasi verdict**: bila NOTAM tidak tersedia, engine memaksa `MARGINAL` atau menambahkan kualifikasi "GO subject to NOTAM verification".

Rekomendasi: kombinasi (1) + (3) sebagai default — verdict tidak pernah "GO bersih" tanpa NOTAM terverifikasi.

### 5.2 Minima berbasis tabel → risiko akurasi dari corpus

Minima (landing/alternate planning) umumnya berbentuk tabel. `DESIGN.md` §9 mencatat ekstraksi tabel corpus **buruk** (kolom menyatu, beberapa tabel hilang). Karena itu minima **tidak boleh** diambil dari corpus; harus dari **data terstruktur AWQ Cloud** (yang Anda konfirmasi tersedia). Corpus hanya dipakai untuk mengutip *aturan* (clause), bukan *nilai* minima.

### 5.3 Provenance aturan: AIP Australia vs regulasi Indonesia

Spec mengutip "TAF3 3-hour exemption rules per AIP Australia" dan output "AIP rules". Namun corpus berisi CASR Part 121 (Indonesia) + manual IAA, dan **AIP belum terindeks**. Perlu dikonfirmasi:

- Operator beroperasi di bawah regulasi mana (Indonesia CASR/IAA, Australia, atau keduanya)?
- Apakah aturan ekuivalen TAF3/exemption ada di CASR/IAA (untuk dikutip dari corpus), atau AIP perlu ditambahkan sebagai dokumen referensi ke-4?

### 5.4 Batas deterministik vs AI (harus dipertahankan)

Verdict GO/NO-GO/MARGINAL dihitung **deterministik** dan harus `reproducible` + tertest (seperti `evaluateWeather`). AI (DeepSeek via CIZ-AI) hanya:
- merender laporan 3-section,
- menjelaskan findings,
- mengutip klausa (OM-A/FDM/CASR),
- **tidak mengubah verdict**.

Setiap rekomendasi harus mencatat model, prompt, dan set klausa (audit trail), sesuai `DESIGN.md` §10.

### 5.5 Confidentiality

Teks corpus `CONFIDENTIAL`. Langkah AI wajib memakai gateway CIZ-AI internal (DeepSeek) — **bukan** model provider publik. Ini keputusan compliance, bukan hanya engineering.

---

## 6. Arsitektur yang diusulkan

```
AWQ Cloud (flight-board + flight-weather + fuel/minima)
        │  (payload untrusted)
        ▼
[1] Data contract surfacing  (DOF, STA, ETA, diversion, minima, fuel, alternates, TAF raw)
        ▼
[2] DETERMINISTIC ENGINE  (baru, testable)
    ├─ time-window.ts     : ETA windows (dest ±1h, alt = STA+diversion ±1h), DOF/Zulu matching
    ├─ taf.ts             : decode FM/BECMG/INTER/TEMPO/PROB + validity, intersect window
    ├─ minima.ts          : weather vs landing minima / alternate planning minima
    └─ fuel.ts            : INTER/TEMPO → holding fuel vs alternate, advisory padding
        ▼
    verdict: GO / NO-GO / MARGINAL  +  structured findings (CRITICAL/CAUTION/INFO)
        ▼
[3] AI EXPLAINER  (DeepSeek via CIZ-AI gateway, hanya menjelaskan + mengutip)
        ▼
[4] 3-section report  (ETA windows / weather-minima / recommendation + sumber)
        ▼
    snapshot contract v3 + audit (model, prompt, clause set, verdict)
```

Prinsip yang dipertahankan: payload upstream dianggap untrusted (malformed → `NO_DATA`, bukan silent pass); verdict tidak pernah dihasilkan model.

---

## 7. Rencana implementasi bertahap (belum dieksekusi)

| Fase | Lingkup | Hasil |
|---|---|---|
| **F1 — Data contract** | Surface DOF/STA/ETA/diversion/minima/fuel ke tipe & snapshot; konfirmasi nama field API AWQ Cloud | Tipe + snapshot v3 kosong |
| **F2 — Engine deterministik** | Modul time-window, TAF decoder (change groups), komparator minima, aturan fuel → verdict GO/NO-GO/MARGINAL | `findings.ts` diperluas / modul baru + unit tests |
| **F3 — AI explainer** | Wire DeepSeek via CIZ-AI; prompt = findings + klausa teretrieval; render 3-section; kutipan sumber | Endpoint report 3-section |
| **F4 — NOTAM gap** | Input manual NOTAM/REMARKS + degradasi verdict bila kosong | Gate NOTAM terpenuhi |
| **F5 — Hardening** | Contract version bump (`3`), audit trail model/prompt/clause, update `report.spec.ts`/`findings.spec.ts`, docs | Siap review/dispatch |

Urutan disengaja: F1–F2 murni deterministik & testable (tanpa model), sehingga verdict sudah bisa diverifikasi sebelum AI menyentuh apa pun.

---

## 8. Pertanyaan terbuka (perlu jawaban sebelum/ketika implementasi)

1. **NOTAM**: pakai input manual + degradasi verdict (rekomendasi), atau integrasi sumber NOTAM baru?
2. **Minima**: konfirmasi bahwa AWQ Cloud menyediakan nilai minima terstruktur (landing + alternate planning) per aerodrome/approach — bukan hanya dokumen yang perlu di-parse?
3. **Regulasi**: AIP Australia vs CASR/IAA Indonesia — basis hukum mana yang dipakai, dan apakah AIP perlu ditambahkan sebagai dokumen referensi ke-4?
4. **Nama field aktual** kontrak API AWQ Cloud untuk DOF/STA/ETA/diversion/minima/fuel (agar F1 tidak menebak).
5. **Semantik verdict**: apakah "GO" boleh muncul hanya bila NOTAM terverifikasi (rekomendasi: ya)?
